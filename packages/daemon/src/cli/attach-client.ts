import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';
import {
  createDetachSession,
  createHello,
  createPong,
  createTerminalResize,
  createUserInput,
  deserialize,
  dispatchMessage,
  generateId,
  serialize,
} from '@remi/shared';
import type {
  MessageHandlers,
  ProtocolMessage,
  ProtocolMessageMap,
  Question,
  RemiStatus,
  UUID,
} from '@remi/shared';
import { performAuthHandshake } from './auth-helper.ts';
import { capabilityWsOptions } from './capability-client.ts';
import { DetachScanner } from './detach-scanner.ts';
import { PtyQuiescenceGate } from './pty-quiescence-gate.ts';
import { StatusBar, childRows } from './status-bar.ts';

export interface AttachClientOptions {
  host: string;
  port: number;
  sessionId: string;
  timeout?: number;
  /** File descriptor for output. Defaults to 1 (stdout). Override in tests. */
  outputFd?: number;
  /** Whether the reserved-row status bar (#754) is eligible to start.
   *  Defaults to `process.stdout.isTTY === true`, same as production. Tests
   *  run without a real TTY, so this is the hook that lets them exercise the
   *  bar's actual wiring (including #932's `hasLiveQuestions`) end to end. */
  statusBarEligible?: boolean;
}

export interface AttachClientResult {
  exitCode: number;
  reason: 'detached' | 'session_ended' | 'error' | 'timeout' | 'connection_closed';
}

export async function runAttachClient(opts: AttachClientOptions): Promise<AttachClientResult> {
  const { host, port, sessionId, timeout = 5000, outputFd = 1 } = opts;
  const url = `ws://${host}:${port}/ws`;

  let ws: WebSocket;
  let attachedSessionId: UUID | null = null;
  let rawModeSet = false;
  let detachScannerInstance: DetachScanner | null = null;
  let stdinListener: ((data: Buffer) => void) | null = null;
  let resizeListener: (() => void) | null = null;
  let resizeNudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let resolved = false;
  let outputBroken = false;
  let authInProgress = false;
  let receivedRawPty = false;
  let rawPtyTimer: ReturnType<typeof setTimeout> | null = null;
  let detachPending = false;
  let detachAckTimer: ReturnType<typeof setTimeout> | null = null;
  // #754: latest daemon status snapshot (remi_status broadcast) + the
  // reserved-row bar rendering it — the same StatusBar the wrapper draws.
  // Only on a real TTY: piped/test output must never receive bar escapes.
  const statusBarEligible = opts.statusBarEligible ?? process.stdout.isTTY === true;
  let latestStatus: RemiStatus | null = null;
  let statusBar: StatusBar | null = null;
  // #932: the authoritative live-question id set for this session, kept
  // current by `question_snapshot` (sent unconditionally on attach via
  // `resendPendingQuestions`, and again on every change via
  // `onQuestionsChanged` -- see that broadcast's doc). Mirrors the wrapper's
  // own `hasLiveQuestions` (`cli.ts:1525`,
  // `sessionRegistry.getSession(id)?.currentQuestions.size > 0`) using data
  // this client already receives, so the attach-path bar gets the same
  // pause-while-live protection as the wrapper bar.
  let liveQuestionIds = new Set<UUID>();
  // #932: whether at least one `question_snapshot` has been observed for
  // this attach cycle. `startStatusBar()`'s first paint must not run before
  // this is true, or it can read `hasLiveQuestions()` as false for a
  // session that already has a live question -- see that function's doc.
  let receivedQuestionSnapshot = false;
  let questionSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  // #932 durable fix: this attach cycle's own quiescence + clean-boundary
  // gate for `outputFd` -- the same fd `statusBar` draws into. Scoped to
  // this call (not module-level, unlike the wrapper's `wrapperPtyGate` in
  // cli.ts) because a fresh `runAttachClient()` call is a fresh terminal
  // parser state: nothing has been written to `outputFd` yet, so a new gate
  // starting from "ground, never observed" is exactly right.
  const ptyGate = new PtyQuiescenceGate();

  function writeOutput(text: string): void {
    if (outputBroken) return;
    try {
      fs.writeSync(outputFd, text);
    } catch (err) {
      outputBroken = true;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBADF' && code !== 'EPIPE') {
        process.stderr.write(`[remi] output write failed: ${code ?? err}\n`);
      }
    }
  }

  function restoreTerminal(): void {
    // #754: halt the bar loop and clear its reserved row before anything else
    // writes to the terminal, so the returned shell starts clean.
    if (statusBar) {
      statusBar.stop();
      statusBar = null;
    }
    if (detachAckTimer) {
      clearTimeout(detachAckTimer);
      detachAckTimer = null;
    }
    if (rawPtyTimer) {
      clearTimeout(rawPtyTimer);
      rawPtyTimer = null;
    }
    if (questionSnapshotTimer) {
      clearTimeout(questionSnapshotTimer);
      questionSnapshotTimer = null;
    }
    if (resizeNudgeTimer) {
      clearTimeout(resizeNudgeTimer);
      resizeNudgeTimer = null;
    }
    // Print a newline after detach so the user's shell prompt starts clean
    if (attachedSessionId) {
      try {
        fs.writeSync(outputFd, '\n');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EBADF' && code !== 'EPIPE') {
          process.stderr.write(`[remi] warning: cleanup write failed: ${code ?? err}\n`);
        }
      }
    }
    if (rawModeSet && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch (err) {
        process.stderr.write(
          `[remi] warning: failed to restore terminal mode (run 'reset' to fix): ${err}\n`,
        );
      }
      rawModeSet = false;
    }
    if (detachScannerInstance) {
      detachScannerInstance.destroy();
      detachScannerInstance = null;
    }
    process.stdin.pause();
    if (stdinListener) {
      process.stdin.removeListener('data', stdinListener);
      stdinListener = null;
    }
    if (resizeListener) {
      process.stdout.removeListener('resize', resizeListener);
      resizeListener = null;
    }
  }

  function sendMessage(msg: ProtocolMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialize(msg));
    }
  }

  function sendInput(content: string): void {
    if (attachedSessionId) {
      sendMessage(createUserInput(attachedSessionId, content, true));
    }
  }

  function writeRawBytes(base64Data: string): void {
    if (outputBroken) return;
    const buf = Buffer.from(base64Data, 'base64');
    try {
      fs.writeSync(outputFd, buf);
    } catch (err) {
      outputBroken = true;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBADF' && code !== 'EPIPE') {
        process.stderr.write(`[remi] output write failed: ${code ?? err}\n`);
      }
      return;
    }
    // #932 durable fix (review finding 2): feed the quiescence +
    // clean-boundary gate AFTER the real chunk has landed on the wire,
    // never before -- and outside the write's own try/catch, so a throw
    // from this callback (e.g. StatusBar's isBoundaryClean/isQuiescent/
    // hasLiveQuestions predicates) is never misclassified as a write
    // failure. Same ordering rationale as the wrapper's
    // `observeLocalPtyOutput` (pty-session-setup.ts): observing before the
    // write would put the bar's corrective DECSTBM-reasserting paint on
    // the wire BEFORE the very ESC[r that triggered it, so the reset would
    // immediately undo the correction instead of the other way around.
    if (ptyGate.observe(buf)) statusBar?.notifyScrollRegionReset();
  }

  /**
   * #754: start the reserved-row status bar once the first `remi_status`
   * snapshot arrives (an older daemon never sends one, so no row is wasted).
   * Reserving the row = reporting `rows - 1` to the daemon's PTY, exactly like
   * wrapper mode; the StatusBar itself is the same class, drawing on this
   * terminal's bottom row from the broadcast snapshots.
   *
   * #932: `.start()` paints immediately, so that first paint must not read
   * `hasLiveQuestions()` before `liveQuestionIds` reflects reality. The
   * daemon always sends `question_snapshot` -- even empty -- right after
   * hello_ack (`resendPendingQuestions`), but it necessarily arrives as a
   * LATER message than the hello_ack/remi_status that can trigger this
   * call, so calling straight through here could paint "no question" for a
   * session that already has one live. Deferred (not blocked) until one
   * arrives, bounded by a short timeout that creates the bar anyway --
   * `createStatusBar()` bypasses the wait -- so an older daemon that never
   * sends a snapshot doesn't lose the bar entirely, only that first paint's
   * protection-1 coverage: the same fail-open default `hasLiveQuestions`
   * already has elsewhere in this file.
   */
  function startStatusBar(): void {
    if (!statusBarEligible || statusBar !== null || resolved) return;
    if (!receivedQuestionSnapshot) {
      if (!questionSnapshotTimer) {
        questionSnapshotTimer = setTimeout(() => {
          questionSnapshotTimer = null;
          createStatusBar();
        }, 500);
      }
      return;
    }
    createStatusBar();
  }

  function createStatusBar(): void {
    if (!statusBarEligible || statusBar !== null || resolved) return;
    statusBar = new StatusBar({
      getStdoutFd: () => (outputBroken ? null : outputFd),
      getStatus: () => latestStatus as RemiStatus,
      getSize: () => ({
        cols: process.stdout.columns || 120,
        rows: process.stdout.rows || 40,
      }),
      isEnabled: () => latestStatus !== null,
      hasLiveQuestions: () => liveQuestionIds.size > 0,
      // #932 durable fix: gate every paint on the same `ptyGate` `writeRawBytes` feeds.
      isBoundaryClean: () => ptyGate.isBoundaryClean(),
      isQuiescent: () => ptyGate.isQuiescent(),
      log: (msg) => process.stderr.write(`${msg}\n`),
    });
    statusBar.start();
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    sendMessage(createTerminalResize(cols, childRows(rows, true)));
  }

  // #753: question ids already shown as a banner, so a repeat delivery (the
  // daemon re-sends the authoritative pending set after the replay batch; a
  // reconnect could deliver it again) never double-prints, and a later
  // question_resolved can acknowledge exactly the banners the user saw.
  const banneredQuestionIds = new Set<string>();

  /**
   * #753: print a pending HELD question into the attached terminal. A held
   * permission (Model B) blocks Claude inside the hook call, so no raw PTY
   * bytes for the prompt exist and the resize-nudge redraw has nothing to
   * repaint — without this banner an attach shows only "waiting". ONLY held
   * questions banner (#760 review finding 1): every other question class
   * renders natively in the raw PTY stream, and the daemon emits multiple
   * `question` messages per visible prompt cycle (hook bridge + PTY parser,
   * different ids), so bannering those would double- or triple-print around
   * the native prompt — the exact noise the old blanket suppression avoided.
   * Held questions also guarantee an idle PTY, so the banner can never
   * interleave mid-ANSI-sequence with streaming output. Plain text through
   * writeOutput (raw mode: \r\n), cyan so it stands apart from Claude's own
   * output.
   */
  function renderQuestionBanner(question: Question): void {
    if (question.held !== true) return;
    if (banneredQuestionIds.has(question.id)) return;
    banneredQuestionIds.add(question.id);
    const options = question.options.map((o, i) => `${i + 1}) ${o.label}`).join('  ');
    const lines = [`\r\n\x1b[36m[remi] pending question: ${question.text}\x1b[0m\r\n`];
    if (options) lines.push(`\x1b[36m[remi] options: ${options}\x1b[0m\r\n`);
    lines.push(
      `\x1b[2m[remi] answer on your phone, or run 'remi unstick' to answer here\x1b[0m\r\n`,
    );
    writeOutput(lines.join(''));
  }

  /**
   * #898: total dispatch over the full protocol registry, not just the
   * `d2c`/`both`-tagged subset — `ReplayBatchMessage.messages` is typed
   * `readonly ProtocolMessage[]` (no direction narrowing), and this function
   * recurses into it, so a handler map scoped to a `DaemonToClientType`
   * alias would not type-check against that recursive call without adding a
   * new runtime narrowing step that doesn't exist today. Sizing the map to
   * the full `keyof ProtocolMessageMap` is a strictly stronger guarantee
   * than "every d2c entry decided" (it is a superset), needs no new
   * machinery, and matches the type `renderMessage` already accepts.
   *
   * Rebuilt on every call (not hoisted) because the `question` handler
   * closes over this call's `inReplay` argument.
   */
  function renderMessage(msg: ProtocolMessage, inReplay = false): void {
    const handlers: MessageHandlers<keyof ProtocolMessageMap, void> = {
      raw_pty_output: (m) => {
        receivedRawPty = true;
        writeRawBytes(m.data);
      },
      remi_status: (m) => {
        // #754: display state only — never printed as text. The bar's own
        // 250ms repaint loop reads the latest snapshot.
        latestStatus = m.status;
        if (attachedSessionId) startStatusBar();
      },
      question: (m) => {
        // #753: LIVE questions only. Replayed history is not trustworthy for
        // pendingness — question_resolved is broadcast-only (never recorded),
        // so an already-answered question replays indistinguishably from a
        // pending one. The daemon re-sends the authoritative pending set as
        // live messages right after the replay batch, which is what lands here.
        if (!inReplay) renderQuestionBanner(m.question);
      },
      question_resolved: (m) => {
        // Only acknowledge questions this client actually bannered; resolved
        // broadcasts for questions answered before attach are noise.
        if (banneredQuestionIds.delete(m.questionId)) {
          writeOutput('\r\n\x1b[2m[remi] question answered\x1b[0m\r\n');
        }
      },
      // #932: the authoritative live set, always overwritten (never merged --
      // matches `QuestionStore`'s own "full current set, never a delta"
      // contract). Feeds the status bar's `hasLiveQuestions`; see
      // `liveQuestionIds`'s declaration for why this is the right signal.
      question_snapshot: (m) => {
        liveQuestionIds = new Set(m.questionIds);
        if (!receivedQuestionSnapshot) {
          receivedQuestionSnapshot = true;
          if (questionSnapshotTimer) {
            clearTimeout(questionSnapshotTimer);
            questionSnapshotTimer = null;
          }
          // Release a startStatusBar() that deferred waiting for this.
          if (attachedSessionId) startStatusBar();
        }
      },
      replay_batch: (m) => {
        for (const nested of m.messages) {
          renderMessage(nested, true);
        }
      },
      error: (m) => {
        writeOutput(`\n[error: ${m.code} - ${m.message}]\n`);
      },
      // Suppressed; raw PTY output already provides the full terminal view.
      // Already-explicit no-ops in the pre-#898 switch (same behavior here).
      agent_output: 'ignore',
      structured_agent_output: 'ignore',
      session_update: 'ignore',
      transcript_content: 'ignore',
      // Everything below fell through the pre-#898 switch's anonymous
      // `default: break` — a silent drop. Behavior is unchanged (still a
      // no-op); the entries are now explicit and greppable (#898). Full
      // per-type rationale is in the PR description.
      hello: 'ignore',
      hello_ack: 'ignore',
      user_input: 'ignore',
      ack: 'ignore',
      edit: 'ignore',
      answer: 'ignore',
      ping: 'ignore',
      pong: 'ignore',
      bullet_expand_request: 'ignore',
      bullet_expand_response: 'ignore',
      session_list_request: 'ignore',
      session_list_response: 'ignore',
      transcript_load_request: 'ignore',
      transcript_load_complete: 'ignore',
      create_session_request: 'ignore',
      create_session_response: 'ignore',
      terminal_resize: 'ignore',
      auth_challenge: 'ignore',
      auth_response: 'ignore',
      auth_result: 'ignore',
      kill_session_request: 'ignore',
      kill_session_response: 'ignore',
      session_history_request: 'ignore',
      session_history_response: 'ignore',
      resume_session_request: 'ignore',
      resume_session_response: 'ignore',
      detach_session: 'ignore',
      detach_session_ack: 'ignore',
      register_device_token: 'ignore',
      unregister_device_token: 'ignore',
      daemon_update_available: 'ignore',
      hub_status: 'ignore',
      session_rotated: 'ignore',
      session_views: 'ignore',
    };
    dispatchMessage(msg, handlers);
  }

  function sendHello(): void {
    const clientId = generateId();
    ws.send(serialize(createHello(clientId, '1.0.0', { resumeSessionId: sessionId as UUID })));
  }

  return new Promise<AttachClientResult>((resolve) => {
    function finish(result: AttachClientResult): void {
      if (resolved) return;
      resolved = true;
      restoreTerminal();
      try {
        ws.close();
      } catch {
        // ws may already be closed or in CLOSING state; safe to ignore
      }
      resolve(result);
    }

    ws = new WebSocket(url, capabilityWsOptions() as never);

    const connectionTimer = setTimeout(() => {
      writeOutput(`\n[timed out connecting to daemon at ${host}:${port}]\n`);
      finish({ exitCode: 1, reason: 'timeout' });
    }, timeout);

    function handleProtocolMessage(msg: ProtocolMessage): void {
      if (msg.type === 'hello_ack') {
        // In daemon mode, server sends a preliminary hello_ack with empty sessionId
        // before session creation. Wait for the real one with a valid session ID.
        if (!msg.sessionId) return;
        clearTimeout(connectionTimer);
        attachedSessionId = msg.sessionId;
        const shortId = msg.sessionId.slice(0, 8);

        // Clear screen and home cursor; we stay in the primary screen buffer
        // so the user's terminal emulator provides native scrollback
        writeOutput('\x1b[2J\x1b[H');
        writeOutput(`[attached to session ${shortId}] (Ctrl+B d to detach)\n`);

        // Enter raw terminal mode
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          rawModeSet = true;
        }
        process.stdin.resume();

        // Use DetachScanner for Ctrl+B d detection (supports both standard
        // raw byte 0x02 and kitty keyboard protocol ESC[98;5u)
        detachScannerInstance = new DetachScanner({
          onDetach: () => {
            // Notify daemon of explicit detach so it skips orphan timeout.
            // Wait briefly for the ack to ensure the daemon processes the
            // detach before we close the WebSocket connection.
            if (attachedSessionId) {
              sendMessage(createDetachSession(attachedSessionId));
              detachPending = true;
              detachAckTimer = setTimeout(() => {
                process.stderr.write('[detached]\n');
                finish({ exitCode: 0, reason: 'detached' });
              }, 500);
            } else {
              process.stderr.write('[detached]\n');
              finish({ exitCode: 0, reason: 'detached' });
            }
          },
          onData: (data) => {
            sendInput(data.toString());
          },
        });
        stdinListener = (chunk: Buffer) => {
          detachScannerInstance?.write(chunk);
        };
        process.stdin.on('data', stdinListener);

        // Forward terminal resize. #754: while the status bar is up, its row
        // stays reserved (report rows-1, mirroring wrapper mode's childRows).
        resizeListener = () => {
          const cols = process.stdout.columns || 120;
          const rows = process.stdout.rows || 40;
          sendMessage(createTerminalResize(cols, childRows(rows, statusBar !== null)));
        };
        process.stdout.on('resize', resizeListener);

        // Send initial size -- nudge with cols-1 first, then real size,
        // to force Claude Code to re-render its TUI from the top.
        // Claude Code's TUI only redraws on actual size changes; sending
        // the same size has no effect, so we nudge first.
        if (process.stdout.columns && process.stdout.rows) {
          const cols = process.stdout.columns;
          const rows = process.stdout.rows;
          sendMessage(createTerminalResize(cols - 1, rows));
          resizeNudgeTimer = setTimeout(() => {
            resizeNudgeTimer = null;
            sendMessage(createTerminalResize(cols, childRows(rows, statusBar !== null)));
          }, 50);
        }

        // #754: a remi_status broadcast may have raced ahead of the (real)
        // hello_ack; start the bar from the stored snapshot now.
        if (latestStatus !== null) startStatusBar();

        // Warn if no raw PTY data arrives within a few seconds
        rawPtyTimer = setTimeout(() => {
          rawPtyTimer = null;
          if (!receivedRawPty && !resolved) {
            process.stderr.write(
              '[remi] warning: no raw PTY output received; session may not be producing terminal data\n',
            );
          }
        }, 3000);

        return;
      }

      if (msg.type === 'ping') {
        sendMessage(createPong(msg.id));
        return;
      }

      if (msg.type === 'detach_session_ack' && detachPending) {
        // Daemon confirmed the explicit detach; finish immediately
        if (detachAckTimer) {
          clearTimeout(detachAckTimer);
          detachAckTimer = null;
        }
        process.stderr.write('[detached]\n');
        finish({ exitCode: 0, reason: 'detached' });
        return;
      }

      if (msg.type === 'error' && msg.code === 'SESSION_ENDED') {
        writeOutput('\n[session ended]\n');
        finish({ exitCode: 0, reason: 'session_ended' });
        return;
      }

      if (msg.type === 'error' && msg.code === 'SESSION_BUSY') {
        writeOutput(`\n${msg.message}\n`);
        finish({ exitCode: 1, reason: 'error' });
        return;
      }

      renderMessage(msg);
    }

    ws.onopen = () => {
      // Send hello immediately. If auth is needed, the daemon will send
      // auth_challenge and reject this hello with AUTH_REQUIRED (benign).
      // After auth succeeds, we re-send hello.
      sendHello();
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      const msg = deserialize(data);
      if (!msg) return;

      // If daemon sends auth_challenge, perform handshake then re-send hello
      if (msg.type === 'auth_challenge') {
        if (authInProgress) return; // duplicate challenge; ignore
        authInProgress = true;
        performAuthHandshake(ws, msg)
          .then(() => {
            authInProgress = false;
            sendHello();
          })
          .catch((err) => {
            clearTimeout(connectionTimer);
            writeOutput(`\n[auth failed: ${errorToString(err)}]\n`);
            finish({ exitCode: 1, reason: 'error' });
          });
        return;
      }

      // During auth, the auth-helper's addEventListener handles messages;
      // only process in the caller after auth is done
      if (authInProgress) return;

      handleProtocolMessage(msg);
    };

    ws.onclose = () => {
      clearTimeout(connectionTimer);
      if (!resolved) {
        if (attachedSessionId) {
          writeOutput('\n[connection lost]\n');
        }
        finish({ exitCode: 1, reason: 'connection_closed' });
      }
    };

    ws.onerror = () => {
      clearTimeout(connectionTimer);
      writeOutput(`\n[cannot connect to daemon at ${host}:${port}]\n`);
      finish({ exitCode: 1, reason: 'error' });
    };
  });
}
