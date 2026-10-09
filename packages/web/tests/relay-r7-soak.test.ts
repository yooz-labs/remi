/** R7: real wall time, source CLI hub/PTY child, shipping client, local workerd only. */
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ProtocolMessage,
  createAnswer,
  createHello,
  createSessionListRequest,
  generateId,
  relayV2,
} from '@remi/shared';
import { Mailbox, hex, roomSeen, roomState } from '../../signaling/tests/e2e/endpoints';
import { RelayMachineChannel } from '../src/lib/relay-machine-channel';
import { type RelayAnswerStatus, RelayRequests } from '../src/lib/relay-requests';
import {
  ownedRelayChild,
  ownedRelayOffer,
  registerOwnedRelayFixtureCleanup,
} from './helpers/relay-hub';

const MIN_ATTACHED_MS = 3_660_000;
const PROBE_INTERVAL_MS = 60_000;
const REPLY_MS = 10_000;
const soak = process.env['REMI_RELAY_R7_SOAK'] === '1' ? test : test.skip;
registerOwnedRelayFixtureCleanup();

soak(
  'R7 keeps the same attached real child and client alive for 61 wall-clock minutes',
  async () => {
    const local = await ownedRelayOffer();
    const child = await ownedRelayChild(local.running);
    const ready = new Mailbox<boolean>();
    const answers = new Mailbox<RelayAnswerStatus>();
    const errors: string[] = [];
    const waiters = new Set<{
      accept(message: ProtocolMessage): void;
      reject(error: Error): void;
    }>();
    let closing = false;
    let rejectLifetime: (error: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      rejectLifetime = reject;
    });
    // A setup failure may arrive before the first race is installed.
    void failed.catch(() => undefined);
    const fail = (error: Error) => {
      if (closing) return;
      errors.push(error.message);
      rejectLifetime(error);
      for (const waiter of waiters) waiter.reject(error);
    };
    const receive = <T extends ProtocolMessage['type']>(
      type: T,
      matches: (message: Extract<ProtocolMessage, { type: T }>) => boolean = () => true,
    ): Promise<Extract<ProtocolMessage, { type: T }>> => {
      const promise = new Promise<Extract<ProtocolMessage, { type: T }>>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(waiter);
        };
        const waiter = {
          accept(message: ProtocolMessage) {
            if (message.type !== type) return;
            const typed = message as Extract<ProtocolMessage, { type: T }>;
            if (!matches(typed)) return;
            finish();
            resolve(typed);
          },
          reject(error: Error) {
            finish();
            reject(error);
          },
        };
        const timer = setTimeout(
          () => waiter.reject(new Error(`No correlated ${type} within 10s`)),
          REPLY_MS,
        );
        waiters.add(waiter);
      });
      void promise.catch(() => undefined);
      return promise;
    };
    const { signer } = await relayV2.generateIdentity();
    const tokenText = String(local.offer['token']);
    const token = await relayV2.decodePairingToken(tokenText, Math.floor(Date.now() / 1000));
    const privateNeedles = [
      Buffer.from(token.secret),
      Buffer.from(hex(token.secret)),
      Buffer.from(relayV2.b64u(token.secret)),
      Buffer.from(Buffer.from(token.secret).toString('base64')),
    ];
    token.secret.fill(0);
    const rid = hex(await relayV2.ridOf(token.machinePublicKey));
    let requests: RelayRequests | undefined;
    const client = await RelayMachineChannel.pair(tokenText, signer, () => !closing, {
      onPhase: (phase) => {
        if (phase === 'connected') ready.push(true);
      },
      onMessage: (message) => {
        requests?.receive(message);
        for (const waiter of [...waiters]) waiter.accept(message);
        // Unrelated broadcasts are consumed here, not retained for 61 minutes.
      },
      onError: fail,
      onClose: () => fail(new Error('The original relay client closed during the soak')),
    });
    requests = new RelayRequests(
      (message) => client.send(message),
      (status) => answers.push(status),
    );
    let started = 0;
    let probes = 0;
    let observedBinaryFrames = 0;
    let observedBytes = 0;
    let maxReplyMs = 0;
    const boots = new Map<string, number>();
    const registry = join(local.running.dir, 'state/live-sessions');
    const liveChild = () => {
      const row = readdirSync(registry)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(registry, name), 'utf8')))
        .find((entry) => entry.sessionId === child.entry.sessionId);
      expect(row?.pid).toBe(child.child.pid);
      expect(child.child.exitCode).toBeNull();
      expect(local.running.proc.exitCode).toBeNull();
      expect(client.connected).toBe(true);
      expect(() => process.kill(row.claudeChildPid, 0)).not.toThrow();
      return row as { claudeChildPid: number };
    };
    const sample = async () => {
      const state = await roomState(local.running.worker, rid);
      expect(state.skewMs).toBe(0);
      expect(state.sockets.filter((socket) => socket?.st === 'open')).toHaveLength(2);
      const seen = await roomSeen(local.running.worker, rid);
      expect(seen.some((frame) => frame.kind === 'binary')).toBe(true);
      const storage = Buffer.from(JSON.stringify(state.storage));
      for (const needle of privateNeedles) expect(storage.includes(needle)).toBe(false);
      const previous = boots.get(state.boot) ?? 0;
      for (const frame of seen.slice(previous)) {
        const bytes = Buffer.from(frame.bytes, 'base64');
        for (const needle of privateNeedles) expect(bytes.includes(needle)).toBe(false);
        observedBytes += bytes.length;
        if (frame.kind === 'binary') {
          expect([relayV2.TYPE_DATA, relayV2.TYPE_BYE]).toContain(bytes[0]);
          ++observedBinaryFrames;
        }
      }
      // The tap resets at every natural reconstruction. These are observed lower
      // bounds, not a complete traffic meter or Cloudflare billable-event count.
      boots.set(state.boot, seen.length);
    };
    try {
      await client.start();
      const compare = await local.inbox.next(REPLY_MS);
      expect(compare['t']).toBe('compare');
      local.ws.send(
        JSON.stringify({
          t: 'confirm',
          id: local.offer['id'],
          offerId: local.offer['offerId'],
          connectionId: compare['connectionId'],
          fingerprint: compare['fingerprint'],
          accept: true,
        }),
      );
      expect(await ready.next(REPLY_MS)).toBe(true);
      const machineHello = receive('hello_ack', (message) => message.sessionId === null);
      expect(client.send(createHello('owned-r7', '2'))).toBe(true);
      await machineHello;
      const attachedPromise = receive(
        'hello_ack',
        (message) => message.sessionId === child.entry.sessionId,
      );
      expect(
        client.send(createHello('owned-r7', '2', { resumeSessionId: child.entry.sessionId })),
      ).toBe(true);
      const attached = await attachedPromise;
      expect(attached.attachState).toBe('attached');
      expect(typeof attached.claudeSessionId).toBe('string');
      expect(typeof attached.transcriptPath).toBe('string');
      started = performance.now();
      const originalPtyPid = liveChild().claudeChildPid;
      expect(Number.isSafeInteger(originalPtyPid) && originalPtyPid > 1).toBe(true);
      console.log(
        'R7_STAGE attached',
        JSON.stringify({
          childPid: child.child.pid,
          originalPtyPid,
          sessionId: child.entry.sessionId,
          bun: Bun.version,
          minimumMs: MIN_ATTACHED_MS,
        }),
      );
      const deny = async (label: string) => {
        const command = `R7_PRIVATE_NEVER_RUN_${label}_${generateId()}`;
        privateNeedles.push(Buffer.from(command));
        const questionPromise = receive(
          'question',
          (message) => message.sessionId === child.entry.sessionId,
        );
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 15000);
        const hook = fetch(`http://127.0.0.1:${child.entry.hookPort}/hooks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({
            hook_event_name: 'PermissionRequest',
            session_id: attached.claudeSessionId,
            transcript_path: attached.transcriptPath,
            cwd: local.running.dir,
            permission_mode: 'default',
            tool_name: 'Bash',
            tool_input: { command },
          }),
        });
        void hook.catch(() => undefined);
        try {
          const question = await questionPromise;
          expect(JSON.stringify(question.question)).toContain(command);
          const no = question.question.options.find((option) => option.isNo);
          if (!no) throw new Error('The actual held card omitted its deny option');
          const answer = createAnswer(
            child.entry.sessionId,
            question.question.id,
            no.value,
            attached.claudeSessionId ?? undefined,
          );
          expect(requests?.answer(answer)).toBe(true);
          expect(await answers.next(REPLY_MS)).toEqual({
            requestId: answer.id,
            sessionId: child.entry.sessionId,
            questionId: question.question.id,
            outcome: 'delivered',
          });
          const response = await hook;
          expect(response.ok).toBe(true);
          expect((await response.json()).hookSpecificOutput.decision.behavior).toBe('deny');
          console.log(`R7_STAGE held-hook-${label}-denied`);
        } finally {
          clearTimeout(timeout);
          abort.abort();
        }
      };
      const probe = async () => {
        expect(liveChild().claudeChildPid).toBe(originalPtyPid);
        const request = createSessionListRequest();
        const reply = receive(
          'session_list_response',
          (message) => message.requestId === request.id,
        );
        const sent = performance.now();
        expect(client.send(request)).toBe(true);
        const response = await reply;
        const elapsed = performance.now() - sent;
        expect(elapsed).toBeLessThanOrEqual(REPLY_MS);
        expect(
          response.sessions.some((session) => session.sessionId === child.entry.sessionId),
        ).toBe(true);
        maxReplyMs = Math.max(maxReplyMs, elapsed);
        ++probes;
        await sample();
        console.log(
          'R7_STAGE probe',
          JSON.stringify({
            probes,
            elapsedMs: performance.now() - started,
            replyMs: elapsed,
            roomBoots: boots.size,
            observedBinaryFrames,
            observedBytes,
          }),
        );
      };
      await deny('early');
      await probe();
      let nextProbe = started + PROBE_INTERVAL_MS;
      while (performance.now() - started < MIN_ATTACHED_MS) {
        await Promise.race([
          Bun.sleep(
            Math.max(0, Math.min(nextProbe, started + MIN_ATTACHED_MS) - performance.now()),
          ),
          failed,
        ]);
        await probe();
        nextProbe += PROBE_INTERVAL_MS;
      }
      expect(performance.now() - started).toBeGreaterThanOrEqual(MIN_ATTACHED_MS);
      await deny('aged');
      await sample();
      expect(liveChild().claudeChildPid).toBe(originalPtyPid);
      expect(probes).toBeGreaterThanOrEqual(Math.floor(MIN_ATTACHED_MS / PROBE_INTERVAL_MS) + 1);
      expect(boots.size).toBeGreaterThan(1);
      expect(observedBinaryFrames).toBeGreaterThanOrEqual(probes * 2);
      expect(errors).toEqual([]);
      console.log(
        'R7_COMPLETE',
        JSON.stringify({
          elapsedMs: performance.now() - started,
          probes,
          maxReplyMs,
          roomBoots: boots.size,
          observedBinaryFrames,
          observedBytes,
          heldDenials: 2,
        }),
      );
    } catch (error) {
      console.error('R7_FAILED', error);
      throw error;
    } finally {
      closing = true;
      for (const waiter of waiters) waiter.reject(new Error('Owned soak lifetime ended'));
      requests.closed();
      await client.close();
    }
  },
  4_500_000,
);
