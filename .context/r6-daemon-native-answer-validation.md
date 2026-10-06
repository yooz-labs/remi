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

The ledger owns the tuple before its first cryptographic await. It checks
current grant, enrollment and subscription epochs and runtime identity before
returning a retained result. New claims additionally require the current signed
push digest, revision, collapse id, offered value and complete action policy.
Initial background answers refuse every optional structured, cancel, free-text
or message field. Both `(device, id)` and `(device, nonce)` index each claim.
There are at most 1,024 retained records and 32 pending records per session;
pending records keep their capacity claim until the real core completes.

The final authority callback holds the actual subscription lock around only
the synchronous effect: held-hook completion, Codex response write or PTY enqueue.
Network completion, question cleanup and downstream notification callbacks run
after that lock is released. An already accepted effect may finish after
revocation; revocation that completes before the effect prevents it.

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
7 tests / 70 assertions on both versions. Six independent causal mutation
families verify the exact effect boundary, refusal preservation and notification
callbacks after lock release.

The ledger tests passed 13 tests / 5,232 assertions on both versions, including
real held-hook decisions at the 1,024-record cap and a real PTY answer still
queued after proof retention expires. Eight independent causal families cover
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
one explicit identical-proof query over a fresh encrypted peer receives the
retained delivered result. Holding one real socket result demonstrates pending
coalescing and same-id conflict refusal. All three scenarios pass 112 checks per
Bun version, with six named independent causal controls, restored source and
natural child exits with no owned-process residuals. Root is repeating those
scenarios on the integrated branch.

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
suite ran at that head. A new corrected-head full gate remains required.

## Remaining acceptance

The 32-pending-per-session bound is not saturated by these tests: the actual
guarded core constrains simultaneous decisions on one session's screen. The
shipping Swift signing and background transport, final combined full suites,
final shipping-client soak, signed
hardware and deployed Worker acceptance remain outstanding. Component tests
and unsigned builds do not substitute for those gates.
