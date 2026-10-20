// The admission candidate is constructed against real owned filesystem objects.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { DirectoryRoot, FileAdmission, type OpenAt } from './admission';

export async function admissionProbe(
  temporary: string,
  nativeOpen: OpenAt,
  mkfifo: (pathname: string) => number,
): Promise<{ checks: string[]; aliases: Record<string, boolean> }> {
  const area = path.join(fs.realpathSync(temporary), 'admission');
  const project = path.join(area, 'project');
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  const roots: DirectoryRoot[] = [];
  const capture = (pathname: string, openAt = nativeOpen) => {
    const root = DirectoryRoot.capture(pathname, openAt);
    assert(root, 'owned directory capture');
    roots.push(root);
    return root;
  };
  const put = (relative: string, value = 'owned file bytes') => {
    const filename = path.join(project, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, value, { flag: 'wx', mode: 0o600 });
    return filename;
  };
  const checks: string[] = [];
  const aliases: Record<string, boolean> = {};
  let server: net.Server | undefined;
  const leases: ReturnType<FileAdmission['open']>[] = [];
  try {
    const protectedPath = path.join(project, 'custom-config');
    put('custom-config/inner/data.txt');
    put('secrét-config/inner/data.txt');
    put('custom-config-other/data.txt');
    put('custom-config-other/inner/data.txt');
    for (const directory of ['.remi', '.claude', '.codex']) put(`${directory}/data.txt`);
    const protectedRoots = [
      protectedPath,
      path.join(project, 'secrét-config'),
      ...['.remi', '.claude', '.codex'].map((p) => path.join(project, p)),
    ].map((p) => capture(p));
    let opens = 0;
    const openAt: OpenAt = (...args) => {
      opens++;
      return nativeOpen(...args);
    };
    const root = capture(project, openAt);
    const admission = new FileAdmission(openAt, protectedRoots);
    const admit = (parts: string[]) => {
      const file = admission.open(root, parts);
      assert(file, 'owned regular-file admission');
      leases.push(file);
      return file;
    };
    put('safe.txt');
    const safe = admit(['safe.txt']);
    assert.equal(fs.readFileSync(safe.fd, 'utf8'), 'owned file bytes');
    safe.close();
    safe.close();
    assert.equal(safe.isCurrent(), false);
    assert.throws(() => fs.fstatSync(safe.fd), { code: 'EBADF' });
    opens = 0;
    const blocked = [
      [],
      [''],
      ['.'],
      ['..'],
      ['a/b'],
      ['a\\b'],
      ['/absolute'],
      ['C:drive'],
      ['\0'],
      ['a\n'],
      ['a\u007f'],
      ['a\u0085'],
      ['a\u202e'],
      ['a\u2066'],
      ['a\u061c'],
      ['.env'],
      ['.env.local'],
      ['.ENV.production'],
      ['.git', 'config'],
      ['.ssh', 'key'],
      ['.aws', 'data'],
      ['.config', 'data'],
      ['.remi', 'data'],
      ['.claude', 'data'],
      ['.codex', 'data'],
      ['node_modules', 'data'],
      ['NODE_MODULES', 'data'],
      ['id_rsa'],
      ['ID_ED25519'],
      ['credentials'],
      ['AUTHORIZED_KEYS'],
      ['known_hosts'],
      ['secret.KEY'],
      ['secret.pem'],
      ['secret.P12'],
      ['secret.pfx'],
      ['secret.keystore'],
      ['backup~'],
      ['x'.repeat(256)],
      ['é'.repeat(128)],
      Array(65).fill('folder'),
    ];
    for (const parts of blocked) assert.equal(admission.open(root, parts), null);
    assert.equal(opens, 0, 'component refusal must precede native opens');
    checks.push('hidden and credential components rejected before open');
    put('x'.repeat(255));
    admit(['x'.repeat(255)]).close();

    assert.equal(admission.open(root, ['custom-config', 'inner', 'data.txt']), null);
    assert.equal(admission.open(capture(path.join(protectedPath, 'inner')), ['data.txt']), null);
    for (const directory of ['.remi', '.claude', '.codex'])
      assert.equal(admission.open(capture(path.join(project, directory)), ['data.txt']), null);
    admit(['custom-config-other', 'data.txt']).close(); // Component boundary, not string prefix.
    fs.renameSync(protectedPath, path.join(project, 'renamed-config'));
    put('custom-config/inner/data.txt', 'replacement configuration');
    opens = 0;
    assert.equal(
      admission.open(root, ['custom-config', 'inner', 'data.txt']),
      null,
      'credential path replacement refusal',
    );
    assert.equal(opens, 0, 'configured credential path refused before open');
    const alias = path.join(project, 'CUSTOM-CONFIG');
    aliases['asciiCase'] = fs.existsSync(alias);
    if (aliases['asciiCase']) {
      assert.equal(
        fs.statSync(alias, { bigint: true }).ino,
        fs.statSync(protectedPath, { bigint: true }).ino,
        'actual filesystem case alias',
      );
    } else {
      put('CUSTOM-CONFIG/inner/data.txt', 'case-insensitive policy fixture');
    }
    opens = 0;
    assert.equal(
      admission.open(root, ['CUSTOM-CONFIG', 'inner', 'data.txt']),
      null,
      'credential replacement case alias refusal',
    );
    assert.equal(opens, 0, 'credential case alias refused before open');
    assert.equal(
      admission.open(capture(path.join(alias, 'inner')), ['data.txt']),
      null,
      'credential root case alias refusal',
    );
    const unicodePath = path.join(project, 'secrét-config');
    fs.renameSync(unicodePath, path.join(project, 'unicode-kept'));
    put('secrét-config/inner/data.txt', 'replacement Unicode configuration');
    for (const [kind, spelling] of [
      ['normalization', 'secre\u0301t-config'],
      ['unicodeCase', 'SECRÉT-CONFIG'],
    ]) {
      assert(kind && spelling);
      const pathname = path.join(project, spelling);
      aliases[kind] = fs.existsSync(pathname);
      if (!aliases[kind]) continue; // No such alias on this filesystem; do not claim one.
      assert.equal(
        fs.statSync(pathname, { bigint: true }).ino,
        fs.statSync(unicodePath, { bigint: true }).ino,
        'actual Unicode filesystem alias',
      );
      assert.equal(
        admission.open(root, [spelling, 'inner', 'data.txt']),
        null,
        'current credential directory identity refusal',
      );
      assert.equal(
        admission.open(capture(path.join(pathname, 'inner')), ['data.txt']),
        null,
        'current credential root identity refusal',
      );
    }
    assert.equal(
      admission.open(root, ['renamed-config', 'inner', 'data.txt']),
      null,
      'credential directory identity refusal',
    );
    assert.equal(
      admission.open(capture(path.join(project, 'renamed-config', 'inner')), ['data.txt']),
      null,
      'credential root identity refusal',
    );
    fs.mkdirSync(path.join(project, 'replacement-race'));
    let configurationMoved = false;
    assert.equal(
      admission.open(root, ['replacement-race', 'moved-config', 'inner', 'data.txt'], (index) => {
        if (index !== 0) return;
        fs.renameSync(protectedPath, path.join(project, 'replacement-race', 'moved-config'));
        put('custom-config/inner/data.txt', 'next replacement configuration');
        configurationMoved = true;
      }),
      null,
      'captured current credential identity refusal',
    );
    assert(configurationMoved, 'configured replacement actually moved during lookup');
    checks.push('protected directory overlap and replacement refusal');

    fs.symlinkSync(path.join(project, 'safe.txt'), path.join(project, 'leaf-link'));
    fs.symlinkSync(path.join(project, 'custom-config-other'), path.join(project, 'parent-link'));
    assert.equal(admission.open(root, ['leaf-link']), null, 'leaf symlink refusal');
    assert.equal(admission.open(root, ['parent-link', 'data.txt']), null);
    assert.equal(DirectoryRoot.capture(path.join(project, 'parent-link'), nativeOpen), null);
    assert.equal(
      DirectoryRoot.capture(path.join(project, 'parent-link', 'inner'), nativeOpen),
      null,
    );
    fs.linkSync(path.join(project, 'safe.txt'), path.join(project, 'hardlink'));
    assert.equal(admission.open(root, ['safe.txt']), null, 'multiply linked candidate refusal');
    fs.unlinkSync(path.join(project, 'hardlink'));
    checks.push('candidate symlink and hardlink refusal');

    put('ancestor-race/data.txt');
    let replaced = false;
    assert.equal(
      admission.open(root, ['ancestor-race', 'data.txt'], (index) => {
        if (index !== 0) return;
        fs.renameSync(path.join(project, 'ancestor-race'), path.join(project, 'ancestor-kept'));
        put('ancestor-race/data.txt', 'replacement bytes');
        replaced = true;
      }),
      null,
      'ancestor replacement refusal',
    );
    assert(replaced, 'ancestor replacement actually ran');
    checks.push('deterministic ancestor replacement refusal');

    put('leaf-race.txt');
    replaced = false;
    assert.equal(
      admission.open(root, ['leaf-race.txt'], () => {
        fs.renameSync(path.join(project, 'leaf-race.txt'), path.join(project, 'leaf-kept.txt'));
        put('leaf-race.txt', 'replacement bytes');
        replaced = true;
      }),
      null,
    );
    assert(replaced, 'leaf replacement actually ran');
    checks.push('deterministic final component replacement refusal');

    put('retained-parent/data.txt');
    const parentLease = admit(['retained-parent', 'data.txt']);
    fs.renameSync(path.join(project, 'retained-parent'), path.join(project, 'retained-kept'));
    put('retained-parent/data.txt', 'replacement bytes');
    assert.equal(parentLease.isCurrent(), false);
    parentLease.close();
    const leafLease = admit(['safe.txt']);
    fs.renameSync(path.join(project, 'safe.txt'), path.join(project, 'safe-kept.txt'));
    put('safe.txt', 'replacement bytes');
    assert.equal(leafLease.isCurrent(), false);
    leafLease.close();
    const linkLease = admit(['safe.txt']);
    fs.linkSync(path.join(project, 'safe.txt'), path.join(project, 'late-hardlink'));
    assert.equal(linkLease.isCurrent(), false);
    linkLease.close();
    const configurationLease = admit(['leaf-race.txt']);
    fs.renameSync(unicodePath, path.join(project, 'configuration-unavailable'));
    assert.equal(configurationLease.isCurrent(), false, 'missing configured root lease refusal');
    assert.equal(admission.open(root, ['leaf-race.txt']), null, 'missing configured root refusal');
    fs.renameSync(path.join(project, 'configuration-unavailable'), unicodePath);
    configurationLease.close();
    checks.push('open descriptor lease revalidation');

    fs.mkdirSync(path.join(project, 'directory'));
    assert.equal(admission.open(root, ['directory']), null);
    assert.equal(mkfifo(path.join(project, 'fifo')), 0, 'real FIFO creation');
    assert(fs.lstatSync(path.join(project, 'fifo')).isFIFO());
    assert.equal(admission.open(root, ['fifo']), null, 'FIFO refusal');
    server = net.createServer();
    const socketPath = path.join(project, 'socket');
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(socketPath, resolve);
    });
    assert(fs.lstatSync(socketPath).isSocket());
    assert.equal(admission.open(root, ['socket']), null);
    // Read-only system metadata control; no device creation and no device bytes read.
    assert(fs.lstatSync('/dev/null').isCharacterDevice());
    let deviceOpened = false;
    const deviceOpen: OpenAt = (...args) => {
      const fd = nativeOpen(...args);
      if (args[1] === 'null' && fd >= 0) deviceOpened = true;
      return fd;
    };
    const deviceRoot = capture('/dev', deviceOpen);
    assert.equal(new FileAdmission(deviceOpen, protectedRoots).open(deviceRoot, ['null']), null);
    assert(deviceOpened, 'device descriptor reached regular-file inspection');
    checks.push('directory FIFO socket and device refusal');

    const large = put('large.bin', '');
    fs.truncateSync(large, 10 * 1024 * 1024);
    const boundary = admit(['large.bin']);
    assert.equal(boundary.size, 10n * 1024n * 1024n);
    boundary.close();
    fs.truncateSync(large, 10 * 1024 * 1024 + 1);
    assert.equal(admission.open(root, ['large.bin']), null, 'initial size refusal');
    checks.push('initial 10 MiB size admission');

    const rootLease = admit(['leaf-race.txt']);
    fs.renameSync(project, path.join(area, 'project-kept'));
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'leaf-race.txt'), 'replacement root bytes');
    assert.equal(rootLease.isCurrent(), false);
    assert.equal(admission.open(root, ['leaf-race.txt']), null);
    rootLease.close();
    checks.push('captured project root replacement refusal');
    return { checks, aliases };
  } finally {
    if (server?.listening)
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    for (const file of leases) file?.close();
    for (const directory of roots.reverse()) directory.close();
  }
}
