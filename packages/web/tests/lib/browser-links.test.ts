/** Actual signed TLS/WebSocketClient/controller/C1/C2 controls in an owned CA child process. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createIdentity } from '@remi/shared';
import { browserFixture } from '../../../daemon/tests/helpers/browser-link-service-fixture.ts';

const natural = process.env['REMI_BROWSER_EXPIRY_TEST'] === '1';
async function exercise(expiry = false) {
  const f = await browserFixture();
  let child: Bun.Subprocess | undefined;
  try {
    const identity = await createIdentity();
    await f.trust.addAuthorizedKey(identity.publicKey, 'owned browser controller');
    const input = join(f.files.directory, 'controller-input.json');
    fs.writeFileSync(
      input,
      JSON.stringify({
        identity,
        url: `wss://127.0.0.1:${f.port}/ws`,
        sessionId: f.sessionId,
        bindingId: f.context().binding.harnessSessionId,
        browserPath: f.producer.browserPath,
        expiry,
      }),
      { mode: 0o600 },
    );
    const script = join(f.files.directory, 'controller.ts');
    const root = resolve(import.meta.dir, '../../../..');
    fs.writeFileSync(
      script,
      `
import {createAuthResponse,createHello,fromBase64,sign,unlockIdentity} from ${JSON.stringify(join(root, 'packages/shared/src/index.ts'))};
import {WebSocketClient} from ${JSON.stringify(join(root, 'packages/web/src/lib/websocket-client.ts'))};
import {BrowserLinkController} from ${JSON.stringify(join(root, 'packages/web/src/lib/browser-links.ts'))};
import {getIdentityRevision} from ${JSON.stringify(join(root, 'packages/web/src/lib/identity-client.ts'))};
const input=await Bun.file(process.argv[2]).json();const identity=await unlockIdentity(input.identity);
let assertions=0;const assert=(ok,label)=>{assertions++;if(!ok)throw Error(label)};const until=async(fn,label)=>{const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw Error(label);await Bun.sleep(5)}};
let authenticated=false,hello=null, genericBrowser=0;const sent=[];
const client=new WebSocketClient({url:input.url,autoReconnect:false,heartbeatInterval:0},{onMessage:async m=>{
 if(m.type.startsWith('browser_link_'))genericBrowser++;
 if(m.type==='auth_challenge')client.send(createAuthResponse(identity.publicKeyRaw,await sign(identity.privateKey,fromBase64(m.challenge)),identity.fingerprint));
 if(m.type==='auth_result'&&m.success){authenticated=true;client.setConnected();client.send(createHello(crypto.randomUUID(),'controller'));}
},onBrowserLinkMessage:m=>controller.receive(m)});
const connection=client;let bindingId=input.bindingId;
const controller=new BrowserLinkController({context:()=>{const generation=client.imageUploadGeneration;return authenticated&&generation?{connection,generation,identityRevision:getIdentityRevision(),identityKey:identity.publicKeyRaw,sessionId:input.sessionId,bindingId}:null},send:(r,g)=>{sent.push(r);return client.sendBrowserLink(r,g)}},()=>{});
try{
 client.connect();await until(()=>client.isConnected,'actual signed TLS');await Bun.sleep(20);assert(sent.length===0,'mount sends no selection');
 controller.receiveHere();await until(()=>controller.state.phase==='receiving','selection');assert(sent[0].seq===1,'first sequence');
 const invoke=async(url)=>{const p=Bun.spawn([input.browserPath,url],{env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR},stdout:'pipe',stderr:'pipe'});assert(await p.exited===0,'actual launcher');assert((await new Response(p.stderr).text())==='','accepted producer');};
 for(let i=0;i<9;i++){await invoke('https://example.test/browser/'+i);await until(()=>controller.state.candidates.some(c=>c.url.endsWith('/'+i)),'candidate');}
 assert(controller.state.candidates.length===8,'eight bound');assert(!controller.state.candidates.some(c=>c.url.endsWith('/0')),'oldest removed');assert(genericBrowser===0,'no generic browser path');
 if(input.expiry){const started=performance.now();await Bun.sleep(120050);assert(performance.now()-started>=120000,'natural elapsed');assert(controller.state.candidates.length===0,'natural expiry');assert(controller.state.phase==='expired','expiry state');}
 controller.stop();await until(()=>controller.state.phase==='ready','release');assert(controller.state.candidates.length===0,'stop clears');assert(sent[1].seq===2,'release sequence');
 controller.receiveHere();await until(()=>controller.state.phase==='receiving','new explicit selection');assert(sent[2].seq===3,'new explicit sequence');
 const old=client.imageUploadGeneration;client.disconnect();controller.disconnect();assert(controller.state.candidates.length===0,'disconnect clears');assert(controller.state.phase==='unavailable','disconnect unavailable');
 client.connect();await until(()=>client.isConnected,'reconnected signed TLS');assert(client.imageUploadGeneration!==old,'actual new socket generation');await Bun.sleep(20);assert(sent.length===3,'no automatic reselection');controller.receiveHere();await until(()=>controller.state.phase==='receiving','explicit new generation');assert(sent[3].seq===1,'new socket resets');
 console.log(JSON.stringify({passed:true,assertions,naturalExpiry:input.expiry}));
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
    expect(JSON.parse(out)).toMatchObject({ passed: true, naturalExpiry: expiry });
    console.log('Owned controller child receipt', out.trim());
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await f.close();
  }
}
test(
  'real signed controller explicit select/release, eight bound, raw bypass and reconnect generation',
  () => exercise(),
  15000,
);
(natural ? test : test.skip)(
  'real monotonic 120-second browser expiry without fake clock',
  () => exercise(true),
  140000,
);
