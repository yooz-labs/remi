// Owned filesystem controls construct the real candidate, without syscall/stat mocks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DirectoryRoot, FileAdmission } from './admission';
import { type CopyCheckpoint, type PrivateOps, copyToPrivate } from './private-copy';

export function copyProbe(temporary: string, ops: PrivateOps): string[] {
  const area = path.join(fs.realpathSync(temporary), 'copy');
  fs.mkdirSync(area, { mode: 0o700 });
  const checks: string[] = [];
  let sequence = 0;
  const fixture = (value = Buffer.alloc(65536, 0x61)) => {
    const home = path.join(area, `${sequence++}`);
    const project = path.join(home, 'project');
    const privatePath = path.join(home, 'private');
    fs.mkdirSync(path.join(project, 'inner'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(privatePath, { mode: 0o700 });
    const filename = path.join(project, 'inner', 'data.txt');
    fs.writeFileSync(filename, value, { mode: 0o600 });
    fs.utimesSync(filename, 1577836800, 1577836800); // Exactly representable mtime for restore control.
    const root = DirectoryRoot.capture(project, ops.openAt);
    const scratch = DirectoryRoot.capture(privatePath, ops.openAt);
    assert(root && scratch, 'copy fixture captured roots');
    const source = new FileAdmission(ops.openAt, []).open(root, ['inner', 'data.txt']);
    assert(source, 'copy fixture admitted file');
    return {
      home,
      project,
      privatePath,
      filename,
      root,
      scratch,
      source,
      close: () => {
        source.close();
        root.close();
        scratch.close();
        fs.rmSync(home, { recursive: true, force: true });
      },
    };
  };
  const refusal = (
    label: string,
    change: (item: ReturnType<typeof fixture>, event: CopyCheckpoint) => void,
    stage: CopyCheckpoint['stage'] = 'read',
  ) => {
    const f = fixture();
    let changed = false;
    let partialFD = -1;
    try {
      const result = copyToPrivate(f.source, f.scratch, ops, (event) => {
        if (event.stage === 'created') partialFD = event.fd;
        if (changed || event.stage !== stage) return;
        change(f, event);
        changed = true; // A failed mutation is never counted as a successful refusal.
      });
      assert(changed, `${label} checkpoint completed`);
      try {
        assert.equal(result, null, `${label} refused`);
      } finally {
        result?.close();
      }
      assert.deepEqual(fs.readdirSync(f.privatePath), [], `${label} partial removed`);
      assert.throws(() => fs.fstatSync(partialFD), { code: 'EBADF' }, `${label} descriptor closed`);
    } finally {
      f.close();
    }
  };
  for (const value of [
    Buffer.alloc(0),
    Buffer.from('owned private copy\n'),
    Buffer.alloc(10 * 1024 * 1024, 0x62),
  ]) {
    const f = fixture(value);
    try {
      const artifact = copyToPrivate(f.source, f.scratch, ops);
      assert(artifact, 'valid private copy');
      try {
        assert.equal(artifact.size, value.length, 'private copy length');
        assert.equal(
          artifact.sha256,
          createHash('sha256').update(value).digest('hex'),
          'private copy digest',
        );
        const bytes = Buffer.alloc(32768);
        let offset = 0;
        const hash = createHash('sha256');
        for (;;) {
          const count = artifact.read(bytes, offset);
          if (!count) break;
          assert(count <= 32768, 'bounded private read');
          assert.deepEqual(
            bytes.subarray(0, count),
            value.subarray(offset, offset + count),
            'private copy bytes',
          );
          hash.update(bytes.subarray(0, count));
          offset += count;
        }
        assert.equal(offset, value.length, 'private copy EOF');
        assert.equal(hash.digest('hex'), artifact.sha256, 'published copy digest');
        const names = fs.readdirSync(f.privatePath);
        assert.equal(names.length, 1, 'only completed private copy');
        assert.match(names[0] ?? '', /^[a-f0-9]{32}\.complete$/, 'generated private name');
        const stat = fs.statSync(path.join(f.privatePath, names[0] ?? ''));
        assert.equal(stat.mode & 0o777, 0o600, 'private copy mode');
        assert.equal(stat.nlink, 1, 'private copy link count');
      } finally {
        artifact.close();
      }
      artifact.close();
      assert.throws(
        () => artifact.read(Buffer.alloc(1), 0),
        /unavailable/,
        'closed copy refuses read',
      );
      assert.deepEqual(fs.readdirSync(f.privatePath), [], 'completed private cleanup');
    } finally {
      f.close();
    }
  }
  checks.push('empty nonempty and 10 MiB private copies with exact bytes digest and mode');

  refusal('copy growth', (f) => fs.appendFileSync(f.filename, 'extra'));
  refusal('copy truncation', (f) => fs.truncateSync(f.filename, 32768));
  refusal('copy same-size mutation', (f) => {
    const fd = fs.openSync(f.filename, 'r+');
    try {
      fs.writeSync(fd, 'changed', 0, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  });
  refusal('copy restored-mtime mutation', (f) => {
    const original = fs.fstatSync(f.source.fd, { bigint: true });
    const fd = fs.openSync(f.filename, 'r+');
    try {
      fs.writeSync(fd, 'changed', 0, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.utimesSync(f.filename, 1577836800, 1577836800);
    const changed = fs.fstatSync(f.source.fd, { bigint: true });
    assert.equal(changed.mtimeNs, original.mtimeNs, 'mtime actually restored');
    assert.notEqual(changed.ctimeNs, original.ctimeNs, 'ctime actually changed');
  });
  checks.push('growth truncation and detected same-size mutation refusal');

  refusal('copy new hardlink', (f) => fs.linkSync(f.filename, path.join(f.home, 'hardlink')));
  refusal('copy leaf replacement', (f) => {
    fs.renameSync(f.filename, `${f.filename}.moved`);
    fs.writeFileSync(f.filename, 'replacement');
  });
  refusal('copy ancestor replacement', (f) => {
    fs.renameSync(path.join(f.project, 'inner'), path.join(f.project, 'moved'));
    fs.mkdirSync(path.join(f.project, 'inner'));
    fs.writeFileSync(f.filename, 'replacement');
  });
  refusal('copy root replacement', (f) => {
    fs.renameSync(f.project, path.join(f.home, 'moved'));
    fs.mkdirSync(f.project);
  });
  checks.push('source link and ancestor leaf root replacement refusal during copy');

  refusal('copy private-byte mutation', (f) => {
    const partial = fs.readdirSync(f.privatePath)[0];
    assert(partial, 'private mutation partial exists');
    const fd = fs.openSync(path.join(f.privatePath, partial), 'r+');
    try {
      fs.writeSync(fd, 'private mutation', 0, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  });
  refusal('copy private mode', (f) => {
    const partial = fs.readdirSync(f.privatePath)[0];
    assert(partial, 'private mode partial exists');
    fs.chmodSync(path.join(f.privatePath, partial), 0o644);
  });
  refusal(
    'copy effect-time source mutation',
    (f) => {
      const fd = fs.openSync(f.filename, 'r+');
      try {
        fs.writeSync(fd, 'changed', 0, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    },
    'validated',
  );
  checks.push('private bytes mode and effect-time source validation');

  refusal(
    'copy read error',
    (f) => {
      fs.closeSync(f.source.fd);
      const replacement = fs.openSync(f.filename, 'w');
      assert.equal(replacement, f.source.fd, 'owned read-error descriptor reused');
      assert.throws(() => fs.readSync(replacement, Buffer.alloc(1), 0, 1, 0), { code: 'EBADF' });
    },
    'created',
  );
  refusal(
    'copy write error',
    (f, event) => {
      assert.equal(event.stage, 'created');
      if (event.stage !== 'created') throw new Error('write-error checkpoint');
      fs.closeSync(event.fd);
      const replacement = fs.openSync(path.join(f.privatePath, event.partial), 'r');
      assert.equal(replacement, event.fd, 'owned write-error descriptor reused');
      assert.throws(() => fs.writeSync(replacement, 'x'), { code: 'EBADF' });
    },
    'created',
  );
  checks.push('actual descriptor read and write failure cleanup');

  const mode = fixture();
  try {
    fs.chmodSync(mode.privatePath, 0o755);
    const result = copyToPrivate(mode.source, mode.scratch, ops);
    try {
      assert.equal(result, null, 'copy nonprivate directory refused');
    } finally {
      result?.close();
    }
    assert.deepEqual(fs.readdirSync(mode.privatePath), [], 'nonprivate directory untouched');
  } finally {
    mode.close();
  }
  const exclusive = fixture();
  let existing = '';
  try {
    const result = copyToPrivate(exclusive.source, exclusive.scratch, {
      ...ops,
      create: (directory, name, flags, permissions) => {
        existing = name;
        fs.writeFileSync(path.join(exclusive.privatePath, name), '', {
          flag: 'wx',
          mode: 0o600,
        });
        return ops.create(directory, name, flags, permissions); // Real collision, real native create.
      },
    });
    assert(existing, 'exclusive collision checkpoint completed');
    try {
      assert.equal(result, null, 'copy creation collision refused');
    } finally {
      result?.close();
    }
    assert.deepEqual(fs.readdirSync(exclusive.privatePath), [existing], 'existing file retained');
    assert.equal(
      fs.readFileSync(path.join(exclusive.privatePath, existing), 'utf8'),
      '',
      'creation collision untouched',
    );
  } finally {
    exclusive.close();
  }
  checks.push('nonprivate directory and exclusive creation collision refusal');

  const collision = fixture();
  let collisionName = '';
  try {
    const result = copyToPrivate(collision.source, collision.scratch, ops, (event) => {
      if (event.stage !== 'validated') return;
      collisionName = event.final;
      fs.writeFileSync(path.join(collision.privatePath, event.final), 'collision marker', {
        flag: 'wx',
      });
    });
    assert(collisionName, 'publication collision checkpoint completed');
    try {
      assert.equal(result, null, 'copy publication collision refused');
    } finally {
      result?.close();
    }
    assert.deepEqual(fs.readdirSync(collision.privatePath), [collisionName], 'collision only');
    assert.equal(
      fs.readFileSync(path.join(collision.privatePath, collisionName), 'utf8'),
      'collision marker',
      'publication collision untouched',
    );
  } finally {
    collision.close();
  }
  checks.push('private publication collision refuses without overwrite');

  const replaced = fixture();
  let changed = false;
  const outside = path.join(replaced.home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'marker'), 'outside untouched');
  try {
    const result = copyToPrivate(replaced.source, replaced.scratch, ops, (event) => {
      if (changed || event.stage !== 'read') return;
      fs.renameSync(replaced.privatePath, path.join(replaced.home, 'moved-private'));
      fs.symlinkSync(outside, replaced.privatePath);
      changed = true;
    });
    assert(changed, 'private replacement checkpoint completed');
    try {
      assert.equal(result, null, 'copy private-root replacement refused');
    } finally {
      result?.close();
    }
    assert.deepEqual(
      fs.readdirSync(path.join(replaced.home, 'moved-private')),
      [],
      'captured partial cleanup',
    );
    assert.deepEqual(fs.readdirSync(outside), ['marker'], 'outside names untouched');
    assert.equal(fs.readFileSync(path.join(outside, 'marker'), 'utf8'), 'outside untouched');
  } finally {
    replaced.close();
  }
  checks.push('private root replacement cleanup through captured directory');

  const completed = fixture(Buffer.from('validated bytes'));
  try {
    const artifact = copyToPrivate(completed.source, completed.scratch, ops);
    assert(artifact, 'completed copy independent of source');
    try {
      fs.writeFileSync(completed.filename, 'new source bytes');
      completed.source.close();
      completed.root.close();
      completed.scratch.close();
      fs.renameSync(completed.privatePath, path.join(completed.home, 'retained-private'));
      fs.mkdirSync(completed.privatePath);
      fs.writeFileSync(path.join(completed.privatePath, 'marker'), 'new root untouched');
      const bytes = Buffer.alloc(100);
      const count = artifact.read(bytes, 0);
      assert.equal(
        bytes.subarray(0, count).toString(),
        'validated bytes',
        'completed copy retains validated bytes',
      );
    } finally {
      artifact.close();
    }
    assert.deepEqual(
      fs.readdirSync(path.join(completed.home, 'retained-private')),
      [],
      'captured completed cleanup',
    );
    assert.equal(
      fs.readFileSync(path.join(completed.privatePath, 'marker'), 'utf8'),
      'new root untouched',
    );
  } finally {
    completed.close();
  }
  checks.push('completed private descriptor survives source and root changes');

  const cleanup = fixture();
  try {
    const artifact = copyToPrivate(cleanup.source, cleanup.scratch, ops);
    assert(artifact, 'cleanup failure completed copy');
    const name = fs.readdirSync(cleanup.privatePath)[0];
    assert(name, 'cleanup completed name exists');
    const original = path.join(cleanup.privatePath, name);
    const moved = path.join(cleanup.privatePath, 'moved');
    fs.renameSync(original, moved); // Real ENOENT for captured unlinkat.
    assert.throws(
      () => artifact.close(),
      /private cleanup failed/,
      'actual completed unlink failure visible',
    );
    fs.renameSync(moved, original);
    artifact.close();
    assert.deepEqual(fs.readdirSync(cleanup.privatePath), [], 'completed cleanup retry');
  } finally {
    cleanup.close();
  }
  checks.push('actual completed cleanup failure remains visible and retryable');
  return checks;
}
