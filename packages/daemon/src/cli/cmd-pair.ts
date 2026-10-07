/**
 * `remi pair` (#1275, ADR 0037): pair a phone by QR, approved at this terminal.
 *
 * It shows a pairing link (the machine's name, address, public key, a single-use code and its
 * expiry) as a QR and as text, waits for a phone to claim the code over its first, signed
 * connection, shows that phone's fingerprint and name, and asks the person whether to approve it.
 * Yes approves through the same store mutation `remi authorize` uses; anything else rejects. The
 * code alone authorizes nothing.
 *
 * {@link pairFlow} is the flow, given its store and its terminal; {@link pairPreconditions} decides
 * whether the running hub is one a phone can reach and pair with; {@link runPairCommand} joins them
 * to the real terminal and files.
 */

import * as os from 'node:os';
import * as readline from 'node:readline';
import {
  PROTOCOL_VERSION,
  type PairingCode,
  encodePairingLink,
  escapeUnsafeText,
  isPairingHost,
} from '@remi/shared';
import { renderUnicodeCompact } from 'uqr';
import { IdentityStore, PairingLimitError } from '../auth/identity-store.ts';
import { readHubStatus } from './daemon-manager.ts';

/** What the flow needs: the store, the machine, where the phone connects, and the terminal. */
export interface PairFlowDeps {
  readonly store: Pick<
    IdentityStore,
    'createPairing' | 'readPairing' | 'approvePairing' | 'rejectPairing' | 'cancelPairing'
  >;
  readonly machineKey: string;
  readonly machineFingerprint: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** Other addresses the hub can be reached on, offered as `--host` choices. */
  readonly others?: readonly string[];
  readonly write: (text: string) => void;
  /** Asks a question; resolves with the answer, or null when the input closed. */
  readonly ask: (question: string) => Promise<string | null>;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
  readonly now?: () => number;
}

/** A fingerprint in groups of four, as the app shows it. */
export function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp;
}

/** The QR, white modules drawn on black, so it reads the same on a light or a dark terminal. */
function renderQr(link: string): string {
  return renderUnicodeCompact(link, { border: 2 })
    .split('\n')
    .map((row) => `  \x1b[97;40m${row}\x1b[0m`)
    .join('\n');
}

/**
 * Shows a code, waits for a claim, asks, and decides. Returns the exit code: 0 approved, 1 rejected,
 * expired or not shown, 130 cancelled with Ctrl-C.
 */
export async function pairFlow(deps: PairFlowDeps): Promise<number> {
  const { store, write } = deps;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 300;

  let created: ReturnType<typeof store.createPairing>;
  try {
    created = store.createPairing();
  } catch (err) {
    if (err instanceof PairingLimitError) {
      write('Four pairing codes are already open on this machine. Finish or cancel one first.\n');
      return 1;
    }
    throw err;
  }
  const { nonce, record } = created;
  const expiresAt = Date.parse(record.expiresAt);
  const code: PairingCode = {
    v: 1,
    name: deps.name,
    host: deps.host,
    port: deps.port,
    key: deps.machineKey,
    nonce,
    exp: Math.floor(expiresAt / 1000),
    proto: PROTOCOL_VERSION,
  };
  const link = encodePairingLink(code);
  const expiry = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  write(`\nScan this with the Remi app on your phone.\n\n${renderQr(link)}\n\n`);
  write(`  Machine      ${escapeUnsafeText(deps.name)}\n`);
  write(`  Address      ${deps.host}:${deps.port}\n`);
  write(`  Fingerprint  ${formatFingerprint(deps.machineFingerprint)}  (the app shows the same)\n`);
  write(`  Expires      ${expiry}, single use\n`);
  write(`  Link         ${link}\n`);
  if (deps.others !== undefined && deps.others.length > 0) {
    write(`  Other addresses: ${deps.others.join(', ')} (remi pair --host <address>)\n`);
  }
  write(
    '\nThe code does not approve the phone: you will be asked here. The connection is not encrypted by remi; use a trusted network, a VPN or an SSH tunnel.\n',
  );
  write('Waiting for the phone... (Ctrl-C to cancel)\n');

  const cancelled = (message: string, exitCode: number): number => {
    store.cancelPairing(nonce);
    write(message);
    return exitCode;
  };
  let claim = null as ReturnType<typeof store.readPairing>;
  for (;;) {
    if (deps.signal?.aborted) return cancelled('\nCancelled; the code no longer works.\n', 130);
    claim = store.readPairing(nonce);
    if (claim?.state === 'claimed' && claim.claim !== null) break;
    if (claim?.state === 'cancelled') return cancelled('\nThe code was cancelled.\n', 1);
    if (now() >= expiresAt) {
      return cancelled('\nThe code expired before a phone used it. Run remi pair again.\n', 1);
    }
    await Bun.sleep(pollMs);
  }

  const { label, fingerprint: phoneFingerprint } = claim.claim as NonNullable<typeof claim.claim>;
  write('\nA device wants to pair:\n');
  write(`  Name         ${escapeUnsafeText(label)}\n`);
  write(`  Fingerprint  ${formatFingerprint(phoneFingerprint)}\n`);
  write('Check that the app shows the same fingerprint for this phone.\n');
  const answer = deps.signal?.aborted ? null : await deps.ask('Approve this device? [y/N] ');
  if (answer !== null && /^(y|yes)$/i.test(answer.trim())) {
    try {
      await store.approvePairing(nonce, phoneFingerprint);
    } catch (err) {
      write(`\nCould not approve it: ${escapeUnsafeText(String(err))}\n`);
      return 1;
    }
    write(
      `\nApproved. ${escapeUnsafeText(label)} can connect now; the app continues on its own.\n`,
    );
    return 0;
  }
  store.rejectPairing(nonce);
  write('\nRejected; the phone was not approved.\n');
  return 1;
}

/** Addresses a phone could use for a hub bound to `bind`: LAN first, then Tailscale, then the rest. */
export function pairingHosts(
  bind: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  if (bind !== '0.0.0.0' && bind !== '::' && bind !== '') return [bind];
  const rank = (address: string): number => {
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) return 0;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 1;
    return 2;
  };
  const addresses: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      const ipv4 = info.family === 'IPv4' || (info.family as unknown) === 4;
      if (info.internal || !ipv4) continue;
      addresses.push(info.address);
    }
  }
  return addresses
    .map((address, order) => ({ address, order }))
    .sort((a, b) => rank(a.address) - rank(b.address) || a.order - b.order)
    .map((entry) => entry.address);
}

const LOOPBACK = /^(127\.|::1$|localhost$)/;

/**
 * Whether the running hub can be paired with, and where a phone should connect. Refuses, each with
 * what to do: no hub; a hub too old to say how it is bound; authentication off; a loopback bind
 * (no phone could reach it); no address to show; and a `--host` that is not an address.
 */
export function pairPreconditions(
  status: { port: number; bind?: string; auth?: boolean } | null,
  requestedHost: string | undefined,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): { ok: true; host: string; port: number; others: string[] } | { ok: false; message: string } {
  if (status === null) {
    return {
      ok: false,
      message:
        'No hub is running. Start one with `remi start` (with `daemon.bind` set to an address your phone can reach), then run remi pair again.',
    };
  }
  if (status.bind === undefined || status.auth === undefined) {
    return {
      ok: false,
      message:
        'The running hub is older than remi pair and does not say how it is bound: restart it (`remi stop`, then `remi start`) and run remi pair again.',
    };
  }
  if (!status.auth) {
    return {
      ok: false,
      message:
        'This hub runs with authentication off, so pairing would approve nothing. Turn it on (remove `--no-auth` or `auth.enabled = false`), restart the hub, and run remi pair again.',
    };
  }
  if (LOOPBACK.test(status.bind)) {
    return {
      ok: false,
      message: `This hub listens on ${status.bind} only, which a phone cannot reach. Set \`daemon.bind\` in ~/.remi/config.toml to "0.0.0.0" or to your LAN or VPN address, restart the hub, and run remi pair again. (An SSH tunnel needs no pairing code: use remi keys and remi authorize.)`,
    };
  }
  const hosts = pairingHosts(status.bind, interfaces);
  if (requestedHost !== undefined) {
    if (!isPairingHost(requestedHost)) {
      return {
        ok: false,
        message: `--host ${escapeUnsafeText(requestedHost)} is not an IP address or a host name.`,
      };
    }
    return {
      ok: true,
      host: requestedHost,
      port: status.port,
      others: hosts.filter((h) => h !== requestedHost),
    };
  }
  const [host, ...others] = hosts;
  if (host === undefined) {
    return {
      ok: false,
      message: 'No network address was found to show. Choose one with remi pair --host <address>.',
    };
  }
  return { ok: true, host, port: status.port, others };
}

/** The machine's name for the code: the short host name, plain characters only. */
function machineName(): string {
  const short = os.hostname().split('.')[0] ?? '';
  const plain = short.replace(/[^\p{L}\p{N} ._'-]/gu, '').slice(0, 64);
  return plain.length > 0 ? plain : 'remi';
}

/** `remi pair [--host <address>]`: the flow on the real terminal, hub status and identity store. */
export async function runPairCommand(flags: { host?: string }): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'remi pair needs an interactive terminal: it shows a QR code and asks you to approve the phone. Without one, use remi keys and remi authorize <fingerprint>.',
    );
    return 2;
  }
  const checked = pairPreconditions(readHubStatus(), flags.host, os.networkInterfaces());
  if (!checked.ok) {
    console.error(checked.message);
    return 1;
  }
  const store = new IdentityStore();
  const identity = store.load();
  if (identity === null) {
    console.error(
      'This machine has no identity yet. Start the hub once (remi start), then run remi pair.',
    );
    return 1;
  }
  const controller = new AbortController();
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Bun's readline types omit the EventEmitter methods the runtime has.
  const events = terminal as unknown as NodeJS.EventEmitter;
  const onInterrupt = () => {
    controller.abort();
    terminal.close();
  };
  process.on('SIGINT', onInterrupt);
  events.on('SIGINT', onInterrupt);
  try {
    return await pairFlow({
      store,
      machineKey: identity.publicKey,
      machineFingerprint: identity.fingerprint,
      name: machineName(),
      host: checked.host,
      port: checked.port,
      others: checked.others,
      write: (text) => process.stdout.write(text),
      ask: (question) =>
        new Promise((resolve) => {
          terminal.question(question, resolve);
          events.once('close', () => resolve(null));
        }),
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onInterrupt);
    terminal.close();
  }
}
