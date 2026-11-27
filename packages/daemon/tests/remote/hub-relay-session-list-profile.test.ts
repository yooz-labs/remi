/**
 * The relay's aggregate list leaves out hidden children, and, while profiles are in use, children
 * with no record yet, BEFORE its 32-slot cap (#1749, PR 1828 round 1 F3 and L3). The children
 * here are live entries whose ports nothing listens on: a child the relay tries to list fails
 * and marks the list partial, so a partial list means the relay considered that child.
 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionListRequest, createSessionListResponse } from '@remi/shared';
import { parseProfiles } from '../../src/profiles/profile-config.ts';
import { RemotePolicyScope, readProfileSidecar } from '../../src/profiles/session-owner.ts';
import type { HubRelay } from '../../src/remote/hub-relay.ts';
import { SessionProfilesFile } from '../../src/session/session-profiles-file.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { resumedHub } from './hub-relay-fixture.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

test('hidden and record-less children are left out before the cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-relay-list-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const profiles = parseProfiles({
    work: { label: 'Work', remote_selectable: true, claude: { expects: 'subscription' } },
    secret: { label: 'Hidden label', remote_visible: false, claude: { expects: 'subscription' } },
  });
  if ('error' in profiles) throw new Error(profiles.error);
  const store = new SessionStore(path.join(root, 'sessions.json'));
  const live = new SessionRegistryFile(path.join(root, 'live'));
  let port = 19600;
  const child = (profile?: string) => {
    const sessionId = crypto.randomUUID();
    port += 2;
    live.register({
      sessionId,
      pid: process.pid,
      wsPort: port,
      hookPort: port + 1,
      projectPath: root,
      name: `child-${port}`,
      startedAt: new Date().toISOString(),
    });
    if (profile) {
      const revision = profiles.entries[profile]?.revision ?? '';
      store.save(
        {
          remiSessionId: sessionId,
          claudeSessionId: null,
          projectPath: root,
          port,
          pid: null,
          startedAt: new Date().toISOString(),
          exitedAt: null,
          exitCode: null,
          profile,
          profileSnapshot: { revision },
        },
        { profile, revision },
      );
    }
  };
  // More hidden children than the cap, and one that has not written its record yet.
  for (let i = 0; i < 33; i++) child('secret');
  child();
  let reads = 0;
  const scope = new RemotePolicyScope(
    () => {
      reads++;
      return profiles;
    },
    () => readProfileSidecar(new SessionProfilesFile(root)),
  );
  // The relay exists once the hub is up; the hub's own list answers through it.
  const holder: { relay?: HubRelay } = {};
  const hub = await resumedHub(
    {
      registry: live,
      remotePolicy: {
        sessionStore: store,
        snapshot: () => ({ profiles: scope.profiles(), sidecar: scope.sidecar() }),
        run: (fn, snapshot) => scope.run(fn, snapshot),
      },
    },
    {
      events: {
        onSessionListRequest: (cid, id) => {
          // The hub's own list reads under the aggregate's snapshot.
          scope.profiles();
          holder.relay?.sendRaw(cid, createSessionListResponse([], id));
        },
      },
    },
  );
  holder.relay = hub.relay;
  cleanup.push(hub.cleanup);

  const first = await hub.exchange(createSessionListRequest(true));
  expect(first).toMatchObject({ type: 'session_list_response', sessions: [] });
  expect(JSON.stringify(first)).not.toContain('secret');
  expect(reads).toBe(1);

  // Positive control: a visible child is considered (its dead port makes the list partial).
  child('work');
  const second = await hub.exchange(createSessionListRequest(true));
  expect(second).toMatchObject({ type: 'error', code: 'CHILD_LIST_PARTIAL' });
}, 20000);
