/** Shipping CLI capture/service composition; inspection is an owned preload, not a feature route. */
import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type TerminalViewRequest,
  createPing,
  decodeTerminalViewFrame,
  encodeTerminalViewFrame,
  serialize,
} from '@remi/shared';
import { until } from '../helpers/browser-link-service-fixture.ts';
import { fileDownloadCliFixture } from '../helpers/file-download-cli-fixture.ts';

test.each(['claude', 'codex'] as const)(
  'actual %s source CLI captures launch output and keeps the terminal service unadvertised',
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
      const requestIds: string[] = [];
      const submit = (request: TerminalViewRequest) => {
        requestIds.push(request.id);
        peer.ws.send(encodeTerminalViewFrame(request));
      };
      const id = randomUUID();
      submit({
        type: 'session_terminal_open',
        id,
        timestamp: new Date().toISOString(),
        sessionId: frame.sessionId,
        binding: {
          harness,
          harnessSessionId: peer.hello().harnessSessionId ?? 'owned-unavailable-binding',
        },
      });
      // #1643 composes the signed service without advertising a caller route.
      // An unresolved harness binding has no authority and leaves chat alive.
      const ping = createPing();
      peer.ws.send(serialize(ping));
      await until(
        () =>
          peer.received.some((message) => message.type === 'pong' && message.pingId === ping.id),
        'actual CLI remains available after optional terminal ingress',
      );
      expect(peer.ws.readyState).toBe(WebSocket.OPEN);
      if (peer.hello().harnessSessionId) {
        await until(
          () =>
            peer.received.some(
              (message) => message.type === 'session_terminal_opened' && message.requestId === id,
            ),
          'actual CLI signed terminal Open',
        );
        const opened = peer.received.find(
          (message) => message.type === 'session_terminal_opened' && message.requestId === id,
        );
        if (opened?.type !== 'session_terminal_opened') throw new Error('Owned CLI view absent');
        const readId = randomUUID();
        submit({
          type: 'session_terminal_read',
          id: readId,
          timestamp: new Date().toISOString(),
          sessionId: frame.sessionId,
          viewId: opened.viewId,
          afterRevision: null,
        });
        await until(
          () =>
            peer.received.some(
              (message) =>
                message.type === 'session_terminal_snapshot' && message.requestId === readId,
            ),
          'actual CLI signed terminal snapshot',
        );
        const snapshot = peer.received.find(
          (message) => message.type === 'session_terminal_snapshot' && message.requestId === readId,
        );
        if (snapshot?.type !== 'session_terminal_snapshot')
          throw new Error('Owned CLI snapshot absent');
        expect(snapshot.lines[0]).toBe(marker);
        const closeId = randomUUID();
        submit({
          type: 'session_terminal_close',
          id: closeId,
          timestamp: new Date().toISOString(),
          sessionId: frame.sessionId,
          viewId: opened.viewId,
        });
        await until(
          () =>
            peer.received.some(
              (message) =>
                message.type === 'session_terminal_closed' && message.requestId === closeId,
            ),
          'actual CLI signed terminal Close',
        );
      } else {
        expect(peer.received.some((message) => message.type.startsWith('session_terminal_'))).toBe(
          false,
        );
      }
      expect(
        peer.received.some(
          (message) => message.type === 'ack' && requestIds.includes(message.ack.messageId),
        ),
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
