/**
 * `remi pair` (#1275, ADR 0037): pair a phone by QR, approved at this terminal.
 *
 * It shows a pairing link (the machine's name, address, public key, a single-use code and its
 * expiry) as a QR and as text, waits for a phone to claim the code over its first, signed
 * connection, shows that phone's fingerprint and name, and asks the person whether to approve it.
 * Typing the first four characters of that fingerprint approves, through the same store mutation
 * `remi authorize` uses; anything else rejects. The
 * code alone authorizes nothing.
 *
 * {@link pairFlow} is the flow, given its store and its terminal; {@link pairPreconditions} decides
 * whether the running hub is one a phone can reach and pair with; {@link runPairCommand} joins them
 * to the real terminal and files.
 */

import * as os from 'node:os';
import * as readline from 'node:readline';
import {
  PAIRING_CANDIDATE_HOSTS_MAX,
  PAIRING_NAME_MAX_CODE_POINTS,
  PROTOCOL_VERSION,
  type PairingCodeV1,
  type PairingCodeV2,
  classifyPairingHost,
  encodePairingLink,
  errorToString,
  escapeUnsafeText,
  isPairingCandidateHost,
  isPairingHost,
  isPlainPairingText,
  normalizePairingHost,
} from '@remi/shared';
import { renderUnicodeCompact } from 'uqr';
import { IdentityStore, PairingLimitError } from '../auth/identity-store.ts';
import { readHubStatus } from './daemon-manager.ts';
import { defaultMachineName } from './machine.ts';

/** What the flow needs: the store, the machine, where the phone connects, and the terminal. */
export interface PairFlowDeps {
  readonly store: Pick<
    IdentityStore,
    | 'createPairing'
    | 'peekPairing'
    | 'approvePairing'
    | 'rejectPairing'
    | 'cancelPairing'
    | 'isAuthorized'
  >;
  readonly machineKey: string;
  readonly machineFingerprint: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** The v1 default remains until the compatible native app is distributed. */
  readonly qrVersion?: 1 | 2;
  /** Candidate inventory for v2; one explicit `--host` passes a one-item list. */
  readonly hosts?: readonly string[];
  /** Other addresses the hub can be reached on, offered as `--host` choices. */
  readonly others?: readonly string[];
  readonly write: (text: string) => void;
  /** Asks a question; resolves with the answer, or null when the input closed. */
  readonly ask: (question: string) => Promise<string | null>;
  /** Stops the run: the code is cancelled, or the claim rejected. A numeric reason is the exit code. */
  readonly signal?: AbortSignal;
  /** The terminal's height, when known: a code taller than it comes with a hint. */
  readonly rows?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
}

/** A fingerprint in groups of four, as the app shows it. */
export function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp;
}

/** `host:port`, with an IPv6 address in brackets. */
function formatAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Select at most four eligible candidates. When both policy layers exist, reserve one of each,
 * fill in inventory order, then put all Local candidates before Tailscale candidates.
 */
export function selectPairingCandidates(hosts: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const host of hosts) {
    if (!isPairingCandidateHost(host)) continue;
    const identity = normalizePairingHost(host);
    if (identity === null || seen.has(identity)) continue;
    seen.add(identity);
    unique.push(host);
  }
  const local = unique.filter((host) => classifyPairingHost(host) === 'local');
  const tailscale = unique.filter((host) => classifyPairingHost(host) === 'tailscale');
  const selected: string[] = [];
  if (local[0] !== undefined && tailscale[0] !== undefined) {
    selected.push(local[0], tailscale[0]);
  } else if (local[0] !== undefined || tailscale[0] !== undefined) {
    selected.push((local[0] ?? tailscale[0]) as string);
  }
  for (const host of [...local, ...tailscale]) {
    if (selected.length >= PAIRING_CANDIDATE_HOSTS_MAX) break;
    if (
      !selected.some((candidate) => normalizePairingHost(candidate) === normalizePairingHost(host))
    ) {
      selected.push(host);
    }
  }
  return [
    ...selected.filter((host) => classifyPairingHost(host) === 'local'),
    ...selected.filter((host) => classifyPairingHost(host) === 'tailscale'),
  ];
}

/** The QR, white modules drawn on black, so it reads the same on a light or a dark terminal. */
function renderQr(link: string): string {
  return renderUnicodeCompact(link, { border: 2, ecc: 'L' })
    .split('\n')
    .map((row) => `  \x1b[97;40m${row}\x1b[0m`)
    .join('\n');
}

/** The exit code an abort asked for: its numeric reason, or 130 (Ctrl-C). */
function abortCode(signal: AbortSignal | undefined): number {
  return typeof signal?.reason === 'number' ? signal.reason : 130;
}

/**
 * Shows a code, waits for a claim, asks, and decides. Returns the exit code: 0 approved (or already
 * authorized), 1 rejected, expired or not shown, and an abort's own code (130 for Ctrl-C) when the
 * run was stopped, whether while waiting (the code is cancelled) or at the question (the phone is
 * rejected). Whatever ends the run, a code that was not decided stops working.
 */
export async function pairFlow(deps: PairFlowDeps): Promise<number> {
  const { store, write } = deps;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 300;
  const qrVersion = deps.qrVersion ?? 1;

  // Checked before a record exists, so a code that cannot be shown leaves nothing open.
  if (qrVersion !== 1 && qrVersion !== 2) {
    write('Choose pairing QR version 1 or 2.\n');
    return 1;
  }
  if (qrVersion === 1 && !isPairingHost(deps.host)) {
    write(
      `${escapeUnsafeText(deps.host)} cannot go in a pairing code. Choose an address with remi pair --host <address>.\n`,
    );
    return 1;
  }
  let flowDeps = deps;
  if (qrVersion === 2) {
    const availableHosts = deps.hosts ?? [deps.host, ...(deps.others ?? [])];
    if (availableHosts.some((host) => !isPairingCandidateHost(host))) {
      write('A candidate address cannot go in a version 2 pairing code.\n');
      return 1;
    }
    const selectedHosts = selectPairingCandidates(availableHosts);
    if (selectedHosts.length === 0) {
      write('Choose a phone-reachable address with remi pair --host <address>.\n');
      return 1;
    }
    const selectedIdentities = new Set(selectedHosts.map(normalizePairingHost));
    const remainingAddresses = deps.others?.filter(
      (host) => !selectedIdentities.has(normalizePairingHost(host)),
    );
    flowDeps = {
      ...deps,
      host: selectedHosts[0] as string,
      hosts: selectedHosts,
      qrVersion,
      ...(remainingAddresses !== undefined && { others: remainingAddresses }),
    };
  }
  if (!isPlainPairingText(deps.name, PAIRING_NAME_MAX_CODE_POINTS)) {
    write('The machine name cannot go in a pairing code.\n');
    return 1;
  }

  let created: ReturnType<typeof store.createPairing>;
  try {
    created = store.createPairing();
  } catch (err) {
    if (err instanceof PairingLimitError) {
      write(
        'Too many pairing codes are open or waiting on this machine. Finish or cancel one, or wait a few minutes.\n',
      );
      return 1;
    }
    throw err;
  }
  const { nonce, record } = created;
  try {
    return await showAndDecide(flowDeps, nonce, Date.parse(record.expiresAt), now, pollMs);
  } finally {
    // A decided code is left as decided (cancelling it does nothing); any other stops working.
    try {
      store.cancelPairing(nonce);
    } catch (err) {
      write(
        `\nCould not cancel the code (${escapeUnsafeText(errorToString(err))}); it expires on its own.\n`,
      );
    }
  }
}

async function showAndDecide(
  deps: PairFlowDeps,
  nonce: string,
  expiresAt: number,
  now: () => number,
  pollMs: number,
): Promise<number> {
  const { store, write, signal } = deps;
  const shared = {
    name: deps.name,
    port: deps.port,
    key: deps.machineKey,
    nonce,
    exp: Math.floor(expiresAt / 1000),
    proto: PROTOCOL_VERSION,
  };
  const code: PairingCodeV1 | PairingCodeV2 =
    deps.qrVersion === 2
      ? { ...shared, v: 2, hosts: deps.hosts ?? [deps.host] }
      : { ...shared, v: 1, host: deps.host };
  const link = encodePairingLink(code);
  const qr = renderQr(link);
  const expiry = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  write('\nScan this with the Remi app on your phone.\n');
  if (deps.rows !== undefined && qr.split('\n').length + 2 > deps.rows) {
    write('(Make this window taller if the code does not fit.)\n');
  }
  write(`\n${qr}\n\n`);
  write(`  Machine      ${escapeUnsafeText(deps.name)}\n`);
  write(`  Address      ${formatAddress(deps.host, deps.port)}\n`);
  if (deps.qrVersion === 2) {
    write(
      `  Candidates   ${(deps.hosts ?? [deps.host]).map((host) => formatAddress(host, deps.port)).join(', ')}\n`,
    );
  }
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

  let current: ReturnType<typeof store.peekPairing>;
  for (;;) {
    if (signal?.aborted) {
      write('\nCancelled; the code no longer works.\n');
      return abortCode(signal);
    }
    current = store.peekPairing(nonce);
    if (current?.state === 'claimed' && current.claim !== null) break;
    if (current === null || current.state !== 'open') {
      write('\nThe code was cancelled.\n');
      return 1;
    }
    if (now() >= expiresAt) {
      write('\nThe code expired before a phone used it. Run remi pair again.\n');
      if (current.queueFull > 0) {
        write(
          `${current.queueFull} attempt(s) to use it were refused because too many unknown devices are waiting for approval; remi keys lists them.\n`,
        );
      }
      return 1;
    }
    await Bun.sleep(pollMs);
  }

  const { claim } = current;
  write('\nA device wants to pair:\n');
  write(`  Name         ${escapeUnsafeText(claim.label)}\n`);
  write(`  Fingerprint  ${formatFingerprint(claim.fingerprint)}\n`);
  write('Approve only if the app on your phone shows this same fingerprint.\n');
  if (current.contested > 0 && current.lastContender !== null) {
    write(
      `Warning: ${current.contested} other device(s) also tried this code, the last ${formatFingerprint(current.lastContender)}. If the fingerprint above is not your phone's, answer no.\n`,
    );
  }
  // Approving takes the fingerprint's first four characters, not a y: they cannot be typed before
  // the fingerprint is known, and typing them means reading it (#1281 review).
  const answer = signal?.aborted
    ? null
    : await deps.ask(
        'Approve this device? Type the first four characters of its fingerprint to approve; Enter rejects: ',
      );
  const approves = answer?.trim().toLowerCase() === claim.fingerprint.slice(0, 4);
  if (approves && !signal?.aborted) {
    try {
      await store.approvePairing(nonce, claim.fingerprint);
    } catch (err) {
      if (store.isAuthorized(claim.publicKey, claim.fingerprint)) {
        write('\nThis device is already authorized (remi keys lists it); it can connect.\n');
        return 0;
      }
      write(`\nCould not approve it: ${escapeUnsafeText(errorToString(err))}\n`);
      return 1;
    }
    write(
      `\nApproved. ${escapeUnsafeText(claim.label)} can connect now; the app continues on its own.\n`,
    );
    return 0;
  }
  store.rejectPairing(nonce);
  write('\nRejected; the phone was not approved.\n');
  return signal?.aborted ? abortCode(signal) : 1;
}

/**
 * The host as URL parsing normalizes it (lowercase, IPv6 compressed, IPv4 shorthand expanded), with
 * a DNS name's trailing dot removed.
 */
function canonicalHost(host: string): string | null {
  try {
    const name = new URL(host.includes(':') ? `http://[${host}]/` : `http://${host}/`).hostname;
    const bare = name.startsWith('[') ? name.slice(1, -1) : name;
    return bare.endsWith('.') ? bare.slice(0, -1) : bare;
  } catch {
    return null;
  }
}

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Loopback in any spelling: localhost, 127.0.0.0/8, ::1, and IPv4-mapped 127.x. */
export function isLoopbackHost(host: string): boolean {
  const h = canonicalHost(host);
  if (h === null) return false;
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    IPV4_LOOPBACK.test(h) ||
    h === '::1' ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)
  );
}

/** Link-local (169.254.0.0/16, fe80::/10): it changes with every network, so no code can name it. */
function isLinkLocalHost(host: string): boolean {
  const h = canonicalHost(host);
  if (h === null) return false;
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** The unspecified address, which a hub binds as "every interface" and no phone can dial. */
function isUnspecifiedHost(host: string): boolean {
  const h = canonicalHost(host);
  return h === '0.0.0.0' || h === '::' || h === '::ffff:0:0';
}

/** Interfaces of virtual machines and containers: reachable from this machine, rarely a phone. */
const VIRTUAL_INTERFACE = /^(bridge|docker|br-|vmnet|vboxnet|veth|virbr|lxc|lxd|cni|podman|vnic)/;

/** Addresses on the actual listener family, ranked for local selection; never unsafe targets. */
export function pairingHosts(
  bind: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  if (bind !== '' && !isUnspecifiedHost(bind)) return [bind];
  const rank = (name: string, address: string): number => {
    if (classifyPairingHost(address) === 'tailscale') return 1;
    if (VIRTUAL_INTERFACE.test(name)) return 3;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) return 0;
    if (/^f[cd][0-9a-f]{2}:/i.test(address)) return 0;
    return 2;
  };
  const found: { address: string; rank: number; order: number }[] = [];
  const expectedFamily = bind === '' ? undefined : bind.includes(':') ? 'IPv6' : 'IPv4';
  const seen = new Set<string>();
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      const ipv4 = info.family === 'IPv4' || (info.family as unknown) === 4;
      const ipv6 = info.family === 'IPv6' || (info.family as unknown) === 6;
      const family = ipv4 ? 'IPv4' : ipv6 ? 'IPv6' : undefined;
      if (
        info.internal ||
        family === undefined ||
        (expectedFamily !== undefined && family !== expectedFamily) ||
        !isPairingCandidateHost(info.address)
      ) {
        continue;
      }
      const identity = normalizePairingHost(info.address);
      if (identity === null || seen.has(identity)) continue;
      seen.add(identity);
      found.push({ address: info.address, rank: rank(name, info.address), order: found.length });
    }
  }
  return found.sort((a, b) => a.rank - b.rank || a.order - b.order).map((entry) => entry.address);
}

/**
 * Whether the running hub can be paired with, and where a phone should connect. Refuses, each with
 * what to do: no hub; a hub too old to say how it is bound; authentication off; a loopback bind
 * (no phone could reach it); a bind a code cannot carry; no address to show; and a `--host` that is
 * not an address or that no phone could dial (loopback, unspecified).
 */
export function pairPreconditions(
  status: { port: number; bind?: string; auth?: boolean; directTls?: true } | null,
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
  if (status.directTls) {
    return {
      ok: false,
      message:
        'Direct QR pairing is unavailable while this hub uses TLS. Secure endpoint pairing support is pending.',
    };
  }
  if (status.bind === undefined || status.auth === undefined) {
    return {
      ok: false,
      message:
        'The running hub does not say how it is bound yet. If it just started, run remi pair again in a moment; if not, it is older than remi pair: restart it (`remi stop`, then `remi start`) and run remi pair again.',
    };
  }
  if (!status.auth) {
    return {
      ok: false,
      message:
        'This hub runs with authentication off, so pairing would approve nothing. Turn it on (remove `--no-auth` or `auth.enabled = false`), restart the hub, and run remi pair again.',
    };
  }
  if (isLoopbackHost(status.bind) || isLinkLocalHost(status.bind)) {
    return {
      ok: false,
      message: `This hub listens on ${escapeUnsafeText(status.bind)} only, which a phone cannot reach. Set \`daemon.bind\` in ~/.remi/config.toml to "0.0.0.0" or to your LAN or VPN address, restart the hub, and run remi pair again. (An SSH tunnel needs no pairing code: use remi keys and remi authorize.)`,
    };
  }
  const hosts = pairingHosts(status.bind, interfaces).filter(isPairingCandidateHost);
  if (requestedHost !== undefined) {
    if (!isPairingHost(requestedHost)) {
      return {
        ok: false,
        message: `--host ${escapeUnsafeText(requestedHost)} is not an IP address or a host name.`,
      };
    }
    if (!isPairingCandidateHost(requestedHost)) {
      return {
        ok: false,
        message: `--host ${escapeUnsafeText(requestedHost)} is not an address a phone can reach. Use this machine's LAN or VPN address.`,
      };
    }
    const requestedIdentity = normalizePairingHost(requestedHost);
    return {
      ok: true,
      host: requestedHost,
      port: status.port,
      others: hosts.filter((host) => normalizePairingHost(host) !== requestedIdentity),
    };
  }
  const [host, ...others] = hosts;
  if (host === undefined) {
    return {
      ok: false,
      message: `No address to show was found for a hub bound to ${escapeUnsafeText(status.bind)}. Choose one with remi pair --host <address>.`,
    };
  }
  return { ok: true, host, port: status.port, others };
}

/**
 * What `remi pair` says when its store fails. Only an error about the pairing records gets the way
 * out (delete the file, which holds only pairing codes); a lock held too long or anything else is
 * shown as it is.
 */
export function storeErrorMessage(err: unknown, pairingsFile: string): string {
  const text = errorToString(err);
  const lines = [`remi pair stopped: ${escapeUnsafeText(text)}`];
  if (/pairings/i.test(text)) {
    lines.push(
      `To start over, delete ${pairingsFile} and run remi pair again; it holds only pairing codes, never keys.`,
    );
  }
  return lines.join('\n');
}

/** Exit codes for the signals that stop `remi pair`: 128 plus the signal number. */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
/** How long the terminal is drained before the question: long enough to read what it holds. */
const TYPE_AHEAD_GRACE_MS = 300;

/** `remi pair [--host <address>]`: the flow on the real terminal, hub status and identity store. */
export async function runPairCommand(flags: { host?: string; qrVersion?: 1 | 2 }): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'remi pair needs an interactive terminal: it shows a QR code and asks you to approve the phone. Without one, use remi keys and remi authorize <fingerprint>.',
    );
    return 2;
  }
  let hub: ReturnType<typeof readHubStatus>;
  try {
    hub = readHubStatus();
  } catch {
    console.error('Local daemon endpoint unavailable.');
    return 1;
  }
  const checked = pairPreconditions(hub, flags.host, os.networkInterfaces());
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
  let terminal: readline.Interface | null = null;
  const stop = (code: number) => {
    if (!controller.signal.aborted) controller.abort(code);
    terminal?.close();
  };
  const handlers = Object.entries(SIGNAL_EXIT_CODES).map(([name, code]) => {
    const handler = () => stop(code);
    process.on(name, handler);
    return [name, handler] as const;
  });

  /**
   * The terminal is read only once the question is due: until then a keystroke stays in the
   * terminal. What it holds by then (a stray `y`, a whole line) was typed before the person saw the
   * fingerprint, so it is read in raw mode, partial line included, and dropped; Ctrl-C among it
   * still counts. Only then does readline ask.
   */
  const ask = async (question: string): Promise<string | null> => {
    const input = process.stdin;
    const drain = (chunk: Buffer) => {
      if (chunk.includes(0x03)) stop(SIGNAL_EXIT_CODES.SIGINT);
    };
    input.setRawMode(true);
    input.on('data', drain);
    input.resume();
    try {
      await Bun.sleep(TYPE_AHEAD_GRACE_MS);
    } finally {
      input.off('data', drain);
      input.pause();
      input.setRawMode(false);
    }
    if (controller.signal.aborted) return null;
    const rl = readline.createInterface({ input, output: process.stdout });
    terminal = rl;
    // Bun's readline types omit the EventEmitter methods the runtime has.
    const events = rl as unknown as NodeJS.EventEmitter;
    const closed = new Promise<null>((resolve) => events.once('close', () => resolve(null)));
    // Ctrl-C at the question is a no, with Ctrl-C's exit code.
    events.on('SIGINT', () => stop(SIGNAL_EXIT_CODES.SIGINT));
    return Promise.race([new Promise<string>((resolve) => rl.question(question, resolve)), closed]);
  };

  try {
    return await pairFlow({
      store,
      machineKey: identity.publicKey,
      machineFingerprint: identity.fingerprint,
      name: defaultMachineName(),
      host: checked.host,
      port: checked.port,
      qrVersion: flags.qrVersion ?? 1,
      ...(flags.qrVersion === 2 && {
        hosts: flags.host === undefined ? [checked.host, ...checked.others] : [checked.host],
      }),
      others: checked.others,
      write: (text) => process.stdout.write(text),
      ask,
      signal: controller.signal,
      ...(process.stdout.rows !== undefined && { rows: process.stdout.rows }),
    });
  } catch (err) {
    console.error(`\n${storeErrorMessage(err, store.pairingsFile)}`);
    return 1;
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
    (terminal as readline.Interface | null)?.close();
  }
}
