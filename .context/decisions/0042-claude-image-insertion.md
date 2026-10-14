# ADR 0042: Explicit Claude image-reference insertion

**Status:** accepted; signed direct Claude host and web caller implemented; native conformance separate
**Date:** 2026-10-13
**Owner:** Yahya

## Context

[ADR 0041](0041-direct-image-staging.md) is the accepted staging operation.
Direct staging and its web caller landed in #1487; queued input guards landed in #1489.
Staging retains a bounded owned JournalRead and gives the client an opaque artifact ID.
It never types into the harness.

The [installed Claude check](../../docs/claude-image-insertion-characterization.md) measured quoted paths with spaces, JPEG and extensionless PNG input on Claude Code 2.1.296.
Image content entered the conversation on submission, not on the no-Enter reference write.
Submitted image encodings persisted through a normal exit/resume without the originals.
The resumed color answer is consistent with both the retained images and earlier text; compaction and isolated image-only recall remain unmeasured.
Deleting a new draft reference's original before Enter produced no image attachment.

The owner accepted the two-message contract, capability name, original-connection
restriction and visible draft expiry on 2026-10-13.
The separately authorized exact `.artifact` route check failed: neither image
became an embedded attachment. The filename correction landed through #1495.
One separately approved corrective turn then embedded the exact original PNG
and JPEG from their actual retained paths outside the CLI project, with spaces
in the private home path. The answer correctly identified both images' colors.
The measured draft write contained zero CR/LF before one explicit Enter.
These observations change no wire field or deadline and do not make insertion available.

## Decision

### 1. Add one staged image to the current draft

The client offers an explicit **Add to draft** action after successful staging.
It is gated by a separate `image_insertion` capability, not by `image_staging` alone.
The host supplies one literal ` @"/absolute/generated/artifact" ` reference through the existing serialized PTY queue.
There is no Enter, automatic turn, clipboard change or implicit Codex operation.
The result means a reference was written, not that Claude read the image.

Use only the authenticated attached direct Claude connection that completed the upload in the first version.
Reconnect/detach does not revive insertion authority, even while retained storage remains charged.
Relay and Codex support keep their separate gates.
Contract acceptance alone registers or advertises no message or capability.

### 2. Exact two-message contract

Use ADR 0041's strict frame/envelope validation and bounds: valid Unicode, no duplicate or unknown members, bounded raw frame, canonical UUID/timestamp/opaque ID/binding spellings.
Protocol version 1 is unchanged.

| Direction/type | Exact fields beyond `type`, `id`, `timestamp` |
|---|---|
| Client `image_insert_request` | `sessionId`, `binding`, `artifactId` |
| Host `image_insert_result` | `requestId`, `sessionId`, `outcome`, `code` |

`outcome` is exactly `inserted`, `refused` or `uncertain`.
Valid outcome/code pairs are:

| Outcome | Codes |
|---|---|
| `inserted` | `none` |
| `refused` | `malformed`, `unavailable`, `busy`, `conflict`, `expired`, `binding_changed`, `prompt_up` |
| `uncertain` | `delivery_unknown` |

There are no optional fields, host paths or diagnostics in these messages.
Correlate response type, request ID and session ID to the original request; its artifact ID is held in the client request context.
Uncorrelatable malformed input closes the transfer connection, as staging does.
Unknown/foreign artifacts, revoked or unreadable grants and lost attachment use `unavailable` without revealing ownership.
Specific lifecycle codes require the currently authorized owning connection/grant.
Ordinary transport ack remains separate from the insertion result.

### 3. One possible write per artifact

Reuse the staged reader, reservation and original owner capture.
Check the original signed socket, grant incarnation, attached live session/runtime, exact binding and staged expiry before acquisition and at the actual queued effect.
Check `promptUp` there using the same harness decision channel as chat; this retains that signal's documented dialog-detection limits.
Validate the held artifact and current named path immediately before the reference effect.
The client supplies no filename or filesystem path.

For this first route, quoted spaces are supported; reject host reference paths containing literal quotes, backslashes or control characters before any possible write.
Those spellings remain unmeasured on the installed CLI.
Do not silently rewrite a configured path or make another image copy to avoid the restriction.

Record retirement immediately before the first possible terminal write.
A successful sink return produces `inserted`; an error after that boundary produces `uncertain`.
Neither a fresh request ID nor a lost result permits a second write of that artifact.
Keep one bounded recorded outcome while its artifact remains usable; identical request retries return that outcome, never another effect.
Request reuse with different fields is `conflict`.
A refusal before any possible write permits a later explicit attempt if the original authority/deadline still holds.
Restart does not restore transfer or insertion authority, so it cannot replay a retired effect.

### 4. Expiration is visible product behavior

Keep the original at-most-24-hour/session-exit staging deadline and quotas.
Insertion and retries never extend them.
An added reference must be submitted before that deadline and before this Remi session ends.
The client displays **Added to draft. Send before [expiry].** and changes that local status to expired when the deadline or session ends.
An expired unsent reference can no longer attach its image; the person must upload again and remove the expired reference from the terminal draft.
Remi does not edit a person's existing terminal draft automatically.

This is a deliberate bounded draft lifetime, not a promise that an unsent image survives indefinitely.
Submitted images use the measured embedded-transcript lifecycle; do not claim later file reads or compaction never need the original.
Cleanup still proves deletion before releasing the original reservation and retains failed-cleanup debt.
No retention extension or second storage namespace is introduced.

## Availability gates

Owner acceptance of the two-message contract, `image_insertion` name,
first-version connection restriction and expiring unsent draft is recorded above.
The corrected exact managed filename route passed on the installed CLI.
Managed acquisition/one-effect retirement, the bounded outcome coordinator, strict shared vectors and direct host dispatch/directions are implemented.
Source controls pass on Apple Silicon Mac with both Bun versions; the actual compiled CLI caller passes on all three supported hosts and both Bun versions, including a real HTTP permission hold and No answer with an inert CLI.
The web caller reuses its existing upload controller and authenticated direct socket. It offers explicit Add to draft, correlates strict results, retains the original expiry and uses one expiry timer rather than polling. An uncertain status check resends exactly the original request after an explicit click; it cannot create a fresh effect. The ordinary Send action is separate, including image-only Send, and its correlated delivered input receipt releases the local draft status. Until then, replacing a known unsent image is disabled so its original deadline remains visible.

The host advertises `image_insertion` only with the real coordinator and current supported signed direct Claude attachment. Base/hub, relay, Codex and capability-only peers do not gain it. Actual production App rendering at phone, tablet and desktop sizes and a paused-daemon retry control accompany the source and compiled evidence. A local finite expiry control is not a 24-hour device soak.
Real signed socket/grant/session/binding/held-hook controls must prove zero bytes on refusal, one reference and zero CR/LF on success, and no replay after uncertainty.
Run source/compiled controls on the three supported hosts and both Bun versions; native runs the shared conformance corpus independently.
Do not advertise the capability until the actual handler and client caller pass those gates.
