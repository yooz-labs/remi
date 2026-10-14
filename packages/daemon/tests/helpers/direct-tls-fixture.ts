/** Owned short-lived CA material; no installed identity, capability or trust access. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function directTlsFixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'remi-b2-'));
  const home = join(directory, 'state');
  const userHome = join(directory, 'user');
  const work = join(directory, 'work');
  const certs = join(home, 'certs');
  for (const dir of [directory, home, userHome, work, certs])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    join(certs, 'ca.cnf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Remi owned B2 CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  fs.writeFileSync(
    join(certs, 'server.cnf'),
    '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=127.0.0.1\n',
  );
  fs.writeFileSync(
    join(certs, 'server.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
  );
  const openssl = (...args: string[]) =>
    execFileSync('openssl', args, { cwd: certs, stdio: 'pipe' });
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-config',
    'ca.cnf',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
  );
  openssl(
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-config',
    'server.cnf',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
  );
  openssl(
    'x509',
    '-req',
    '-days',
    '1',
    '-in',
    'server.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-extfile',
    'server.ext',
    '-out',
    'server.pem',
  );
  for (const name of ['ca.key', 'server.key']) fs.chmodSync(join(certs, name), 0o600);
  const configPath = join(home, 'config.toml');
  const tlsTable =
    '[daemon.tls]\ncertificate_file="certs/server.pem"\nprivate_key_file="certs/server.key"\n';
  const config = `[daemon]\nbind="127.0.0.1"\n${tlsTable}[network]\nmdns=true\nrelay=false\n[telegram]\nenabled=false\n`;
  fs.writeFileSync(configPath, config);
  return {
    directory,
    home,
    work,
    userHome,
    certs,
    configPath,
    tlsTable,
    config,
    ca: fs.readFileSync(join(certs, 'ca.pem'), 'utf8'),
    tls: {
      cert: fs.readFileSync(join(certs, 'server.pem'), 'utf8'),
      key: fs.readFileSync(join(certs, 'server.key'), 'utf8'),
    },
    env: {
      HOME: userHome,
      REMI_HOME: home,
      TMPDIR: tmpdir(),
      PATH: '/usr/bin:/bin',
      NODE_ENV: 'test',
    },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
