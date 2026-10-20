import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('actual source, installed and arbitrary-named compiled commands reexecute the same entry', () => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'remi-command-entry-'));
  const manager = resolve(import.meta.dir, '../../src/cli/daemon-manager.ts');
  const probe = resolve(cwd, 'probe.ts');
  const artifact = resolve(cwd, 'owned-arbitrary-darwin-arm64');
  const installed = resolve(cwd, 'remi');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: cwd,
    REMI_HOME: resolve(cwd, 'state'),
    TMPDIR: tmpdir(),
  };
  try {
    writeFileSync(
      probe,
      [
        `import { resolveRemiCommand } from ${JSON.stringify(manager)};`,
        "if (process.argv[2] === '--child-probe') console.log(JSON.stringify({child:true,entry:process.argv[1],exec:process.execPath}));",
        'else {',
        'const resolved=resolveRemiCommand();',
        "const child=Bun.spawnSync([resolved.command,...resolved.baseArgs,'--child-probe'],{env:process.env,stdout:'pipe',stderr:'pipe'});",
        'console.log(JSON.stringify({resolved,exit:child.exitCode,child:JSON.parse(child.stdout.toString()),stderr:child.stderr.toString()}));',
        '}',
      ].join('\n'),
    );
    const build = Bun.spawnSync(
      [process.execPath, '--no-env-file', 'build', '--compile', probe, `--outfile=${artifact}`],
      { cwd, env, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(build.exitCode).toBe(0);
    copyFileSync(artifact, installed);
    for (const [command, baseArgs, expectedCommand, expectedBase] of [
      [process.execPath, ['--no-env-file', probe], process.execPath, [probe]],
      [artifact, [], artifact, []],
      [installed, [], installed, []],
    ] as const) {
      const result = Bun.spawnSync([command, ...baseArgs], {
        cwd,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      const observed = JSON.parse(result.stdout.toString());
      expect(observed.resolved).toEqual({ command: expectedCommand, baseArgs: expectedBase });
      expect(observed.exit).toBe(0);
      expect(observed.stderr).toBe('');
      expect(observed.child.child).toBe(true);
      expect(observed.child.exec).toBe(expectedCommand);
      expect(observed.child.entry).toBe(
        command === process.execPath ? probe : '/$bunfs/root/owned-arbitrary-darwin-arm64',
      );
    }
    expect(readFileSync(installed)).toEqual(readFileSync(artifact));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15000);
