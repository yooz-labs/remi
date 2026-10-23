/** Shipping CLI composition and signed WSS refusal; inspection is an owned preload, not a feature route. */
import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeTerminalViewFrame, encodeTerminalViewFrame } from '@remi/shared';
import { until } from '../helpers/browser-link-service-fixture.ts';
import { fileDownloadCliFixture } from '../helpers/file-download-cli-fixture.ts';

test.each(['claude', 'codex'] as const)(
  'actual %s source CLI captures launch output and keeps terminal transport unavailable',
  async (harness) => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'remi-capture-cli-observer-'));
    const preload = join(directory, 'observe.ts');
    const receipt = join(directory, 'frame');
    const retired = join(directory, 'retired');
    const marker = `capture-${randomBytes(8).toString('hex')}`;
    fs.writeFileSync(
      preload,
      `import * as fs from 'node:fs';
import {TerminalCaptureHost} from ${JSON.stringify(resolve(import.meta.dir, '../../src/terminal/capture-host.ts'))};
import {encodeTerminalViewFrame} from ${JSON.stringify(resolve(import.meta.dir, '../../../shared/src/terminal-view.ts'))};
const original=TerminalCaptureHost.prototype.prepare;
const retire=TerminalCaptureHost.prototype.retireSession;
TerminalCaptureHost.prototype.prepare=async function(...args){
 const result=await Reflect.apply(original,this,args);
 if(result){const id=args[0];const timer=setInterval(()=>{
  const frame=this.contextFor(id)?.borrow();if(!frame)return;
  try{if(frame.snapshot.lines[0]!==${JSON.stringify(marker)})return;
   const wire=encodeTerminalViewFrame({type:'session_terminal_snapshot',id:crypto.randomUUID(),timestamp:new Date().toISOString(),sessionId:id,requestId:crypto.randomUUID(),viewId:'AAAAAAAAAAAAAAAAAAAAAA',revision:frame.revision,...frame.snapshot});
   fs.writeFileSync(${JSON.stringify(`${receipt}.next`)},wire,{mode:0o600});fs.renameSync(${JSON.stringify(`${receipt}.next`)},${JSON.stringify(receipt)});clearInterval(timer);
  }finally{frame.release()}
 },5);timer.unref()}
 return result;
};
TerminalCaptureHost.prototype.retireSession=function(id){Reflect.apply(retire,this,[id]);fs.writeFileSync(${JSON.stringify(retired)},JSON.stringify({id,unavailable:this.contextFor(id)===null}),{mode:0o600})};
`,
      { mode: 0o600 },
    );
    let f: Awaited<ReturnType<typeof fileDownloadCliFixture>> | undefined;
    const failures: unknown[] = [];
    try {
      f = await fileDownloadCliFixture({
        harness,
        consumerOutput: `\x1b[2J\x1b[H${marker}\x1b[6n`,
        command: [
          process.execPath,
          '--no-env-file',
          '--preload',
          preload,
          resolve(import.meta.dir, '../../src/entry.ts'),
        ],
      });
      await until(() => fs.existsSync(receipt), 'actual CLI launch capture receipt');
      const frame = decodeTerminalViewFrame(fs.readFileSync(receipt, 'utf8'));
      expect(frame?.type).toBe('session_terminal_snapshot');
      if (frame?.type !== 'session_terminal_snapshot')
        throw new Error('Owned strict capture frame absent');
      expect(frame.lines[0]).toBe(marker);
      expect([frame.columns, frame.rows]).toEqual([120, 40]);
      expect(frame.cursor).toEqual({ row: 0, column: marker.length });
      const peer = await f.peer();
      expect(peer.hello().sessionId).toBe(frame.sessionId);
      expect(peer.hello().capabilities).not.toContain('terminal_view');
      const id = randomUUID();
      peer.ws.send(
        encodeTerminalViewFrame({
          type: 'session_terminal_open',
          id,
          timestamp: new Date().toISOString(),
          sessionId: frame.sessionId,
          binding: {
            harness,
            harnessSessionId: peer.hello().harnessSessionId ?? 'owned-unavailable-binding',
          },
        }),
      );
      await until(
        () => peer.ws.readyState === WebSocket.CLOSED,
        'actual CLI pre-activation refusal',
      );
      expect(peer.received.some((message) => message.type.startsWith('session_terminal_'))).toBe(
        false,
      );
      expect(
        peer.received.some((message) => message.type === 'ack' && message.ack.messageId === id),
      ).toBe(false);
    } catch (error) {
      failures.push(error);
    }
    try {
      const closed = await f?.close();
      if (closed) {
        expect(closed.consumerReaped && closed.daemonReaped && closed.stdinMeasured).toBe(true);
        expect(closed.stdin.byteLength).toBe(0);
        const result = JSON.parse(fs.readFileSync(retired, 'utf8')) as { unavailable: boolean };
        expect(result.unavailable).toBe(true);
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      console.error('Owned source CLI capture evidence retained', directory);
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'Owned CLI capture composition failed');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  },
  30000,
);
