# Apple platform knowledge base

Last verified: 2026-10-08 against the current Remi native code and Apple Developer Documentation in Xcode.

This is the adoption guide for Apple APIs that affect Remi's native apps. It records what the current apps actually do, separates the iOS/macOS 26 baseline from newer SDK work, and names the checks required before a platform feature is presented as shipped.

## Current platform boundary

| Area | What ships now | What is not shipped | Adoption decision |
|---|---|---|---|
| Foundation Models | On-device question summaries when `SystemLanguageModel.default` is available, with a deterministic fallback and a 900 ms deadline | A guarantee that Apple Intelligence is available, or a physical-device acceptance result | Keep the feature optional and presentation-only; never block a question notification on generation |
| Notifications | Local notifications created by a running native app after its live connection observes a new question; taps carry a typed machine/session/question destination | Server-originated APNs delivery while the app is terminated, a Notification Service Extension, or lock-screen answer actions | Describe these as local alerts. Remote delivery waits for the secure push design and owner signing |
| Liquid Glass | Native system navigation/materials, semantic question-card content surfaces, and coordinated custom glass groups for question actions, the composer, and conversation selection | A glass surface on every row or section | Let standard controls provide glass automatically; use custom effects sparingly and group adjacent effects |
| Live Activities | Design research only | Widget extension, activity lifecycle, ActivityKit push tokens, and App Intent answers | Build only after secure remote delivery and the signed-answer path are specified and testable |
| App Intents | Design research only | Siri/Shortcuts/App Intent actions in either app | Any answer intent must call the same authenticated answer operation as the app; it must not become a second trust path |

## Foundation Models and Apple Intelligence

`QuestionNotificationSummarizer` checks `SystemLanguageModel.default.availability` before creating a `LanguageModelSession`. This is required: the model may be unavailable because the device is ineligible, Apple Intelligence is disabled, or assets are not ready. The app's normalized, truncated copy is the user-visible fallback in every one of those cases and on generation failure, refusal, invalid output, or timeout.

The summary is untrusted presentation text. It cannot select an answer, change question semantics, influence routing, or replace the full question in the session. The prompt treats the incoming question as data and generated output is normalized and length-limited. Cache entries are keyed by question ID so the notification does not change wording during the same question's lifetime.

Model behavior can change with OS model versions. Before changing the prompt or raising the role of generated text:

1. Run the deterministic unit suite for short, long, empty, timed-out, failed, and malformed generation.
2. Exercise the prompt on every supported model/OS line, including unavailable and model-not-ready devices.
3. Test adversarial question text that asks the summarizer to ignore its instructions, answer the request, or hide risk.
4. Keep a human-readable fallback; no product flow may require a successful generation.
5. Record a physical eligible-device result separately from simulator/build success.

Apple's iOS 27 Foundation Models additions include newer model capabilities and extension points such as image input, reasoning controls, custom backends, and Private Cloud Compute. They are not part of Remi's iOS 26 implementation and must not be used without an availability-gated design and a new privacy review.

## Notifications and background execution

The iPhone and Mac coordinators currently schedule immediate local notifications only after `MachineStore` receives a question over a live connection. They remove pending and delivered notifications when the question ID disappears. On both platforms, a tap decodes `RemiNavigationDestination`, selects the named machine and session, and may select the named agent conversation. When the matching question is present, the session detail places that card before transcript history, scrolls to it, and moves accessibility focus to it. The focus survives an answered-on-another-device update while the short-lived resolved card remains, then clears when the question disappears. A payload that cannot decode or names an unknown machine/session does not guess a destination; `questionID` and `agentID` are optional and their absence does not prevent routing. Simulator notification-tap acceptance remains a separate gate from this caller trace.

This does not wake a terminated app and is not remote push. Background notifications are low priority and are not guaranteed by the system, so they cannot be the sole transport for an urgent approval. A Notification Service Extension may decrypt or rewrite notification content before delivery, but it cannot dynamically redefine registered action titles and its work is time-limited.

Remote notifications, an NSE, and notification actions require all of the following before implementation:

- an authenticated, end-to-end protected payload whose security properties are traced through the live caller path;
- owner-controlled signing and provisioning for the app and extension;
- a stable payload version with explicit expiry, replay protection, and machine/session/question identity;
- the existing daemon authorization boundary for answers, with no trust granted merely because an action came from iOS;
- physical-device tests for foreground, background, force-quit, expiry, duplicate delivery, answer elsewhere, and key loss.

## Live Activities and App Intents

Live Activities are useful for a currently waiting question, elapsed time, machine/session identity, and resolution elsewhere. They are not a durable queue and must end when the question resolves, expires, or the session becomes unavailable. Check `ActivityAuthorizationInfo.areActivitiesEnabled` and observe authorization changes rather than assuming the feature is enabled.

Foreground updates can follow the live connection. Background remote updates require the ActivityKit push token and APNs live-activity topic; ActivityKit supplies that token independently of `UserNotifications`. Button interactions use App Intents. An intent may submit an already valid signed answer or open the app, but must never manufacture authorization, infer an option, or reuse an expired question.

Use an App Intent only when its input is sufficient to display and verify the exact action. Interactive snippets and Siri discoverability are useful future surfaces, but their convenience does not change Remi's authentication or first-answer-wins rules.

## Liquid Glass and SwiftUI

SwiftUI's standard navigation, toolbars, sheets, controls, and materials adopt the current platform appearance automatically. Prefer those components before adding a custom `glassEffect`. Remi keeps question text on a lightweight semantic surface and uses `GlassEffectContainer` for adjacent question actions, composer controls, and conversation selectors. The composer substitutes an opaque background and hairline when Reduce Transparency is enabled, and question-state animation is disabled by Reduce Motion. Avoid many simultaneous effects because they add rendering cost.

Remi's visual rule remains: glass belongs on important interactive cards and controls; repeated session and machine rows stay lightweight. Spacious layout means clear hierarchy and touch targets, not decorative empty areas. Every glass treatment must still pass light/dark contrast, Reduce Transparency, Reduce Motion, VoiceOver, and the app's supported Dynamic Type range.

The iPhone and Mac conversation screens share one session interaction bar for live main conversations, read-only subagent conversations, and finished sessions. It is pinned with a vertical safe-area inset, which keeps transcript content and keyboard avoidance independent from the bar's height, and uses the system's soft bottom scroll-edge transition instead of a manual divider.

Transcript entries use one shared presentation on both platforms: constrained trailing user messages, document-like agent responses, compact expandable tool activity, and semantic error surfaces. Dynamic agent text uses Foundation's inline-only Markdown parser with whitespace preservation; only `http`, `https`, and `mailto` links remain interactive. This is deliberately not a full block-Markdown renderer, so headings, lists, tables, and fenced code blocks retain readable source structure rather than receiving custom block layout.

New-session creation also shares one observable draft model across iPhone and Mac. Machine changes choose that machine's most recent repository, repair an unavailable harness selection, and disable worktree creation for legacy machines. Submission trims user-entered paths, branches, bases, and model names; worktree creation requires a branch, while a blank base means the machine's default base. The UI presents the final machine, destination mode, and harness before Create becomes available. This model is presentation and request construction only: the daemon remains authoritative for repository validation and workspace creation.

Both app roots currently cap Dynamic Type at Accessibility 2 as a deliberate legibility/layout tradeoff. That is the shipping boundary, not full support for every system size. Revisit the global cap by testing and repairing individual layouts before claiming support through Accessibility 5; do not silently lower it further.

## iOS/macOS 27 watchlist

These APIs are research targets, not permission to raise the deployment target:

- `@State` is a macro in the iOS 27 SDK. SDK migration can expose initialization patterns that previously compiled; diagnose those as migration issues rather than rearranging assignments until the compiler accepts them.
- Toolbars add minimization, pinned items, and more explicit overflow behavior. Re-evaluate the compact iPhone session toolbar when the deployment plan includes 27.
- Item-binding alert and confirmation-dialog overloads can remove duplicate optional state.
- `AsyncImage` caching, swipe actions outside `List`, and newer reordering APIs can simplify later transcript and session work.

Every adoption must have an iOS 26 fallback or an approved deployment-target change, focused tests, and a simulator/device pass on both OS generations.

## Verification checklist

Before declaring an Apple-platform capability complete:

- Trace the user event to the real caller and transport; do not use this document as evidence that code ships.
- Check the API's runtime availability and user authorization state.
- Verify failure, cancellation, expiry, and resolution on another device.
- Confirm navigation lands on the exact machine, session, optional subagent conversation, and question card rather than merely the app's root.
- Test through the documented Accessibility 2 shipping cap. Treat raising or removing the global cap as accessibility work that requires layout verification, not as a documentation-only claim.
- Record which checks ran on simulator, which ran on a physical device, and which require owner provisioning.
- Re-run this research when Xcode, the deployment target, or the Foundation Models system model changes.

## Primary Apple references

- [Foundation Models](https://developer.apple.com/documentation/foundationmodels)
- [SystemLanguageModel availability](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability)
- [Generating content and performing tasks with Foundation Models](https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models)
- [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views)
- [UserNotifications](https://developer.apple.com/documentation/usernotifications)
- [Modifying content in newly delivered notifications](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications)
- [Pushing background updates to your app](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)
- [ActivityKit](https://developer.apple.com/documentation/activitykit)
- [Displaying live data with Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)
- [App Intents](https://developer.apple.com/documentation/appintents)
