// #1440/#1170 actual owned filesystem and killed-process controls, no production caller.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DirectoryRoot } from './admission';
import { RecoveryError, RecoveryIntent, type RecoveryStage } from './recovery';
import { recoveryNative } from './recovery-native';
import { Reservations } from './reservations';

const executable = () =>
  Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, '--no-env-file', Bun.main];
const owner = () => ({
  device: randomBytes(32).toString('hex'),
  session: randomUUID(),
  hub: randomBytes(16).toString('hex'),
});
const stages: RecoveryStage[] = [
  'pre-create',
  'post-create',
  'post-witness',
  'post-unlink',
  'post-cleaned',
];
function refused(action: () => unknown, label: string, code = 'unavailable') {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof RecoveryError && caught.code === code, label);
}

export async function recoveryChild(home: string, id: string, stage: string) {
  const native = await recoveryNative();
  const scratch = DirectoryRoot.capture(
    path.join(home, 'scratch'),
    native.ops.openAt.bind(native.ops),
  );
  const metadata = DirectoryRoot.capture(
    path.join(home, 'metadata'),
    native.ops.openAt.bind(native.ops),
  );
  assert(scratch && metadata, 'owned recovery child captured roots');
  let intent: RecoveryIntent | undefined;
  try {
    if (stage === 'contender') {
      const started = performance.now();
      refused(
        () => {
          intent = RecoveryIntent.open(scratch, metadata, id, native.ops);
        },
        'real contender busy',
        'busy',
      );
      assert(performance.now() - started < 1000, 'real contender is nonblocking');
      console.log(JSON.stringify({ busy: true, elapsedMs: performance.now() - started }));
      return;
    }
    if (stage === 'recover') {
      intent = RecoveryIntent.open(scratch, metadata, id, native.ops);
      console.log(JSON.stringify({ outcome: intent.cleanup() }));
      return;
    }
    assert(stages.includes(stage as RecoveryStage), 'owned recovery child stage');
    intent = RecoveryIntent.open(scratch, metadata, id, native.ops, true);
    const checkpoint = (current: RecoveryStage) => {
      if (current !== stage) return;
      fs.writeSync(1, `${JSON.stringify({ checkpoint: current, pid: process.pid })}\n`);
      // Parent must observe this exact checkpoint and SIGKILL; bounded wait is never success.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
      throw new Error('owned crash checkpoint expired');
    };
    const fd = intent.createArtifact(checkpoint);
    try {
      fs.writeSync(fd, 'owned recovery bytes');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    intent.cleanup(checkpoint);
    assert.fail('owned crash stage was not reached');
  } finally {
    intent?.close();
    metadata.close();
    scratch.close();
    native.close();
  }
}

export async function recoveryProbe() {
  const native = await recoveryNative();
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-recovery-')));
  fs.chmodSync(temporary, 0o700);
  const checks: string[] = [];
  const faults: { operation: string; result: number; category: string }[] = [];
  const children: {
    pid: number;
    exit: number;
    signal: string | null;
    stdoutBytes: number;
    stderrBytes: number;
    reaped: boolean;
    awaitedExit: boolean;
    missingAfterExit: boolean;
  }[] = [];
  let sequence = 0;
  function fixture() {
    const home = path.join(temporary, String(sequence++));
    fs.mkdirSync(home, { mode: 0o700 });
    for (const item of ['scratch', 'metadata', 'project', 'sibling'])
      fs.mkdirSync(path.join(home, item), { mode: 0o700 });
    for (const item of ['project', 'sibling'])
      fs.writeFileSync(path.join(home, item, 'marker'), `untouched-${item}`, { mode: 0o600 });
    const store = Reservations.create(path.join(home, 'ledger'));
    const id = store.reserve(owner(), 1);
    const scratch = DirectoryRoot.capture(
      path.join(home, 'scratch'),
      native.ops.openAt.bind(native.ops),
    );
    const metadata = DirectoryRoot.capture(
      path.join(home, 'metadata'),
      native.ops.openAt.bind(native.ops),
    );
    assert(scratch && metadata, 'owned recovery captured roots');
    return {
      home,
      store,
      id,
      scratch,
      metadata,
      file(kind: string) {
        return path.join(home, kind === 'artifact' ? 'scratch' : 'metadata', `${id}.${kind}`);
      },
      open(create = false) {
        return RecoveryIntent.open(scratch, metadata, id, native.ops, create);
      },
      charge() {
        assert.equal(store.inspect()[0]?.id, id, 'recovery retains same reservation');
        assert.equal(store.inspect()[0]?.charge, 4096, 'recovery does not refund quota');
      },
      close() {
        for (const item of ['project', 'sibling'])
          assert.equal(
            fs.readFileSync(path.join(home, item, 'marker'), 'utf8'),
            `untouched-${item}`,
            'project sibling marker untouched',
          );
        scratch.close();
        metadata.close();
        fs.rmSync(home, { recursive: true });
      },
    };
  }
  function initialized(f: ReturnType<typeof fixture>, clean = false) {
    const intent = f.open(true);
    try {
      const fd = intent.createArtifact();
      fs.writeSync(fd, 'owned recovery bytes');
      fs.closeSync(fd);
      if (clean) intent.cleanup();
    } finally {
      intent.close();
    }
  }
  async function launch(
    f: ReturnType<typeof fixture>,
    stage: string,
    kill = false,
    contention?: () => Promise<void>,
  ) {
    const proc = Bun.spawn(
      [...executable(), '--owned-spike', '--recovery-child', f.home, f.id, stage],
      {
        env: { PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: os.tmpdir() },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const reader = proc.stdout.getReader();
    let output = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let awaitedExit = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killed = false;
    const stderr = (async () => {
      const errorReader = proc.stderr.getReader();
      let detail = '';
      try {
        while (true) {
          const chunk = await errorReader.read();
          if (chunk.done) break;
          stderrBytes += chunk.value.byteLength;
          if (stderrBytes > 8192) {
            proc.kill('SIGKILL');
            throw new Error('owned recovery stderr overflow');
          }
          detail += Buffer.from(chunk.value).toString();
        }
        return { detail, error: null };
      } catch (error) {
        return { detail, error };
      } finally {
        await errorReader.cancel();
        errorReader.releaseLock();
      }
    })();
    const read = async () => {
      const chunk = await reader.read();
      if (!chunk.done) {
        stdoutBytes += chunk.value.byteLength;
        if (stdoutBytes > 4096) {
          proc.kill('SIGKILL');
          throw new Error('owned recovery stdout overflow');
        }
        output += Buffer.from(chunk.value).toString();
      }
      return chunk.done;
    };
    const work = (async () => {
      if (kill) {
        while (!output.includes('\n'))
          assert(!(await read()), 'crash child startup produced checkpoint');
        const checkpoint = JSON.parse(output.trim());
        assert.equal(checkpoint.checkpoint, stage, 'actual crash checkpoint matches');
        assert.equal(checkpoint.pid, proc.pid, 'actual crash checkpoint pid');
        await contention?.();
        proc.kill('SIGKILL');
        killed = true;
      }
      while (!(await read())) {
        /* bounded owned output */
      }
      const exit = await proc.exited;
      awaitedExit = true;
      const detail = await stderr;
      assert.equal(detail.error, null, 'owned recovery bounded stderr');
      assert.equal(exit, kill ? 137 : 0, `owned recovery child exit (${stage}): ${detail.detail}`);
      assert.equal(proc.signalCode, kill ? 'SIGKILL' : null, 'actual child signal');
      assert(!kill || killed, 'parent actually killed checkpoint owner');
      return output;
    })();
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('owned recovery child timed out')), 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (!awaitedExit) proc.kill('SIGKILL');
      const exit = await proc.exited;
      awaitedExit = true;
      await Promise.allSettled([work, stderr]);
      let missingAfterExit = false;
      try {
        process.kill(proc.pid, 0);
      } catch (error) {
        missingAfterExit = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
      const receipt = {
        pid: proc.pid,
        exit,
        signal: proc.signalCode,
        stdoutBytes,
        stderrBytes,
        reaped: awaitedExit && missingAfterExit,
        awaitedExit,
        missingAfterExit,
      };
      children.push(receipt);
      fs.writeSync(1, `${JSON.stringify({ ownedRecoveryChild: receipt })}\n`);
      assert(receipt.reaped, 'owned recovery child awaited and absent after exit');
      await reader.cancel();
      reader.releaseLock();
    }
  }

  try {
    for (const stage of stages) {
      const f = fixture();
      try {
        await launch(
          f,
          stage,
          true,
          stage === 'post-witness'
            ? async () => {
                const result = JSON.parse(await launch(f, 'contender'));
                assert.equal(result.busy, true, 'real competing process refused');
              }
            : undefined,
        );
        f.charge();
        const intent = f.open(); // A killed process must actually have released its lock.
        try {
          if (stage === 'pre-create' || stage === 'post-create') {
            refused(() => intent.cleanup(), 'incomplete witness retains artifact');
            assert.equal(
              fs.existsSync(f.file('artifact')),
              stage === 'post-create',
              'crash without witness leaves exact allocation',
            );
            assert(!fs.existsSync(f.file('owned')), 'crash without witness stays incomplete');
            assert(!fs.existsSync(f.file('cleaned')), 'crash without witness cannot claim cleanup');
          } else {
            assert.equal(intent.cleanup(), 'cleaned', 'restart cleanup after durable ownership');
            assert.equal(intent.cleanup(), 'cleaned', 'same descriptor idempotent outcome');
            assert(!fs.existsSync(f.file('artifact')), 'restart deleted only owned artifact');
            assert(fs.existsSync(f.file('cleaned')), 'restart persisted cleanup outcome');
          }
        } finally {
          intent.close();
        }
        if (stage !== 'pre-create' && stage !== 'post-create')
          assert.equal(
            JSON.parse(await launch(f, 'recover')).outcome,
            'cleaned',
            'fresh process exact terminal retry',
          );
        f.charge();
      } finally {
        f.close();
      }
      checks.push(`actual SIGKILL restart ${stage} ownership and retained accounting`);
    }
    checks.push('real nonblocking contender and killed owner flock release');
    for (const kind of ['intent', 'owned', 'cleaned']) {
      for (const fault of [
        'schema',
        'duplicate-key',
        'noncanonical',
        'truncated',
        'empty',
        'oversize',
        'symlink',
        'hardlink',
        'FIFO',
        'mode',
        'missing',
      ]) {
        const f = fixture();
        try {
          initialized(f, kind === 'cleaned');
          const filename = f.file(kind);
          const valid = fs.readFileSync(filename);
          const artifactBefore =
            kind === 'cleaned'
              ? null
              : {
                  inode: fs.statSync(f.file('artifact')).ino,
                  bytes: fs.readFileSync(f.file('artifact')),
                };
          if (fault === 'schema')
            fs.writeFileSync(
              filename,
              JSON.stringify({ ...JSON.parse(valid.toString()), extra: true }),
            );
          if (fault === 'oversize') fs.writeFileSync(filename, Buffer.alloc(4097));
          if (fault === 'duplicate-key')
            fs.writeFileSync(
              filename,
              valid.toString().replace('{"version":1,', '{"version":1,"version":1,'),
            );
          if (fault === 'noncanonical') fs.writeFileSync(filename, ` ${valid.toString()}\n`);
          if (fault === 'truncated')
            fs.writeFileSync(filename, valid.subarray(0, valid.length - 1));
          if (fault === 'empty') fs.writeFileSync(filename, Buffer.alloc(0));
          const malformedBefore = ['duplicate-key', 'noncanonical', 'truncated', 'empty'].includes(
            fault,
          )
            ? fs.readFileSync(filename)
            : null;
          if (fault === 'hardlink') fs.linkSync(filename, path.join(f.home, 'alias'));
          if (fault === 'mode') fs.chmodSync(filename, 0o640);
          if (['symlink', 'FIFO', 'missing'].includes(fault)) fs.unlinkSync(filename);
          if (fault === 'symlink') fs.symlinkSync(path.join(f.home, 'project', 'marker'), filename);
          if (fault === 'FIFO')
            assert.equal(native.fifo(filename), 0, 'actual marker FIFO created');
          const action = () => {
            const intent = f.open();
            try {
              return intent.cleanup();
            } finally {
              intent.close();
            }
          };
          if (kind === 'cleaned' && fault === 'missing')
            assert.equal(
              action(),
              'cleaned',
              'owned absence can recreate missing terminal outcome',
            );
          else refused(action, `exact ${kind} ${fault} marker refusal`);
          assert.equal(
            fs.existsSync(f.file('artifact')),
            kind !== 'cleaned',
            'invalid marker never deletes artifact',
          );
          if (artifactBefore) {
            assert.equal(
              fs.statSync(f.file('artifact')).ino,
              artifactBefore.inode,
              'invalid marker preserves exact artifact inode',
            );
            assert.deepEqual(
              fs.readFileSync(f.file('artifact')),
              artifactBefore.bytes,
              'invalid marker preserves exact artifact bytes',
            );
          }
          if (malformedBefore)
            assert.deepEqual(
              fs.readFileSync(filename),
              malformedBefore,
              'malformed immutable marker remains unchanged',
            );
          f.charge();
        } finally {
          f.close();
        }
      }
      checks.push(`exact ${kind} schema oversize links FIFO mode and missing controls`);
    }
    for (const root of ['scratch', 'metadata']) {
      const f = fixture();
      let intent: RecoveryIntent | undefined;
      try {
        initialized(f);
        intent = f.open();
        fs.renameSync(path.join(f.home, root), path.join(f.home, `${root}-held`));
        fs.mkdirSync(path.join(f.home, root), { mode: 0o700 });
        fs.writeFileSync(path.join(f.home, root, 'marker'), 'replacement untouched', {
          mode: 0o600,
        });
        refused(() => intent?.cleanup(), `exact ${root} current root refusal`);
        assert.equal(
          fs.readFileSync(path.join(f.home, root, 'marker'), 'utf8'),
          'replacement untouched',
          'replacement root untouched',
        );
        assert(
          fs.existsSync(
            path.join(f.home, root === 'scratch' ? 'scratch-held' : 'scratch', `${f.id}.artifact`),
          ),
          'captured artifact retained after root replacement',
        );
        f.charge();
      } finally {
        intent?.close();
        f.close();
      }
      checks.push(`captured ${root} replacement refuses cleanup and preserves both roots`);
    }
    for (const fault of ['replace', 'hardlink', 'symlink', 'FIFO', 'mode', 'missing']) {
      const f = fixture();
      try {
        initialized(f);
        const filename = f.file('artifact');
        if (['replace', 'symlink', 'FIFO', 'missing'].includes(fault))
          fs.renameSync(filename, path.join(f.home, 'held-artifact'));
        if (fault === 'replace')
          fs.writeFileSync(filename, 'replacement untouched', { mode: 0o600 });
        if (fault === 'symlink') fs.symlinkSync(path.join(f.home, 'project', 'marker'), filename);
        if (fault === 'FIFO') assert.equal(native.fifo(filename), 0, 'actual artifact FIFO');
        if (fault === 'mode') fs.chmodSync(filename, 0o640);
        if (fault === 'hardlink') fs.linkSync(filename, path.join(f.home, 'artifact-alias'));
        const intent = f.open();
        try {
          if (fault === 'missing')
            assert.equal(intent.cleanup(), 'cleaned', 'durable witness permits confirmed ENOENT');
          else refused(() => intent.cleanup(), `exact artifact ${fault} ownership refusal`);
        } finally {
          intent.close();
        }
        if (fault !== 'missing')
          assert(fs.lstatSync(filename), 'conflicting artifact name retained');
        if (fault === 'replace')
          assert.equal(
            fs.readFileSync(filename, 'utf8'),
            'replacement untouched',
            'replacement bytes untouched',
          );
        f.charge();
      } finally {
        f.close();
      }
    }
    checks.push('artifact identity links symlink FIFO mode refusal and exact ENOENT outcome');
    {
      const f = fixture();
      try {
        initialized(f, true);
        fs.writeFileSync(f.file('artifact'), 'terminal conflict untouched', { mode: 0o600 });
        const intent = f.open();
        try {
          refused(() => intent.cleanup(), 'exact cleaned marker conflicting artifact refusal');
        } finally {
          intent.close();
        }
        assert.equal(
          fs.readFileSync(f.file('artifact'), 'utf8'),
          'terminal conflict untouched',
          'cleaned outcome does not adopt replacement',
        );
        f.charge();
      } finally {
        f.close();
      }
      checks.push('persisted cleaned outcome rejects conflicting artifact without adoption');
    }
    for (const terminal of [false, true]) {
      const f = fixture();
      try {
        initialized(f, terminal);
        if (!terminal) fs.unlinkSync(f.file('artifact')); // Actual owned-name absence, not adoption authority.
        const before = fs
          .readdirSync(path.join(f.home, 'metadata'))
          .map((name) => [
            name,
            fs.readFileSync(path.join(f.home, 'metadata', name)).toString('hex'),
          ]);
        const intent = f.open();
        try {
          refused(
            () => intent.createArtifact(),
            'reopened owned or terminal intent refuses creation before effect',
          );
        } finally {
          intent.close();
        }
        assert.deepEqual(
          fs.readdirSync(path.join(f.home, 'scratch')),
          [],
          'reopened intent creates no artifact',
        );
        assert.deepEqual(
          fs
            .readdirSync(path.join(f.home, 'metadata'))
            .map((name) => [
              name,
              fs.readFileSync(path.join(f.home, 'metadata', name)).toString('hex'),
            ]),
          before,
          'reopened intent preserves exact marker bytes',
        );
        f.charge();
      } finally {
        f.close();
      }
    }
    checks.push('reopened owned and terminal intents refuse artifact recreation before effects');
    for (const kind of ['intent', 'owned', 'cleaned']) {
      const f = fixture();
      let intent: RecoveryIntent | undefined;
      try {
        initialized(f, kind === 'cleaned');
        intent = f.open();
        if (kind === 'owned') {
          refused(() => intent?.createArtifact(), 'reopen never adopts witness');
        }
        // Load the owned/terminal descriptors before replacing their names too.
        if (kind !== 'intent') intent.cleanup();
        const filename = f.file(kind);
        const raw = fs.readFileSync(filename);
        const before = fs.statSync(filename).ino;
        fs.renameSync(filename, path.join(f.home, 'held-marker'));
        fs.writeFileSync(filename, raw, { mode: 0o600 });
        assert.notEqual(fs.statSync(filename).ino, before, 'real marker replacement changes inode');
        refused(() => intent?.cleanup(), 'held marker inode replacement refuses outcome');
        assert.deepEqual(fs.readFileSync(filename), raw, 'replaced marker bytes untouched');
        f.charge();
      } finally {
        intent?.close();
        f.close();
      }
    }
    checks.push('held intent owned and cleaned name replacements refuse without unlink');
    {
      const f = fixture();
      let failedUnlink = 0;
      const ops = {
        ...native.ops,
        unlink(fd: number, name: string) {
          fs.renameSync(f.file('artifact'), path.join(f.home, 'held-artifact'));
          failedUnlink = native.ops.unlink(fd, name);
          return failedUnlink;
        },
      };
      try {
        initialized(f);
        const intent = RecoveryIntent.open(f.scratch, f.metadata, f.id, ops);
        try {
          refused(() => intent.cleanup(), 'real native unlink failure refuses terminal outcome');
        } finally {
          intent.close();
        }
        assert.equal(failedUnlink, -2, 'actual native unlink returned exact ENOENT');
        faults.push({ operation: 'unlink', result: failedUnlink, category: 'ENOENT' });
        assert(
          fs.existsSync(path.join(f.home, 'held-artifact')),
          'failed unlink preserves owned artifact',
        );
        assert(!fs.existsSync(f.file('cleaned')), 'failed unlink never persists cleaned');
        f.charge();
      } finally {
        f.close();
      }
      checks.push('actual native unlink failure retains witness artifact and charge');
    }
    {
      const f = fixture();
      const descriptors: number[] = [];
      const ops = {
        ...native.ops,
        create(fd: number, name: string, flags: number, mode: number) {
          const result = native.ops.create(fd, name, flags, mode);
          if (result >= 0) {
            assert.equal(native.cloexec(result), 1, 'actual journal descriptor has CLOEXEC');
            if (flags & fs.constants.O_CREAT) descriptors.push(result);
          }
          return result;
        },
      };
      try {
        const intent = RecoveryIntent.open(f.scratch, f.metadata, f.id, ops, true);
        try {
          const fd = intent.createArtifact();
          fs.closeSync(fd);
          intent.cleanup();
        } finally {
          intent.close();
        }
        assert.equal(descriptors.length, 4, 'intent artifact owned cleaned descriptors inspected');
        f.charge();
      } finally {
        f.close();
      }
      checks.push('actual intent artifact owned cleaned descriptors are close on exec');
    }
    {
      const f = fixture();
      try {
        for (const id of ['../project/marker', '/absolute', 'A'.repeat(32), '0'.repeat(31)])
          refused(
            () => RecoveryIntent.open(f.scratch, f.metadata, id, native.ops, true),
            'generated ID grammar refusal',
          );
        assert.deepEqual(
          fs.readdirSync(path.join(f.home, 'metadata')),
          [],
          'invalid IDs create no markers',
        );
        const intent = f.open(true);
        try {
          fs.chmodSync(path.join(f.home, 'scratch'), 0o500);
          const faultRoot =
            process.platform === 'linux' && process.getuid?.() === 0
              ? DirectoryRoot.capture('/proof', native.ops.openAt.bind(native.ops))
              : null;
          try {
            const before = faultRoot ? fs.readdirSync('/proof') : [];
            const result = native.ops.create(
              faultRoot?.fd ?? f.scratch.fd,
              `${f.id}.artifact`,
              fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
              0o600,
            );
            assert.equal(
              result,
              faultRoot ? -30 : -13,
              'actual native create exact permission or readonly error',
            );
            if (faultRoot)
              assert.deepEqual(
                fs.readdirSync('/proof'),
                before,
                'owned readonly proof mount unchanged',
              );
            faults.push({ operation: 'create', result, category: faultRoot ? 'EROFS' : 'EACCES' });
          } finally {
            faultRoot?.close();
          }
          refused(() => intent.createArtifact(), 'nonprivate root refuses artifact effect');
          fs.chmodSync(path.join(f.home, 'scratch'), 0o700);
          refused(() => intent.cleanup(), 'missing owned witness never cleans');
          assert(!fs.existsSync(f.file('artifact')), 'permission failure made no artifact');
        } finally {
          fs.chmodSync(path.join(f.home, 'scratch'), 0o700);
          intent.close();
        }
        f.charge();
      } finally {
        f.close();
      }
      checks.push('generated names real permission fault and incomplete intent retention');
    }
    return {
      checks,
      children,
      faults,
      cleanupErrors: 0,
      scope:
        'standalone journal cleanup only; reservations remain charged; no transfer authority adoption or refund reconciliation',
    };
  } finally {
    native.close();
    fs.rmSync(temporary, { recursive: true });
  }
}
