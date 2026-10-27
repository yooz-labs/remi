/** The hub owns the provider credential; sessions submit sealed events and recipient/runtime metadata. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relayV2 as r } from '@remi/shared';
import { resolveDaemonWsTarget } from '../cli/daemon-target.ts';
import { isProcessAlive } from '../session/process-alive.ts';
import type { SessionRegistryFile } from '../session/session-registry-file.ts';
import { isAuthorityEpoch } from '../storage/authority-epoch.ts';
import { normalizeSecureRegistration } from '../storage/secure-push-subscriptions.ts';
import type { SecurePushRuntime } from './secure-push-contexts.ts';
import type { SecurePushSnapshot, SecurePushStore } from './secure-push-store.ts';
import { readPushSubmitResultResponse } from './secure-push-transport.ts';

export const LOCAL_PUSH_PATH = '/local-secure-push';
const MAX_BODY = 16 * 1024;
type Submission = {
  v: 1;
  sessionId: string;
  runtimeInstance: string;
  pid: number;
  port: number;
  startedAt: string;
  snapshot: SecurePushSnapshot;
  submit: string;
};
export interface LocalPushForwardOptions {
  readonly subscriptions: SecurePushStore;
  readonly registry: SessionRegistryFile;
  readonly audience: string;
  readonly rid: string;
  readonly machinePublicKey: string;
  readonly pushSecret: string;
  readonly log?: (
    outcome:
      | 'accepted'
      | 'rejected'
      | 'uncertain'
      | 'runtime_refused'
      | 'authority_refused'
      | 'invalid',
  ) => void;
}
const ownedOrigins = new WeakMap<LocalPushForwardOptions, string>();

async function body(req: Request): Promise<string> {
  if (!req.body) throw new Error('LOCAL_PUSH_INVALID');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('LOCAL_PUSH_BODY_DEADLINE')), 2000);
  });
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), deadline]);
      if (item.done) break;
      length += item.value.length;
      if (length > MAX_BODY) throw new Error('LOCAL_PUSH_OVERSIZE');
      chunks.push(item.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function decode(text: string): Submission {
  const value = JSON.parse(text) as Record<string, unknown>;
  const keys = [
    'v',
    'sessionId',
    'runtimeInstance',
    'pid',
    'port',
    'startedAt',
    'snapshot',
    'submit',
  ];
  if (!value || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value)))
    throw new Error('LOCAL_PUSH_INVALID');
  const { v, sessionId, runtimeInstance, pid, port, startedAt, snapshot, submit } = value;
  if (
    v !== 1 ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    sessionId.length > 200 ||
    !isAuthorityEpoch(runtimeInstance) ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof startedAt !== 'string' ||
    !Number.isFinite(Date.parse(startedAt)) ||
    typeof submit !== 'string' ||
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot)
  )
    throw new Error('LOCAL_PUSH_INVALID');
  const row = snapshot as Record<string, unknown>;
  const { publicKey, fingerprint, authorizationEpoch, enrollmentEpoch, subscriptionEpoch } = row;
  const allowed = [
    'publicKey',
    'fingerprint',
    'authorizationEpoch',
    'enrollmentEpoch',
    'subscriptionEpoch',
    'token',
    'environment',
    'pushPublicKey',
    'keyVersion',
    'pushPrefs',
  ];
  if (
    Object.keys(row).some((key) => !allowed.includes(key)) ||
    typeof publicKey !== 'string' ||
    Buffer.from(publicKey, 'base64').length !== 32 ||
    Buffer.from(publicKey, 'base64').toString('base64') !== publicKey ||
    typeof fingerprint !== 'string' ||
    !/^[0-9a-f]{16}$/.test(fingerprint) ||
    !isAuthorityEpoch(authorizationEpoch) ||
    !isAuthorityEpoch(enrollmentEpoch) ||
    !isAuthorityEpoch(subscriptionEpoch)
  )
    throw new Error('LOCAL_PUSH_INVALID');
  const { token, environment, pushPublicKey, keyVersion, pushPrefs } = row;
  const registration = normalizeSecureRegistration({
    token,
    environment,
    pushPublicKey,
    keyVersion,
    ...(pushPrefs === undefined ? {} : { pushPrefs }),
  });
  return {
    v,
    sessionId,
    runtimeInstance,
    pid,
    port,
    startedAt,
    submit,
    snapshot: Object.freeze({
      ...registration,
      publicKey,
      fingerprint,
      authorizationEpoch,
      enrollmentEpoch,
      subscriptionEpoch,
    }),
  };
}

/** This is a machine-user capability boundary, not kernel-authenticated process identity.
 * Runtime metadata is checked against the private live registry immediately before forwarding. */
export class LocalPushForwardService {
  private pending = 0;
  private readonly authorization: string;
  constructor(private readonly options: LocalPushForwardOptions) {
    const url = new URL(options.audience);
    if (
      url.origin !== options.audience ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          ownedOrigins.get(options) === url.origin
        ))
    )
      throw new Error('LOCAL_PUSH_AUDIENCE');
    const secret = options.pushSecret.trim();
    if (!secret || !/^[\x21-\x7e ]+$/.test(secret)) throw new Error('LOCAL_PUSH_SECRET');
    this.authorization = `Bearer ${secret}`;
  }
  static forOwnedLoopbackTest(
    options: LocalPushForwardOptions & { ownedOrigin: string },
  ): LocalPushForwardService {
    const url = new URL(options.ownedOrigin);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.origin !== options.audience ||
      url.origin !== options.ownedOrigin
    )
      throw new Error('LOCAL_PUSH_AUDIENCE');
    const copy = { ...options };
    ownedOrigins.set(copy, url.origin);
    try {
      return new LocalPushForwardService(copy);
    } finally {
      ownedOrigins.delete(copy);
    }
  }
  private report(outcome: Parameters<NonNullable<LocalPushForwardOptions['log']>>[0]): void {
    try {
      this.options.log?.(outcome);
    } catch {
      /* diagnostics never change delivery */
    }
  }
  private runtime(value: Submission): boolean {
    const entry = this.options.registry.listLive().find((row) => row.sessionId === value.sessionId);
    return (
      !!entry &&
      entry.pid === value.pid &&
      entry.wsPort === value.port &&
      entry.startedAt === value.startedAt &&
      entry.notificationRuntime === value.runtimeInstance
    );
  }
  async handle(req: Request): Promise<Response> {
    const response = (status: number, result: r.PushSubmitResult) =>
      new Response(r.encodePushSubmitResult(result), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    let digest: string | null = null;
    const rejected = (reason: r.PushRejectReason) =>
      response(409, { v: 2, requestDigest: digest, outcome: 'rejected', reason, retryable: false });
    if (this.pending >= 64) return rejected('CAPACITY');
    this.pending++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let invoked = false;
    try {
      const value = decode(await body(req));
      const submit = r.decodePushSubmit(value.submit);
      if (
        submit.machinePublicKey !== this.options.machinePublicKey ||
        submit.token !== value.snapshot.token ||
        submit.environment !== value.snapshot.environment ||
        submit.devicePublicKey !==
          Buffer.from(value.snapshot.publicKey, 'base64').toString('base64url')
      )
        return rejected('UNAUTHORIZED');
      digest = (
        await r.verifyPushSubmit(
          submit,
          { audience: this.options.audience, rid: this.options.rid },
          Math.floor(Date.now() / 1000),
        )
      ).requestDigest;
      if (req.signal.aborted || Date.now() >= submit.expiresAt * 1000) return rejected('EXPIRED');
      const effect = this.options.subscriptions.withCurrentSubscription(value.snapshot, () => {
        if (!this.runtime(value)) {
          this.report('runtime_refused');
          return null;
        }
        if (req.signal.aborted || Date.now() >= submit.expiresAt * 1000) return null;
        timer = setTimeout(abort, Math.min(8000, submit.expiresAt * 1000 - Date.now()));
        invoked = true;
        return fetch(`${this.options.audience}/v2/push/${this.options.rid}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: this.authorization },
          body: value.submit,
          signal: controller.signal,
          redirect: 'error',
        });
      });
      if (!effect) {
        this.report('authority_refused');
        return rejected('UNAUTHORIZED');
      }
      const provider = await effect;
      const result = await readPushSubmitResultResponse(provider);
      if (result.requestDigest !== digest) throw new Error('LOCAL_PUSH_UNCERTAIN');
      this.report(result.outcome);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const after = provider.headers.get('retry-after');
      if (after && /^[0-9]{1,2}$/.test(after)) headers['retry-after'] = after;
      return new Response(r.encodePushSubmitResult(result), { status: provider.status, headers });
    } catch {
      if (invoked && digest) {
        this.report('uncertain');
        return response(200, { v: 2, requestDigest: digest, outcome: 'uncertain' });
      }
      if (digest) {
        this.report('authority_refused');
        return response(503, {
          v: 2,
          requestDigest: digest,
          outcome: 'rejected',
          reason: 'STORE_ERROR',
          retryable: true,
        });
      }
      this.report('invalid');
      return rejected('MALFORMED');
    } finally {
      clearTimeout(timer);
      controller.abort();
      req.signal.removeEventListener('abort', abort);
      this.pending--;
    }
  }
}

/** Invoked synchronously within the session transport's final subscription lock. */
export function localHubPushForwarder(options: {
  directory: string;
  registry: SessionRegistryFile;
  runtime: () => SecurePushRuntime | undefined;
  port: () => number;
}) {
  return (
    submit: string,
    snapshot: SecurePushSnapshot,
    signal: AbortSignal,
  ): Promise<Response> | null => {
    try {
      const runtime = options.runtime();
      if (!runtime) return null;
      const entry = options.registry.listLive().find((row) => row.sessionId === runtime.sessionId);
      if (
        !entry ||
        entry.pid !== process.pid ||
        entry.wsPort !== options.port() ||
        entry.notificationRuntime !== runtime.instance
      )
        return null;
      const hub = JSON.parse(readFileSync(join(options.directory, 'daemon-status.json'), 'utf8'));
      if (
        hub.mode !== 'hub' ||
        !Number.isSafeInteger(hub.pid) ||
        !isProcessAlive(hub.pid) ||
        !Number.isInteger(hub.wsPort) ||
        hub.wsPort < 1 ||
        hub.wsPort > 65535
      )
        return null;
      const target = resolveDaemonWsTarget('127.0.0.1', hub.wsPort, {
        home: options.directory,
        expectedPid: hub.pid,
      });
      if (!target.options) return null;
      const url = new URL(target.url);
      url.protocol = 'http:';
      url.pathname = LOCAL_PUSH_PATH;
      const encoded = JSON.stringify({
        v: 1,
        sessionId: runtime.sessionId,
        runtimeInstance: runtime.instance,
        pid: entry.pid,
        port: entry.wsPort,
        startedAt: entry.startedAt,
        snapshot,
        submit,
      });
      if (Buffer.byteLength(encoded) > MAX_BODY) return null;
      return fetch(url, {
        method: 'POST',
        headers: { ...target.options.headers, 'content-type': 'application/json' },
        body: encoded,
        signal,
        redirect: 'error',
      });
    } catch {
      return null;
    }
  };
}
