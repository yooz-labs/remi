/**
 * Hub client census for the `hub_status` broadcast (#650, epic #648): the
 * daemon half of the menu-bar icon state. Tracks every protocol connection's
 * peer class and emits a `hub_status` frame to a newly ack'd connection plus
 * a broadcast to everyone whenever the counts change.
 *
 * Hub-mode only: cli.ts wires the tracker exclusively in the `serveMode`
 * branch; session daemons and wrappers never emit `hub_status`.
 */

import { createHubStatus } from '@remi/shared';
import type { HubPendingQuestion, ProtocolMessage, UUID } from '@remi/shared';
import type { AdapterMetadata } from '../adapters/index.ts';
import { isLoopbackAddress } from '../server/peer-helpers.ts';
import type { HubQuestionCensus } from './hub-question-census.ts';

/**
 * How a connection counts toward the icon state:
 *  - 'local'    — non-query client on a loopback TCP peer
 *  - 'remote'   — non-query client on a non-loopback peer, or any
 *                 relay-attached client (relay implies remote by definition)
 *  - 'excluded' — query-mode utility clients (remi ls/stop, the menu-bar app
 *                 itself) and non-protocol adapters (telegram)
 */
export type PeerClass = 'local' | 'remote' | 'excluded';

/**
 * Pure classification from adapter connect metadata. Exported for tests.
 *
 * An unknown websocket peer address classifies as REMOTE: overstating remote
 * presence fails visible (the user investigates a filled icon), while
 * understating it would hide a genuinely remote client behind an idle icon.
 */
export function classifyClient(metadata: AdapterMetadata): PeerClass {
  const platformData = metadata.platformData;
  if (!platformData) return 'excluded';
  switch (platformData.kind) {
    case 'telegram':
      return 'excluded';
    case 'relay':
      // Unconditionally remote: RelayPlatformData carries no `mode`, so a
      // hypothetical relay-borne query client cannot be excluded. Currently
      // unreachable (all query utilities connect over plain ws://), noted in
      // the #744 review; fixing properly needs a mode field on the relay
      // platform data.
      return 'remote';
    case 'websocket': {
      if (platformData.mode === 'query') return 'excluded';
      return isLoopbackAddress(platformData.peerAddress) ? 'local' : 'remote';
    }
  }
}

export interface HubClientTrackerDeps {
  /** Send a message to one connection (the post-hello_ack initial frame). */
  readonly send: (connectionId: UUID, message: ProtocolMessage) => void;
  /** Broadcast a message to all connections (count changes). */
  readonly broadcast: (message: ProtocolMessage) => void;
  /**
   * Live child session daemon count + pending-question census
   * (live-sessions registry, #786/#787). Reads the same registry entries
   * the plain session count used to.
   */
  readonly getCensus: () => HubQuestionCensus;
  /** REMI_VERSION of the hub process. */
  readonly hubVersion: string;
}

/** Stable, order-independent key for a question-id set, so change detection
 *  (`broadcastIfChanged`) treats "same ids, different array order" as
 *  unchanged but any add/remove as a change. */
function questionIdsKey(questions: readonly HubPendingQuestion[]): string {
  return questions
    .map((q) => q.id)
    .sort()
    .join(',');
}

export class HubClientTracker {
  private readonly clients = new Map<UUID, PeerClass>();
  private readonly deps: HubClientTrackerDeps;
  /**
   * Last counts broadcast, for change detection (sessions + the pending-
   * question id set included, #786/#787 — two different question sets of
   * equal SIZE, e.g. one answered while another arrived in the same beat,
   * must still count as a change). Seeded with the real census at
   * construction — a null sentinel would force a spurious broadcast on the
   * first connect even when nothing changed (#744 review).
   */
  private lastEmitted: { local: number; remote: number; sessions: number; questionIds: string };

  constructor(deps: HubClientTrackerDeps) {
    this.deps = deps;
    const census = deps.getCensus();
    this.lastEmitted = {
      local: 0,
      remote: 0,
      sessions: census.sessions,
      questionIds: questionIdsKey(census.questions),
    };
  }

  counts(): {
    localClients: number;
    remoteClients: number;
    sessions: number;
    pendingQuestions: number;
    questions: readonly HubPendingQuestion[];
  } {
    let local = 0;
    let remote = 0;
    for (const cls of this.clients.values()) {
      if (cls === 'local') local++;
      else if (cls === 'remote') remote++;
    }
    const census = this.deps.getCensus();
    return {
      localClients: local,
      remoteClients: remote,
      sessions: census.sessions,
      pendingQuestions: census.questions.length,
      questions: census.questions,
    };
  }

  /**
   * Track a newly connected client. Every client receives the census exactly
   * ONCE per connect (#744 review): by the time this runs (post-hello_ack),
   * the new connection is already reachable by `broadcast` on every
   * transport (WS server inserts connections at open; relay sets its
   * clientConnectionId before firing onConnect) — so when the counts changed,
   * the broadcast alone covers it, and the direct send is only for connects
   * that changed nothing (e.g. a query-mode monitor).
   */
  onConnect(connectionId: UUID, metadata: AdapterMetadata): void {
    this.clients.set(connectionId, classifyClient(metadata));
    if (!this.broadcastIfChanged()) {
      this.deps.send(connectionId, this.statusMessage());
    }
  }

  onDisconnect(connectionId: UUID): void {
    if (this.clients.delete(connectionId)) {
      this.broadcastIfChanged();
    }
  }

  /** Re-check the census after an external change (child session
   *  registered/removed, or a session's pendingQuestions changed, via the
   *  live-sessions watcher, #786/#787). */
  refresh(): void {
    this.broadcastIfChanged();
  }

  private statusMessage(): ProtocolMessage {
    return createHubStatus({ ...this.counts(), hubVersion: this.deps.hubVersion });
  }

  /** Returns true when a broadcast actually went out. */
  private broadcastIfChanged(): boolean {
    const { localClients, remoteClients, sessions, questions } = this.counts();
    const questionIds = questionIdsKey(questions);
    const prev = this.lastEmitted;
    if (
      prev.local === localClients &&
      prev.remote === remoteClients &&
      prev.sessions === sessions &&
      prev.questionIds === questionIds
    ) {
      return false;
    }
    this.lastEmitted = { local: localClients, remote: remoteClients, sessions, questionIds };
    this.deps.broadcast(this.statusMessage());
    return true;
  }
}
