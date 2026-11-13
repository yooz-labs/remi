/** Actual launcher and owned child process; receipts are booleans, never credential values. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIdentity } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { NotificationDeviceStore } from '../../src/remote/notification-device-store.ts';

for (const secure of [false, true]) {
  test(`spawned session provider credential follows legacy eligibility: secure=${secure}`, async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'remi-push-child-env-')));
    const directory = join(home, 'state');
    mkdirSync(directory, { mode: 0o700 });
    const release = join(home, 'release');
    const manager = resolve(import.meta.dir, '../../src/cli/daemon-manager.ts');
    const registry = resolve(import.meta.dir, '../../src/session/session-registry-file.ts');
    const probe = join(home, 'probe.ts');
    if (secure) {
      const trust = new IdentityStore(directory);
      const device = await createIdentity();
      await trust.addAuthorizedKey(device.publicKey, 'owned secure recipient');
      const epoch = trust.captureAuthorizationEpoch(device.publicKey);
      if (!epoch) throw new Error('OWNED_GRANT_MISSING');
      await new NotificationDeviceStore(directory, trust).add(
        device.publicKey,
        epoch,
        'owned notifications',
      );
    }
    writeFileSync(
      probe,
      [
        `import { spawnRemiDaemon } from ${JSON.stringify(manager)};`,
        `import { SessionRegistryFile } from ${JSON.stringify(registry)};`,
        "import { existsSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const home=process.env.HOME, state=process.env.REMI_HOME;',
        "if(process.argv.includes('--daemon')) {",
        "const port=Number(process.argv[process.argv.indexOf('--port')+1]);",
        "const server=Bun.serve({hostname:'127.0.0.1',port,fetch:()=>new Response('owned')});",
        "new SessionRegistryFile(join(state,'live-sessions')).register({sessionId:crypto.randomUUID(),pid:process.pid,wsPort:port,hookPort:0,projectPath:home,name:'owned process',startedAt:new Date().toISOString()});",
        "writeFileSync(join(home,'receipt.json'),JSON.stringify({hasProviderCredential:!!process.env.REMI_PUSH_SECRET}));",
        "const timer=setInterval(()=>{if(existsSync(join(home,'release'))){clearInterval(timer);server.stop(true);process.exit(0);}},20);",
        'setTimeout(()=>process.exit(1),15000);',
        '} else {',
        "const reserved=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')});",
        'const port=reserved.port;await reserved.stop(true);',
        'const started=await spawnRemiDaemon(port,home);',
        "writeFileSync(join(home,'release'),'');",
        'const end=Date.now()+3000;for(;;){let alive=true;try{process.kill(started.pid,0);}catch{alive=false;}if(!alive)break;if(Date.now()>end)throw new Error("OWNED_CHILD_EXIT_DEADLINE");await Bun.sleep(20);}',
        '}',
      ].join('\n'),
    );
    const child = Bun.spawn([process.execPath, '--no-env-file', probe], {
      cwd: home,
      env: {
        HOME: home,
        REMI_HOME: directory,
        TMPDIR: tmpdir(),
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        REMI_PUSH_SECRET: 'OWNED_PROVIDER_CREDENTIAL',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('OWNED_LAUNCHER_DEADLINE')), 20000);
        }),
      ]);
      expect(result).toBe(0);
      expect(JSON.parse(readFileSync(join(home, 'receipt.json'), 'utf8'))).toEqual({
        hasProviderCredential: !secure,
      });
    } finally {
      clearTimeout(deadline);
      writeFileSync(release, '');
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await child.exited;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
}
