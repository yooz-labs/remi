/** Actual source CLI children, Worker/Hub and original authorization-lock admission. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHello, createSessionListRequest } from '@remi/shared';
import { SessionRegistryFile } from '../../src/session/session-registry-file';
import { until } from '../helpers/browser-link-service-fixture';
import {
  fileDownloadCliFixture,
  relayFileDownloadCliFixture,
} from '../helpers/file-download-cli-fixture';

type Primary = Awaited<ReturnType<typeof relayFileDownloadCliFixture>>;
type Secondary = Awaited<ReturnType<typeof fileDownloadCliFixture>>;
interface Observation {
  kind: string;
  pid: number;
  holderPid?: number;
  exitCode?: number;
  signal?: string | null;
  absent?: boolean;
  released?: boolean;
  stderrBytes?: number;
  result?: boolean;
  proxy?: boolean;
  entered?: boolean;
  retryable?: boolean;
}
function scripts(directory: string, holdMs: number) {
  fs.writeFileSync(
    join(directory, 'holder.ts'),
    `import * as fs from 'node:fs';
import {withInterprocessFileLock} from ${JSON.stringify(resolve(import.meta.dir, '../../src/storage/interprocess-file-lock.ts'))};
const [file, acquired, go, released] = process.argv.slice(2);
if(!file || !acquired || !go || !released) throw Error('Owned admission inputs absent');
withInterprocessFileLock(file, () => {
  fs.writeFileSync(acquired, String(process.pid), {mode:0o600});
  const end=performance.now()+1000;
  while(!fs.existsSync(go)){if(performance.now()>=end)throw Error('Owned admission delegate absent');Bun.sleepSync(1)}
  Bun.sleepSync(${holdMs});
});
fs.writeFileSync(released, String(process.pid), {mode:0o600});
`,
    { mode: 0o600 },
  );
  const observer = join(directory, 'observer.ts');
  fs.writeFileSync(
    observer,
    `import * as fs from 'node:fs';
import {join} from 'node:path';
import {BrowserLinkSessionHost} from ${JSON.stringify(resolve(import.meta.dir, '../../src/tunnel/browser-link-session-host.ts'))};
import {IdentityStore} from ${JSON.stringify(resolve(import.meta.dir, '../../src/auth/identity-store.ts'))};
const directory=${JSON.stringify(directory)};let count=0;
const record=value=>{if(count++<128)fs.appendFileSync(join(directory,process.pid+'.jsonl'),JSON.stringify({pid:process.pid,...value})+'\\n',{mode:0o600})};
const descriptor=Object.getOwnPropertyDescriptor(BrowserLinkSessionHost.prototype,'waitForConnection');
const original=descriptor.value;let fired=false;
Object.defineProperty(BrowserLinkSessionHost.prototype,'waitForConnection',{...descriptor,value:async function(...args){
  const [id,adapter,identity]=args;const connection=adapter.getDirectConnection(id);
  if(!fired && connection?.structuredChatProxyAuthority){
    fired=true;const prefix=join(directory,String(process.pid));
    const acquired=prefix+'.acquired',go=prefix+'.go',released=prefix+'.released';
    const file=Reflect.get(identity,'authorizedKeysPath');
    const holder=Bun.spawn([process.execPath,'--no-env-file',join(directory,'holder.ts'),file,acquired,go,released],{env:{HOME:directory,TMPDIR:directory,PATH:'/usr/bin:/bin'},stdin:'ignore',stdout:'ignore',stderr:'pipe'});
    record({kind:'holder-started',holderPid:holder.pid});const stderr=new Response(holder.stderr).text();
    void holder.exited.then(async exitCode=>{let absent=false;try{process.kill(holder.pid,0)}catch(error){absent=error.code==='ESRCH'}record({kind:'holder-reaped',holderPid:holder.pid,exitCode,signal:holder.signalCode,absent,released:fs.existsSync(released),stderrBytes:(await stderr).length})});
    const end=performance.now()+1000;
    while(!fs.existsSync(acquired)){if(performance.now()>=end){holder.kill('SIGTERM');throw Error('Owned admission holder not acquired')}Bun.sleepSync(1)}
    if(Number(fs.readFileSync(acquired,'utf8'))!==holder.pid)throw Error('Owned admission holder PID mismatch');
    record({kind:'holder-acquired',holderPid:holder.pid});fs.writeFileSync(go,'delegate',{mode:0o600});
  }
  const result=await Reflect.apply(original,this,args);record({kind:'admission-result',proxy:!!connection?.structuredChatProxyAuthority,result});return result;
}});
const grant=Object.getOwnPropertyDescriptor(IdentityStore.prototype,'withAuthorizationEpochNonblocking');const real=grant.value;
Object.defineProperty(IdentityStore.prototype,'withAuthorizationEpochNonblocking',{...grant,value:function(...args){let entered=false;const callback=args[1];const values=[...args];values[1]=function(...v){entered=true;return Reflect.apply(callback,this,v)};try{return Reflect.apply(real,this,values)}catch(error){record({kind:'grant-error',entered,retryable:error.retryable,name:error.name});throw error}}});
`,
    { mode: 0o600 },
  );
  return observer;
}
function observations(directory: string): Observation[] {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => {
      const text = fs.readFileSync(join(directory, name), 'utf8');
      // A concurrent append is not an observation until its complete line is present.
      if (!text.endsWith('\n')) return [];
      return text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Observation);
    });
}
async function nextResult(
  peer: Awaited<ReturnType<Primary['connect']>>,
  type: 'session_list_response' | 'hello_ack',
) {
  for (let i = 0; i < 32; i++) {
    const message = await peer.next();
    if (message.type === 'error') throw Error(`Owned discovery refused: ${message.code}`);
    if (message.type === type) return message;
  }
  throw Error('Owned discovery response absent');
}
async function actualChildren(
  holdMs: number,
  two: boolean,
  effect: (primary: Primary, expectedIds: string[], directory: string) => Promise<void>,
) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'remi-relay-discovery-'));
  const observer = scripts(directory, holdMs);
  const command = [
    process.execPath,
    '--no-env-file',
    '--preload',
    observer,
    resolve(import.meta.dir, '../../src/entry.ts'),
  ];
  let primary: Primary | undefined;
  let secondary: Secondary | undefined;
  let secondaryProcess: Bun.Subprocess | undefined;
  const failures: unknown[] = [];
  try {
    primary = await relayFileDownloadCliFixture({
      harness: 'claude',
      projectName: 'download-primary',
      command,
    });
    const expectedIds = [primary.sessionId];
    if (two) {
      secondary = await fileDownloadCliFixture({
        harness: 'claude',
        tls: false,
        relay: 'flag',
        projectName: 'download-secondary',
        command: ['/usr/bin/env', `REMI_HOME=${primary.files.home}`, ...command],
        observe: ({ proc }) => {
          secondaryProcess = proc;
        },
      });
      const sourceRegistry = new SessionRegistryFile(join(primary.files.home, 'live-sessions'));
      await until(
        () => sourceRegistry.listLive().some((entry) => entry.pid === secondary?.proc.pid),
        'actual second source child registration',
        10000,
      );
      const entry = sourceRegistry.listLive().find((item) => item.pid === secondary?.proc.pid);
      if (!entry || entry.wsPort !== secondary.port) throw Error('Owned second child missing');
      primary.liveRegistry.register(entry); // Copy the actual source row, not synthetic metadata.
      expectedIds.push(entry.sessionId);
    }
    await effect(primary, expectedIds, directory);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await until(
        () => {
          const rows = observations(directory);
          return (
            rows.filter((row) => row.kind === 'holder-started').length ===
            rows.filter((row) => row.kind === 'holder-reaped').length
          );
        },
        'actual admission holders reaped',
        4000,
      );
      const holders = observations(directory).filter((row) => row.kind === 'holder-reaped');
      for (const holder of holders)
        expect(holder).toMatchObject({
          exitCode: 0,
          signal: null,
          absent: true,
          released: true,
          stderrBytes: 0,
        });
      console.info('Owned relay admission holder receipts', JSON.stringify(holders));
    } catch (error) {
      failures.push(error);
    }
    try {
      const receipt = await secondary?.close();
      if (receipt) {
        expect(receipt.consumerReaped && receipt.daemonReaped && receipt.stdinMeasured).toBe(true);
        expect(receipt.stdin.byteLength).toBe(0);
      }
    } catch (error) {
      failures.push(error);
    }
    // A live secondary still owns the primary's shared remi home.
    if (secondaryProcess?.exitCode === null)
      failures.push(new Error('Owned secondary remains; preserving shared home'));
    else
      try {
        const receipt = await primary?.close();
        if (receipt) {
          expect(receipt.consumerReaped && receipt.daemonReaped && receipt.stdinMeasured).toBe(
            true,
          );
          expect(receipt.stdin.byteLength).toBe(0);
        }
      } catch (error) {
        failures.push(error);
      }
    if (!failures.length) fs.rmSync(directory, { recursive: true, force: true });
    else console.error('Owned discovery evidence retained', directory);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Owned relay discovery failed');
}

test('actual two source CLI children remain discoverable across real20ms original-authority writers', async () => {
  await actualChildren(20, true, async (f, expectedIds, directory) => {
    const peer = await f.connect();
    const request = createSessionListRequest(false);
    await peer.send(request);
    const list = await nextResult(peer, 'session_list_response');
    expect(list.type).toBe('session_list_response');
    if (list.type !== 'session_list_response') throw Error('Owned actual child list absent');
    expect(list.requestId).toBe(request.id);
    expect(list.sessions.map((row) => row.sessionId).sort()).toEqual(expectedIds.sort());
    expect(list.daemonPorts).toBeUndefined();
    for (const id of expectedIds) {
      await peer.send(createHello('owned-discovery', 'T4', { resumeSessionId: id }));
      const hello = await nextResult(peer, 'hello_ack');
      expect(hello.type).toBe('hello_ack');
      if (hello.type !== 'hello_ack') throw Error('Owned scoped actual child hello absent');
      expect(hello.sessionId).toBe(id);
      expect(hello.attachState).toBe('attached');
      expect(hello.capabilities).toContain('file_download');
    }
    const rows = observations(directory);
    expect(rows.filter((row) => row.kind === 'holder-acquired')).toHaveLength(2);
    expect(rows.some((row) => row.kind === 'grant-error' && !row.entered && row.retryable)).toBe(
      true,
    );
    const admissions = rows.filter((row) => row.kind === 'admission-result');
    console.info('Owned actual admission results', JSON.stringify(admissions));
    expect(admissions.filter((row) => row.proxy === true && row.result)).toHaveLength(2);
  });
}, 30000);

test('a real persistent admission writer retires the relay and a new explicit channel can recover', async () => {
  await actualChildren(2600, false, async (f, _expectedIds, directory) => {
    const peer = await f.connect();
    await peer.send(createSessionListRequest(false));
    await until(() => peer.socket.isClosed, 'persistent writer retired actual machine channel');
    await until(
      () => observations(directory).some((row) => row.kind === 'holder-reaped'),
      'persistent original writer released and reaped',
      4000,
    );
    const rows = observations(directory);
    expect(rows.some((row) => row.kind === 'admission-result' && row.result === false)).toBe(true);
    expect(rows.some((row) => row.kind === 'grant-error' && !row.entered && row.retryable)).toBe(
      true,
    );
    expect(peer.socket.isClosed).toBe(true);
    const fresh = await f.connect();
    await fresh.send(createHello('owned-fresh', 'T4', { resumeSessionId: f.sessionId }));
    const hello = await nextResult(fresh, 'hello_ack');
    expect(hello.type).toBe('hello_ack');
    expect(hello.type === 'hello_ack' && hello.capabilities).toContain('file_download');
  });
}, 15000);
