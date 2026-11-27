import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type ProtocolMessage, generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { makeCurrentSessionResolver } from '../../../src/cli/current-session.ts';
import { createConnectionHandlers } from '../../../src/cli/handlers/connection-events.ts';
import { createResumeSessionHandlers } from '../../../src/cli/handlers/resume-session-events.ts';
import {
  __resetSessionStateForTests,
  setPrimarySessionId,
} from '../../../src/cli/session-state.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import { parseProfiles } from '../../../src/profiles/profile-config.ts';
import { readProfileSidecar, sessionProfileOwner } from '../../../src/profiles/session-owner.ts';
import { sessionProfileRef } from '../../../src/profiles/session-profile-ref.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionProfilesFile } from '../../../src/session/session-profiles-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

for (const visible of [true, false]) {
  test(`connection and resume acknowledgements ${visible ? 'include visible' : 'omit hidden'} profiles`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-ack-'));
    const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    try {
      const profiles = parseProfiles({
        work: {
          label: 'Work',
          remote_visible: visible,
          remote_selectable: visible,
          claude: { expects: 'subscription' },
        },
      });
      if ('error' in profiles) throw new Error(profiles.error);
      const revision = profiles.entries['work']?.revision ?? '';
      const store = new SessionStore(path.join(root, 'sessions.json'));
      const sidecar = () => readProfileSidecar(new SessionProfilesFile(root));
      const discovery = new TranscriptDiscovery({ projectsDir: path.join(root, 'projects') });
      const harness = new ClaudeHarness(discovery);
      const binding = new SessionBindingStore(store);
      const messages: ProtocolMessage[] = [];
      const send = (_id: string, message: ProtocolMessage) => {
        messages.push(message);
        return true;
      };
      const pty = () =>
        ({
          id: generateId(),
          write: () => {},
          submitInput: async () => {},
          close: async () => {},
        }) as unknown as PTYSession;
      const api = () => ({ getFullBulletContent: () => null }) as unknown as MessageAPI;
      const save = (id: string, claudeId: string) =>
        store.save(
          {
            remiSessionId: id,
            claudeSessionId: claudeId,
            projectPath: root,
            port: 19200,
            pid: null,
            startedAt: new Date().toISOString(),
            exitedAt: null,
            exitCode: null,
            profile: 'work',
            profileSnapshot: { revision },
          },
          { profile: 'work', revision },
        );
      const profileForSession = (id: string) => {
        const record = store.findByRemiSessionId(id);
        return sessionProfileRef(
          sessionProfileOwner(record ?? { transcriptProfile: undefined }, sidecar(), profiles),
          record?.profileSnapshot,
          profiles,
        );
      };
      const id = registry.createSessionId();
      save(id, generateId());
      registry.registerSession(id, root, pty(), api());
      setPrimarySessionId(id);
      const current = makeCurrentSessionResolver({
        profiles: () => profiles,
        sidecar,
        getPrimarySessionId: () => id,
        sessionStore: store,
        harness,
        harnessId: 'claude',
        withholdTranscriptPath: true,
      });
      const connection = createConnectionHandlers({
        sessionRegistry: registry,
        currentOwnedSession: current,
        hubMode: false,
        harnessId: 'claude',
        harnesses: () => ['claude'],
        trackConnection: () => {},
        untrackConnection: () => {},
        onConnectionAdded: () => {},
        onConnectionRemoved: () => {},
        cancelOrphanTimeout: () => {},
        send,
        remiVersion: 'test',
      });
      await connection.onConnect(generateId(), {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });
      const assertAck = () => {
        const ack = messages.find((m) => m.type === 'hello_ack');
        expect(ack?.type).toBe('hello_ack');
        if (ack?.type !== 'hello_ack') throw new Error('no ack');
        expect(ack.profile).toEqual(
          visible ? { id: 'work', label: 'Work', state: 'current' } : undefined,
        );
        messages.length = 0;
      };
      assertAck();
      const handler = createResumeSessionHandlers({
        readSidecar: () => ({ ok: true, entries: {} }),
        readProfiles: () => ({ entries: {}, notices: [] }),
        isHiddenResumeOwner: () => false,
        childSessions: null,
        harnessId: 'claude',
        harnesses: () => ['claude'],
        sessionRegistry: registry,
        sessionStore: store,
        bindingStore: binding,
        transcriptDiscovery: discovery,
        harness,
        checkResumeProfile: () => null,
        profileForSession,
        createNewSession: async () => {
          throw new Error('unexpected create');
        },
        send,
      });
      await handler.onResumeSessionRequest(generateId(), id, generateId());
      assertAck();
      await registry.shutdown();
      const freshRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
      try {
        const handler2 = createResumeSessionHandlers({
          readSidecar: () => ({ ok: true, entries: {} }),
          readProfiles: () => ({ entries: {}, notices: [] }),
          isHiddenResumeOwner: () => false,
          childSessions: null,
          harnessId: 'claude',
          harnesses: () => ['claude'],
          sessionRegistry: freshRegistry,
          sessionStore: store,
          bindingStore: binding,
          transcriptDiscovery: discovery,
          harness,
          checkResumeProfile: () => null,
          profileForSession,
          createNewSession: async (newId) => {
            save(newId, generateId());
            freshRegistry.registerSession(newId, root, pty(), api());
          },
          send,
        });
        await handler2.onResumeSessionRequest(generateId(), id, generateId());
        assertAck();
      } finally {
        await freshRegistry.shutdown();
      }
    } finally {
      __resetSessionStateForTests();
      await registry.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
