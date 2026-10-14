/**
 * The ordinary controls construct the real client without starting it.
 * Opt-in interoperability uses the installed native Codex server in an empty,
 * file-only profile, verifies account=null before any turn, and never loads
 * the owner's profile. No provider completion or permission enforcement claim.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AppServerClient } from '../../../src/harness/codex/app-server-client.ts';
import {
  CODEX_CHAT_TEXT_BYTES,
  CodexTextWriter,
} from '../../../src/harness/codex/codex-text-writer.ts';
import { connectUnixWebSocket } from '../../../src/harness/codex/unix-ws.ts';

const threadId = '019ce646-7665-7bc3-b088-7db14760ca89';
const input = () => ({ id: crypto.randomUUID(), threadId, text: 'A short remote message' });

describe('CodexTextWriter local refusal', () => {
  function idle() {
    const client = new AppServerClient(
      {
        socketPath: () => '/nonexistent/remi-codex-test.sock',
        clientInfo: { name: 'remi', title: null, version: 'test' },
      },
      () => {},
    );
    const writer = new CodexTextWriter({
      client,
      current: () => ({ threadId, epoch: client }),
      blocked: () => false,
    });
    return { client, writer };
  }

  test('a real unstarted client refuses delivery, and close remains terminal', async () => {
    const { client, writer } = idle();
    expect(await writer.send(input(), () => true)).toEqual({
      outcome: 'refused',
      code: 'unavailable',
    });
    writer.close();
    expect(await writer.send(input(), () => true)).toEqual({
      outcome: 'refused',
      code: 'unavailable',
    });
    expect(client.state).toBe('idle');
    client.stop();
  });

  test('invalid UUIDs, empty text, NUL, invalid Unicode and oversized UTF-8 fail before any connection', async () => {
    const { client, writer } = idle();
    for (const request of [
      { ...input(), id: 'not-a-uuid' },
      { ...input(), threadId: threadId.toUpperCase() },
      { ...input(), text: ' \n\t' },
      { ...input(), text: 'before\0after' },
      { ...input(), text: '\ud800' },
      { ...input(), text: 'x'.repeat(CODEX_CHAT_TEXT_BYTES + 1) },
      { ...input(), text: '界'.repeat(Math.floor(CODEX_CHAT_TEXT_BYTES / 3) + 1) },
    ]) {
      expect(await writer.send(request, () => true)).toEqual({
        outcome: 'refused',
        code: 'malformed',
      });
    }
    expect(client.state).toBe('idle');
    client.stop();
  });
});

const cli = process.env['REMI_CODEX_ACCOUNTLESS_CLI'];
const live = cli ? test : test.skip;

live(
  'installed accountless Codex admits exact start/steer and retains authority boundaries',
  async () => {
    if (!cli || !isAbsolute(cli))
      throw new Error('REMI_CODEX_ACCOUNTLESS_CLI must be an absolute native Codex path');
    const root = mkdtempSync(join(tmpdir(), 'cdx-w-'));
    chmodSync(root, 0o700);
    const home = join(root, 'home');
    const state = join(root, 'state');
    const cwd = join(root, 'project');
    const socket = join(root, 's');
    for (const dir of [home, state, cwd]) mkdirSync(dir, { mode: 0o700 });
    if (Buffer.byteLength(socket) > 100) {
      rmSync(root, { recursive: true });
      throw new Error('Use a shorter canonical TMPDIR for the Unix socket');
    }
    writeFileSync(
      join(state, 'config.toml'),
      'cli_auth_credentials_store = "file"\nsandbox_mode = "danger-full-access"\napproval_policy = "on-request"\n',
      { mode: 0o600 },
    );
    // Deliberate whitelist: no inherited account/provider token, owner HOME, or Codex config.
    const child = Bun.spawn(
      [cli, 'app-server', '--strict-config', '--listen', `unix://${socket}`],
      {
        cwd,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          CODEX_HOME: state,
          TMPDIR: root,
          LANG: 'en_US.UTF-8',
        },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    const receipt = {
      binarySha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
      pid: child.pid,
      accountPresent: true,
      modelCompletion: false,
      reaped: false,
      state: 'failed',
      checks: [] as string[],
    };
    let client: AppServerClient | null = null;
    let epoch: object = {};
    let blocked = false;
    let currentThread = '';
    let afterMetadata: (() => void) | null = null;
    let afterEffect: (() => void) | null = null;
    let dropNextEffectReply = false;
    const pending = new Map<number, string>();
    const effects: { method: string; params: Record<string, unknown> }[] = [];
    const dropped = new Set<number>();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 25_000);
    async function until(predicate: () => boolean, label: string) {
      const end = performance.now() + 4000;
      while (!predicate()) {
        if (child.exitCode !== null || performance.now() >= end) throw new Error(label);
        await Bun.sleep(10);
      }
    }
    try {
      await until(() => existsSync(socket), 'owned native listener did not start');
      client = new AppServerClient(
        {
          socketPath: () => socket,
          clientInfo: { name: 'remi', title: null, version: 'accountless-writer-control' },
          requestTimeoutMs: 1000,
          initializeTimeoutMs: 3000,
          // Tap and selectively withhold real responses. All requests go to the actual
          // installed server; this does not fabricate a successful Codex response.
          connect: async (socketPath, handlers, options) => {
            const wire = await connectUnixWebSocket(
              socketPath,
              {
                ...handlers,
                onMessage(text) {
                  const frame = JSON.parse(text);
                  const method = pending.get(frame.id);
                  if (method) pending.delete(frame.id);
                  if (method === 'thread/read' && frame.result) {
                    const callback = afterMetadata;
                    afterMetadata = null;
                    callback?.();
                  }
                  if ((method === 'turn/start' || method === 'turn/steer') && frame.result) {
                    const callback = afterEffect;
                    afterEffect = null;
                    callback?.();
                  }
                  if (dropped.delete(frame.id)) return;
                  handlers.onMessage(text);
                },
              },
              options,
            );
            return {
              get isOpen() {
                return wire.isOpen;
              },
              ping: (data) => wire.ping(data),
              close: (code) => wire.close(code),
              send(text) {
                const frame = JSON.parse(text);
                if (typeof frame.id === 'number' && typeof frame.method === 'string')
                  pending.set(frame.id, frame.method);
                if (frame.method === 'turn/start' || frame.method === 'turn/steer') {
                  effects.push({ method: frame.method, params: frame.params });
                  if (dropNextEffectReply) {
                    dropped.add(frame.id);
                    dropNextEffectReply = false;
                  }
                }
                wire.send(text);
              },
            };
          },
        },
        () => {},
      );
      client.start();
      await until(() => client?.state === 'ready', 'real initialize failed');
      const account = await client.request<{ account: unknown }>('account/read', {
        refreshToken: false,
      });
      receipt.accountPresent = account.account !== null;
      expect(account.account).toBeNull(); // Hard gate before any possible turn call.
      receipt.checks.push('empty file-only account');
      const threads: string[] = [];
      for (const sandbox of [undefined, 'read-only']) {
        const response = await client.request<{
          thread: { id: string };
          sandbox: { type: string };
          approvalPolicy: string;
        }>('thread/start', { cwd, ephemeral: false, ...(sandbox ? { sandbox } : {}) });
        expect(response.sandbox.type).toBe(sandbox ? 'readOnly' : 'dangerFullAccess');
        expect(response.approvalPolicy).toBe('on-request');
        threads.push(response.thread.id);
      }
      currentThread = threads[0] as string;
      const writer = new CodexTextWriter({
        client,
        current: () => ({ threadId: currentThread, epoch }),
        blocked: () => blocked,
      });
      const request = () => ({
        id: crypto.randomUUID(),
        threadId: currentThread,
        text: 'Reply only REMI_ACCOUNTLESS_CONTROL. Use no tools.',
      });
      expect(await writer.send({ ...request(), threadId }, () => true)).toEqual({
        outcome: 'refused',
        code: 'binding_changed',
      });
      expect(await writer.send(request(), () => false)).toEqual({
        outcome: 'refused',
        code: 'unavailable',
      });
      expect(
        await writer.send(request(), () => {
          throw new Error('authority unavailable');
        }),
      ).toEqual({ outcome: 'refused', code: 'unavailable' });
      blocked = true;
      expect(await writer.send(request(), () => true)).toEqual({
        outcome: 'refused',
        code: 'prompt_up',
      });
      blocked = false;
      let guardReads = 0;
      expect(await writer.send(request(), () => ++guardReads < 3)).toEqual({
        outcome: 'refused',
        code: 'unavailable',
      });
      afterMetadata = () => {
        blocked = true;
      };
      expect(await writer.send(request(), () => true)).toEqual({
        outcome: 'refused',
        code: 'prompt_up',
      });
      blocked = false;
      afterMetadata = () => {
        epoch = {};
      };
      expect(await writer.send(request(), () => true)).toEqual({
        outcome: 'refused',
        code: 'binding_changed',
      });
      let allowed = true;
      afterMetadata = () => {
        allowed = false;
      };
      expect(await writer.send(request(), () => allowed)).toEqual({
        outcome: 'refused',
        code: 'unavailable',
      });
      expect(effects).toHaveLength(0);
      receipt.checks.push(
        'wrong binding, false/throwing authority, blocked prompt, epoch change and authority loss make no turn RPC',
      );

      const original = request();
      const starting = writer.send(original, () => true);
      expect(await writer.send(request(), () => true)).toEqual({
        outcome: 'refused',
        code: 'busy',
      });
      const started = await starting;
      expect(started.outcome).toBe('accepted');
      if (started.outcome !== 'accepted') throw new Error('native server did not admit start');
      expect(started.method).toBe('turn/start');
      expect(effects).toEqual([
        {
          method: 'turn/start',
          params: {
            threadId: currentThread,
            clientUserMessageId: original.id,
            input: [{ type: 'text', text: original.text }],
          },
        },
      ]);
      receipt.checks.push(
        'unmaterialized first-turn start, concurrent busy and exact override-free params',
      );
      // Start is admitted before its active status becomes observable. Wait for
      // the actual server's status, rather than assuming immediate publication.
      const activeDeadline = performance.now() + 3000;
      for (;;) {
        const observed = await client.request<{ thread: { status: { type: string } } }>(
          'thread/read',
          { threadId: currentThread, includeTurns: false },
        );
        if (observed.thread.status.type === 'active') break;
        if (performance.now() >= activeDeadline)
          throw new Error('native active status was not published');
        await Bun.sleep(20);
      }
      const steering = request();
      const steered = await writer.send(steering, () => true);
      expect(steered).toEqual({
        outcome: 'accepted',
        method: 'turn/steer',
        turnId: started.turnId,
      });
      expect(effects[1]).toEqual({
        method: 'turn/steer',
        params: {
          threadId: currentThread,
          clientUserMessageId: steering.id,
          input: [{ type: 'text', text: steering.text }],
          expectedTurnId: started.turnId,
        },
      });
      receipt.checks.push('active turn steer with atomic expectedTurnId, no posture overrides');

      const beforeEpochLoss = effects.length;
      afterEffect = () => {
        epoch = {};
      };
      expect(await writer.send(request(), () => true)).toEqual({
        outcome: 'uncertain',
        code: 'delivery_unknown',
      });
      expect(effects).toHaveLength(beforeEpochLoss + 1);
      receipt.checks.push('epoch change after actual turn admission retains uncertainty');

      const beforeLoss = effects.length;
      dropNextEffectReply = true;
      expect(await writer.send(request(), () => true)).toEqual({
        outcome: 'uncertain',
        code: 'delivery_unknown',
      });
      expect(effects).toHaveLength(beforeLoss + 1);
      expect(effects.at(-1)?.method).toBe('turn/steer');
      await Bun.sleep(50);
      expect(effects).toHaveLength(beforeLoss + 1);
      receipt.checks.push('real effect response loss is uncertain with no retry/start fallback');
      afterMetadata = () => {
        currentThread = threads[1] as string;
      };
      const beforeRotation = effects.length;
      expect(await writer.send(request(), () => true)).toEqual({
        outcome: 'refused',
        code: 'binding_changed',
      });
      expect(effects).toHaveLength(beforeRotation);
      currentThread = threads[1] as string;
      epoch = {};
      const readOnlyRequest = request();
      const readOnly = await writer.send(readOnlyRequest, () => true);
      expect(readOnly).toMatchObject({ outcome: 'accepted', method: 'turn/start' });
      expect(effects.at(-1)?.params).toEqual({
        threadId: currentThread,
        clientUserMessageId: readOnlyRequest.id,
        input: [{ type: 'text', text: readOnlyRequest.text }],
      });
      receipt.checks.push('explicit read-only thread start also omits all posture overrides');
      writer.close();
      const afterClose = effects.length;
      expect(await writer.send(request(), () => true)).toEqual({
        outcome: 'refused',
        code: 'unavailable',
      });
      expect(effects).toHaveLength(afterClose);
      receipt.state = 'passed';
    } finally {
      client?.stop();
      if (child.exitCode === null) child.kill('SIGTERM');
      const kill = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2000);
      await child.exited;
      clearTimeout(kill);
      clearTimeout(deadline);
      try {
        process.kill(child.pid, 0);
      } catch {
        receipt.reaped = true;
      }
      const output = process.env['REMI_CODEX_ACCOUNTLESS_RECEIPT'];
      if (output) writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      rmSync(root, { recursive: true });
      expect(receipt.reaped).toBe(true);
    }
  },
  30_000,
);
