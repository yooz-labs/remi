/** Actual shipping CLI, signed TLS, strict WebSocketClient and pull controller. No provider. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileDownloadCliFixture } from '../../../daemon/tests/helpers/file-download-cli-fixture.ts';

for (const harness of ['claude', 'codex'] as const) {
  test(`actual ${harness} CLI controller verifies byte boundaries, explicit cancel and context loss`, async () => {
    const f = await fileDownloadCliFixture({ harness });
    let child: Bun.Subprocess | undefined;
    try {
      const cases = [1, 32768, 10485760].map((size, index) => {
        const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 13 + index) % 251);
        const path = `boundary-${size}.bin`;
        f.write(path, bytes);
        return { path, size, digest: createHash('sha256').update(bytes).digest('hex') };
      });
      const input = join(f.files.directory, 'web-download-input.json');
      fs.writeFileSync(
        input,
        JSON.stringify({ identity: f.identity, url: f.url, harness, cases }),
        { mode: 0o600 },
      );
      const root = resolve(import.meta.dir, '../../../..');
      const script = join(f.files.directory, 'web-download-controller.ts');
      fs.writeFileSync(
        script,
        `
import {createAuthResponse,createHello,fromBase64,sign,unlockIdentity} from ${JSON.stringify(join(root, 'packages/shared/src/index.ts'))};
import {WebSocketClient} from ${JSON.stringify(join(root, 'packages/web/src/lib/websocket-client.ts'))};
import {FileDownloadController} from ${JSON.stringify(join(root, 'packages/web/src/lib/file-download.ts'))};
import {createHash} from 'node:crypto';
const input=await Bun.file(process.argv[2]).json(),identity=await unlockIdentity(input.identity);
let assertions=0;const assert=(ok,label)=>{assertions++;if(!ok)throw Error(label)};
const until=async(fn,label)=>{const end=performance.now()+20000;while(!fn()){if(performance.now()>end)throw Error(label+': '+JSON.stringify(controller.state));await Bun.sleep(5)}};
let authenticated=false,hello=null,attachment=null,generic=0,received=0;
const sent=[];const actualFrames=[];
const client=new WebSocketClient({url:input.url,autoReconnect:false,heartbeatInterval:0},{
onStatusChange:s=>{if(s==='disconnected'||s==='reconnecting'){authenticated=false;attachment=null;controller.disconnect()}},
onMessage:async m=>{
 if(m.type.startsWith('file_fetch_'))generic++;
 if(m.type==='auth_challenge')client.send(createAuthResponse(identity.publicKeyRaw,await sign(identity.privateKey,fromBase64(m.challenge)),identity.fingerprint));
 if(m.type==='auth_result'&&m.success){authenticated=true;client.setConnected();client.send(createHello(crypto.randomUUID(),'owned-download-controller'));}
 if(m.type==='hello_ack'&&m.sessionId){controller.disconnect();hello=m;attachment=m.attachState==='attached'?{}:null;}
},onFileDownloadMessage:raw=>{actualFrames.push(raw);received++;controller.receive(raw)}});
const controller=new FileDownloadController({
 context:()=>{const generation=client.imageUploadGeneration;return authenticated&&hello&&generation&&attachment?{
 connection:client,generation,attachment,identityRevision:0,identityKey:identity.publicKeyRaw,authenticated:true,
 webSocketUrl:input.url,sessionId:hello.sessionId,binding:{harness:hello.harness,harnessSessionId:hello.harnessSessionId??hello.claudeSessionId},
 protocolVersion:hello.protocolVersion,capabilities:hello.capabilities}:null},
 send:(r,g)=>{sent.push(r);return client.sendFileDownload(r,g)}
},()=>{});
try{
 client.connect();await until(()=>controller.canDownload,'actual own scoped hello');
 assert(hello.harness===input.harness,'actual known harness');assert(sent.length===0,'no automatic download');
 assert(client.sendFileDownload({type:'file_fetch_begin',id:crypto.randomUUID(),timestamp:new Date().toISOString(),sessionId:hello.sessionId,binding:{harness:hello.harness,harnessSessionId:hello.harnessSessionId??hello.claudeSessionId},relativePath:input.cases[0].path},{})===false,'wrong socket generation refused');
 for(const value of input.cases){
  const before=sent.length;controller.start(value.path);await until(()=>controller.state.phase==='ready','verified '+value.size);
  const copy=controller.copyVerifiedFile();assert(copy&&copy.bytes.length===value.size,'exact length');
  assert(createHash('sha256').update(copy.bytes).digest('hex')===value.digest,'actual digest');
  assert(copy.fileName===value.path,'exact basename');assert(controller.state.hostCleanup==='complete','confirmed host cleanup');
  const requests=sent.slice(before);const reads=requests.filter(r=>r.type==='file_fetch_read');
  assert(reads.length===Math.ceil(value.size/32768),'one pull per bounded chunk');
  assert(reads.every((r,i)=>r.seq===i&&r.receivedBytes===i*32768),'exact sequence/cumulative bytes');
  if(value.size===10485760)assert(reads.at(-1).seq===319,'actual sequence319');
  copy.bytes.fill(0);const second=controller.copyVerifiedFile();assert(createHash('sha256').update(second.bytes).digest('hex')===value.digest,'private verified buffer');
  controller.cancel();assert(controller.state.phase==='cancelled','explicit discard');controller.dismiss();
 }
 controller.start('boundary-10485760.bin');controller.cancel();await until(()=>controller.state.phase==='cancelled','preparation cancel');
 assert(controller.copyVerifiedFile()===null,'cancel discards bytes');assert(controller.state.hostCleanup==='complete','cancel result actual cleanup');controller.dismiss();
 controller.start('.private');await until(()=>controller.state.phase==='failed','denied path');assert(controller.copyVerifiedFile()===null,'refusal has no bytes');controller.dismiss();
 controller.start('boundary-32768.bin');await until(()=>controller.state.phase==='ready','context-loss ready');
 const before=sent.length;attachment=null;controller.contextChanged();assert(controller.copyVerifiedFile()===null,'observed attachment loss discards verified bytes');
 assert(controller.state.phase==='failed','context loss visible');await Bun.sleep(25);assert(sent.length===before,'no automatic replay');
 assert(generic===0,'no generic file response');assert(received>320,'actual raw responses observed');
 console.log(JSON.stringify({passed:true,harness:input.harness,assertions,actualResponses:received,requests:sent.length,maxBytes:10485760}));
}finally{controller.dispose();client.disconnect();}
`,
      );
      const running = Bun.spawn(
        [
          process.execPath,
          '--no-env-file',
          '--tsconfig-override',
          join(root, 'packages/web/tsconfig.app.json'),
          script,
          input,
        ],
        {
          cwd: f.files.work,
          env: { ...f.files.env, NODE_EXTRA_CA_CERTS: join(f.files.certs, 'ca.pem') },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      child = running;
      const [code, out, err] = await Promise.all([
        running.exited,
        new Response(running.stdout).text(),
        new Response(running.stderr).text(),
      ]);
      expect(code, err).toBe(0);
      expect(JSON.parse(out)).toMatchObject({ passed: true, harness, maxBytes: 10485760 });
      console.log('Actual CLI download-controller receipt', out.trim());
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await f.close();
    }
  }, 120000);
}
