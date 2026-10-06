# R6 daemon native-answer component validation

This is a local development checkpoint for issue #1201, not acceptance of the
shipping native answer flow or the final relay gate. The relay remains off by
default. Swift proof signing and fresh native WSS transport are not implemented
at this checkpoint; signed iPhone/Watch and deployed Worker acceptance remain
the original owner gates.

## Implemented caller path

The shared protocol registers `native_answer` as client-to-daemon only. Actual
`Connection` dispatch bypasses ordinary receipt and resolved-answer caches and
calls `sharedEvents.onNativeAnswer`. In the source CLI, that callback reaches
one `NativeAnswerLedger` constructed for the child process, using its current
secure-push runtimes, contexts, subscription store and the same guarded answer
core used for held hooks and typed answers.

`HubRelay` verifies the signed proof against the current authenticated peer and
machine before passing it to `ChildProxy.nativeAnswer`. The proxy uses the
actual capability-authenticated child WebSocket and correlated result handling;
an identical pending body coalesces, while a different body with the same id
is refused before its waiter can replace the original.
Every coalesced waiter is settled with the first caller's outcome on every exit path of that caller.
That includes a send that fails before the child returns any result (a closed or replaced child socket, an unknown session).
Before fix track C such a waiter waited forever, and its peer application slot (32 per peer) stayed taken for the peer's lifetime.

The ledger owns the tuple before its first cryptographic await. It checks
current grant, enrollment and subscription epochs and runtime identity before
returning a retained result. New claims additionally require the current signed
push digest, revision, collapse id, offered value and complete action policy.
Initial background answers refuse every optional structured, cancel, free-text
or message field. Both `(device, id)` and `(device, nonce)` index each claim.
There are at most 1,024 retained records and 32 pending records per session;
pending records keep their capacity claim until the real core completes.

A retained result is served only while the proof itself is unexpired, which is at most 30 seconds from issue.
After expiry the exact proof reads `stale` even if its answer was delivered, and nothing is applied twice.
The five seconds of retention past expiry keep the `(device, id)` and `(device, nonce)` claims, so a different tuple that reuses either is a `conflict`.
They are not a result window.
Serving an expired proof's result was decided against.
The hub, the proxy, the ledger and the shared verifier each refuse an expired proof by design (the plan requires a late answer to be refused), and a longer retention horizon is an owner decision.

The final authority callback (`commit`) holds the actual subscription lock around only
the synchronous effect: held-hook completion, Codex response write or PTY enqueue.
Network completion, question cleanup and downstream notification callbacks run
after that lock is released. An already accepted effect may finish after
revocation; revocation that completes before the effect prevents it.
For Claude the callback reaches the gate through `ClaudeDecisions.answerHeld` and the hook bridge's `SessionGateHandle.answerHeld`.
Before fix track C that handle re-declared the method with two parameters, so TypeScript accepted it and the callback was silently dropped: held-hook completion ran without the lock and a refusing callback was ignored.
The handle is now typed as the gate's own method and forwards `(...args)`, and `ClaudeDecisions` reads its type from the handle, so a gate that stops taking `commit` fails to compile at the forwarding call.
TypeScript still accepts a hand-written forwarder with fewer parameters, so two pins catch that regression at run time: one through the launched Claude session and one through `setupHookBridge`.
`CodexDecisions` is itself the session's decision channel, so its callback needs no forwarder.
A pin through `gateAnswerDeps` with a revoked store covers that composition.

## Diagnostics

Each refusal and each fault is logged without an id, nonce, key, signature, answer or path.
A refusal is a decision: `[NativeAnswer] refused (<reason>)`.
The reason is a code the shared verifier names (for example `EXPIRED` or `BAD_SIGNATURE`) or one of `unexpected-field`, `runtime-not-current`, `device-not-current`, `proof-not-current`, `epoch-changed`, `action-not-current`, `authority-revoked`, `conflict` and `busy`.
A fault is a thrown error, usually a store or lock error such as `InterprocessFileLockError` after the 2 second lock wait: `[NativeAnswer] fault (<error name>) while verifying|claiming|committing; nothing applied`, written through `logError`.
The outcome sent to the client is unchanged for both: `stale` (or `conflict` and `busy` for those two reasons), and a final-commit refusal or fault keeps the live hold and card.
Only the log tells a lock fault from a revocation.
Refusal reasons found inside the subscription lock are logged after it is released.

`HubRelay` re-reads a ready peer's authority on every frame in both directions.
An unreadable authority store logs `Relay authority store unreadable (<error name>); failing closed, not a revocation`, and a revoked or replaced grant logs `Relay authority no longer current; failing closed`.
Each is logged once per change of verdict for a peer.
Both close the peer at their callers (`sendRaw` for outbound frames, `route` for inbound ones).
That is deliberate for the store fault.
The channel is ordered and complete, so refusing one frame and staying open would drop it silently and leave the client's state diverged.
A close makes the client reconnect and resync, and a reconnect re-captures authority under the same lock: a persistent fault keeps the peer out, and a transient one recovers.
A peer can therefore be closed during lock contention; the log line now says so.

## Component evidence

The strict codec passed 36 tests / 678 assertions on Bun 1.4.2 and 1.3.11, with
eight independent causal mutation families and restored controls. It preserves
the exact signed framing, optional-field presence and UTF-8 string bytes.

Actual direct and decrypted Hub ingress passed 13 tests / 83 assertions on both
versions. These construct the real WebSocket server, Connection, encrypted
channel and Worker. They cover duplicate root discriminators, nested native
duplicates, schema and size refusals, malformed UTF-8, leading BOMs and ordinary
large/deep legacy JSON. Both leading-BOM cases first failed at named assertions:
the default fatal decoder stripped the BOM. Both ingress decoders now use
`ignoreBOM: true` to retain it for JSON refusal.

Actual held HTTP, Codex Unix WebSocket and queued PTY effect tests passed
7 tests / 70 assertions on both versions at that checkpoint; the file now has 8
tests / 79 assertions on both versions. Six independent causal mutation
families verify the exact effect boundary, refusal preservation and notification
callbacks after lock release.
Those tests hand the answer handlers the raw `AutoApproveGate`, so they did not exercise the Claude bridge handle (see fix track C below).

The ledger tests passed 13 tests / 5,232 assertions on both versions at that
checkpoint, including real held-hook decisions at the 1,024-record cap and a
real PTY answer still queued after proof retention expires.
With fix track C's six added tests the file has 19 tests / 5,286 assertions on both versions. Eight independent causal families cover
captured epochs, optional fields, digest, pre-await ownership, nonce conflicts,
capacity, complete action titles and pending retention. Removing only the live
pending retention guard made the overflow decision incorrectly execute, failing
the named `busy` assertion; restored controls pass.

The source-CLI child composition fixture constructs a real HubRelay/ChildProxy,
Worker SQLite, verified local TLS ingress and owned APNs receiver. At frozen
daemon head `a079c3e0`, both Bun versions pass 34 positive checks: a genuinely sealed and
opened actionable push produces a signed No proof, the held HTTP hook receives
deny, and a fresh encrypted peer receives the retained delivered outcome for
the identical proof. This fixture boots the source child directly; it does not
prove the source CLI hub supervisor's boot/spawn path. An actual lost child
socket result returns correlated uncertain and produces no automatic resend;
one explicit identical-proof query over a fresh encrypted peer, made inside the
proof's lifetime, receives the retained delivered result. Holding one real socket result demonstrates pending
coalescing and same-id conflict refusal. All three scenarios pass 112 checks per
Bun version, with six named independent causal controls, restored source and
natural child exits with no owned-process residuals.

The separate source supervisor fixture boots `serve` itself, observes its
session-less status and PID, sends an encrypted create request and checks the
actual spawned source child's runtime, flags, port, session id, registry,
working directory and process birth. It follows the same original sealed push
to a signed No and actual HTTP deny, then queries the retained result over a
fresh encrypted peer. Both actual CLI runtimes pass 40 checks, with four named
causal mutation controls and restored runs. The transparent disposable TLS proxy
runs on Bun 1.4.2 for both cases. Older-proxy upgrade failures were isolated,
preserved and excluded; TLS verification was never disabled.

Root repeated the final ledger tests on the integrated branch: 13 / 5,232 on
both versions, and all three child/libraryHub scenarios: 112 checks per version
with natural child exit and no owned-process residuals. Four project type
graphs, scoped ingress/route type checks, changed-file Biome, spelling and diff
checks pass.

The first frozen full suite at `670e8998` finished 7,220 pass / 22 skip / 2 fail
on Bun 1.4.2, with no owned-process residuals. Both failures were source guards:
the new codec imported an application-protocol type and its explicit timestamp
conversion matched a clock-read regex. `b3fa628f` defines the local selection
shape and parses expressions in the guard, distinguishing explicit date
conversion from ambient clock reads. Five independent actual-source controls
fail the appropriate guard on both runtimes and pass after restoration; the
focused baseline/restored set is 27 / 662. Emitted codec JavaScript is unchanged.
This failed full suite is retained as diagnostic evidence; no Bun 1.3.11 full
suite ran at that head.

The corrected frozen full suite at `3aab77a4` finished 7,222 pass / 22 skip /
1 fail on Bun 1.4.2. The one failure was an existing attach status test's fixed
mid-question observation. Its original full-run cause remains unproven. A real
600 ms response delay independently demonstrated that the observation could
occur before the production heartbeat deadline, with unchanged render code.
`0e9edf6a` changes only the test: it observes the actual initial paint, sends the
status change, then checks the heartbeat while the question and busy PTY remain
live. Restoring the old held-question freeze fails that named assertion on both
runtimes; restored controls and the full attach file pass 23 / 58 on both.
No production change, test suppression or overall timeout increase was made.
The failed full run had no owned-process or broader clone-path residuals;
Bun 1.3.11 full execution did not start. A fresh corrected-head full gate is
still required.

## Fix track C evidence (#1222 review)

An independent review reproduced two defects and raised three more; each was confirmed against the code first.
Every fix has a pin test in its own commit that failed on the unfixed code at the named assertion, and the pins fail again when the fix is reversed.
No pin replaces a decision, crypto or storage component.
The lock faults use a real lock file owned by a live foreign process, which the store waits out for its real 2 second timeout.

- Claude dropped the final authority callback: both pins (through the launched Claude session and through `setupHookBridge`) saw `resolved` instead of `authority-refused`. A third test confirms the Codex composition through `gateAnswerDeps` already forwarded it.
- A coalesced identical proof hung when the first caller's send failed: the second waiter was still pending after the first returned `uncertain`, against a real child WebSocket server that closes before its hello acknowledgment and against a registry entry replaced during the wait. A guard test keeps one wire frame for one shared child result.
- Result retention past expiry: documented as a limit and pinned (see above), no behavior change.
- Silent failures: seven pins cover the three ledger phases with a real lock fault, the reason of each refusal with no id, nonce, question id or signature in any line, a revoked grant at the final commit, and the hub's two verdicts for a real peer.

The scoped suites pass on Bun 1.4.2 and Bun 1.3.11: 1,617 pass / 3 skip / 0 fail across 55 files.
They cover the daemon `remote`, `harness`, `auto-approve` and hook bridge tests, the answer-effect authority test, the secure push store test, and the relay R3, R5 subscription, R6 ingress and secure push transport integration tests.
Per file on both versions: the ledger 19 tests / 5,286 assertions, the child proxy file 3 / 10, the hub authority fault file 2 / 7.
The source CLI route fixture passes its three scenarios (34, 36 and 42 checks) on both versions, and the supervisor fixture passes 40 checks on Bun 1.4.2.

## Remaining acceptance

The 32-pending-per-session bound is not saturated by these tests: the actual
guarded core constrains simultaneous decisions on one session's screen. The
shipping Swift signing and background transport, final combined full suites,
final shipping-client soak, signed hardware and deployed Worker acceptance
remain outstanding. Component tests
and unsigned builds do not substitute for those gates.
