/**
 * Recent Client - Fetches and renders recent project directories.
 *
 * Two modes:
 * - Local: called with pre-computed directories (from SessionStore)
 * - Remote: connects via WebSocket to query a daemon's session history
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';
import {
  createHello,
  createSessionHistoryRequest,
  deserialize,
  generateId,
  serialize,
} from '@remi/shared';
import type { ProtocolMessage, RecentDirectory } from '@remi/shared';
import type { SessionStore } from '../session/session-store.ts';
import { performAuthHandshake } from './auth-helper.ts';
import { formatAge } from './ls-client.ts';

/**
 * Collect the N most-recent project directories from the SessionStore,
 * with session counts and display names derived from the path basename.
 */
export function getRecentDirectories(store: SessionStore, limit: number): RecentDirectory[] {
  const sessions = store.list();
  const dirMap = new Map<string, { count: number; lastUsed: string }>();

  for (const s of sessions) {
    const dir = s.projectPath;
    const existing = dirMap.get(dir);
    if (existing) {
      existing.count++;
      if (s.startedAt > existing.lastUsed) {
        existing.lastUsed = s.startedAt;
      }
    } else {
      dirMap.set(dir, { count: 1, lastUsed: s.startedAt });
    }
  }

  return Array.from(dirMap.entries())
    .map(([directory, { count, lastUsed }]) => ({
      directory,
      lastUsed,
      sessionCount: count,
      displayName: path.basename(directory),
    }))
    .sort((a, b) => (a.lastUsed > b.lastUsed ? -1 : 1))
    .slice(0, limit);
}

export interface RecentClientOptions {
  readonly host: string;
  readonly port: number;
  readonly limit?: number;
  readonly timeout?: number;
}

export async function fetchRecentDirectories(
  host: string,
  port: number,
  timeout = 5000,
  limit?: number | undefined,
): Promise<RecentDirectory[]> {
  const url = `ws://${host}:${port}/ws`;

  return new Promise<RecentDirectory[]>((resolve, reject) => {
    let settled = false;
    let authInProgress = false;
    let ws: WebSocket;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      const detail = errorToString(err);
      reject(new Error(`Cannot connect to daemon at ${host}:${port}: ${detail}`));
      return;
    }

    const timer = setTimeout(() => {
      ws.close();
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out connecting to daemon at ${host}:${port}`));
      }
    }, timeout);

    function done(result?: RecentDirectory[], err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(result ?? []);
    }

    function sendHello(): void {
      const clientId = generateId();
      ws.send(serialize(createHello(clientId, '1.0.0', undefined, undefined, undefined, 'query')));
    }

    function handleMessage(msg: ProtocolMessage): void {
      if (msg.type === 'hello_ack') {
        ws.send(serialize(createSessionHistoryRequest(limit)));
      } else if (msg.type === 'session_history_response') {
        done([...msg.directories]);
      } else if (msg.type === 'error') {
        if (msg.code === 'AUTH_REQUIRED') return;
        if (msg.code === 'NO_SESSION') return;
        done(undefined, new Error(`Daemon error: ${msg.message}`));
      }
    }

    ws.onopen = () => {
      sendHello();
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      const msg = deserialize(data);
      if (!msg) return;

      if (msg.type === 'auth_challenge') {
        if (authInProgress) return;
        authInProgress = true;
        performAuthHandshake(ws, msg)
          .then(() => {
            authInProgress = false;
            sendHello();
          })
          .catch((err) => {
            done(undefined, err instanceof Error ? err : new Error(String(err)));
          });
        return;
      }

      if (authInProgress) return;
      handleMessage(msg);
    };

    ws.onerror = (event) => {
      const detail = 'message' in event ? `: ${(event as ErrorEvent).message}` : '';
      done(
        undefined,
        new Error(`WebSocket error connecting to daemon at ${host}:${port}${detail}`),
      );
    };

    ws.onclose = () => {
      if (!settled) {
        done(undefined, new Error('Connection closed before response received'));
      }
    };
  });
}

export async function runRecentClient(opts: RecentClientOptions): Promise<void> {
  const { host, port, limit, timeout } = opts;
  const directories = await fetchRecentDirectories(host, port, timeout, limit);
  renderRecentDirectories(directories);
}

export function renderRecentDirectories(directories: readonly RecentDirectory[]): void {
  if (directories.length === 0) {
    console.log('No recent directories found.');
    return;
  }

  const home = os.homedir();
  const shortPath = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  // Column widths
  const numWidth = String(directories.length).length + 1;
  const dirPaths = directories.map((d) => shortPath(d.directory));
  const maxDirLen = Math.min(Math.max(...dirPaths.map((p) => p.length)), 50);
  const sessWidth = 10;
  const ageWidth = 12;

  // Header
  const header =
    '  #'.padEnd(numWidth + 2) +
    '  DIRECTORY'.padEnd(maxDirLen + 4) +
    'SESSIONS'.padStart(sessWidth) +
    '   LAST USED'.padStart(ageWidth);
  console.log(header);
  console.log('-'.repeat(header.length));

  for (let i = 0; i < directories.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index within bounds
    const d = directories[i]!;
    const num = `${i + 1}`.padStart(numWidth);
    const dir = (dirPaths[i] ?? d.directory).padEnd(maxDirLen + 2);
    const count = String(d.sessionCount).padStart(sessWidth);
    const age = formatAge(d.lastUsed).padStart(ageWidth);
    console.log(`  ${num}  ${dir}${count}   ${age}`);
  }
}
