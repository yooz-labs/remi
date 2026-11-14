# Apple platform knowledge base

Last verified: 2026-10-11 against the current Remi native callers, tests, and the physical acceptance recorded in #1242; the "Resizable windows, iPad external displays and iPhone Duo" section was verified on 2026-11-13.

This is the adoption guide for Apple APIs that affect Remi's native apps. It records what the current apps actually do, separates the iOS/macOS 26 baseline from newer SDK work, and names the checks required before a platform feature is presented as shipped.

## Current platform boundary

| Area | What ships now | What is not shipped | Adoption decision |
|---|---|---|---|
| Foundation Models | On-device question summaries when `SystemLanguageModel.default` is available, with a deterministic fallback and a 900 ms deadline | A guarantee that Apple Intelligence is available, or a physical-device acceptance result | Keep the feature optional and presentation-only; never block a question notification on generation |
| Notifications | Typed local question alerts; sealed relay APNs delivery; iPhone and Mac Notification Service Extensions; verified lock-screen actions that open a short-lived authenticated relay channel | Complete signed two-machine Mac acceptance and every remaining recovery/standing-grant scenario in #1242 | Keep local and relay paths distinct in UI and evidence. Never infer secure delivery from ordinary notification permission |
| Liquid Glass | Native system navigation/materials, semantic question-card content surfaces, and coordinated custom glass groups for question actions, the composer, and conversation selection | A glass surface on every row or section | Let standard controls provide glass automatically; use custom effects sparingly and group adjacent effects |
| Live Activities | Design research only | Widget extension, activity lifecycle, ActivityKit push tokens, and App Intent answers | Build only after secure remote delivery and the signed-answer path are specified and testable |
| App Intents | Design research only | Siri/Shortcuts/App Intent actions in either app | Any answer intent must call the same authenticated answer operation as the app; it must not become a second trust path |
| Resizable windows and iPhone Duo | A regular-width shell (sidebar plus content) chosen from the horizontal size class, with a readable column (#1629); the iPhone target is built for iPhone and iPad (`TARGETED_DEVICE_FAMILY = "1,2"`) | A multi-column Board for wide windows (#1745), a recorded run on an iPhone Duo pose, a physical iPad on an external display | Decide layout from size classes and available width only; see "Resizable windows, iPad external displays and iPhone Duo" |

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

The iPhone and Mac coordinators schedule immediate local notifications after `MachineStore` receives a question over a live connection. They remove pending and delivered notifications when the question ID disappears. On both platforms, a local-notification tap decodes `RemiNavigationDestination`, selects the named machine and session, and may select the named agent conversation. When the matching question is present, the session detail places that card before transcript history, scrolls to it, and moves accessibility focus to it. The focus survives an answered-on-another-device update while the short-lived resolved card remains, then clears when the question disappears. A payload that cannot decode or names an unknown machine/session does not guess a destination; `questionID` and `agentID` are optional and their absence does not prevent routing. Simulator notification-tap acceptance remains a separate gate from this caller trace.

The separate relay path registers an APNs token only after notification permission, a signed runtime environment, authenticated relay pairing, and durable machine trust are available. The iPhone and Mac service extensions open sealed content through `RemiPush`; app delegates verify the original capsule and displayed fields before accepting a default tap, dismissal, or semantic action. An action opens a bounded authenticated relay channel and signs the answer with the existing device identity. The source integration suite exercises pairing, registration, opening, and signed delivery against the TypeScript fixture. #1242 records physical iPhone lock-screen Yes and Watch-mirrored No results, while its remaining signed-Mac and recovery gates stay open.

Any extension of remote notification behavior still requires all of the following:

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

Machine onboarding uses the same observable draft on iPhone and Mac. It normalizes direct hosts and relay tokens, enforces the TCP port range, clears stale mode-specific errors as input changes, and constructs endpoints through the existing direct or relay contracts. Both apps show the resulting connection mode before enabling Add. Direct setup continues to disclose that Remi adds no transport encryption, while relay setup requires terminal fingerprint confirmation; the draft changes neither trust boundary.

Neither app root currently caps Dynamic Type. Shipping screens use accessibility-size layouts where compact rows would otherwise truncate, and the preview catalog includes Accessibility 5 states for the primary iPhone and Mac flows. Those previews are design coverage, not physical-device acceptance through every system size; keep runtime acceptance claims separate.

## Resizable windows, iPad external displays and iPhone Duo

Read 2026-11-13 from Apple's own pages; the same text is the basis of the design in [handoff/ipad-board.md](handoff/ipad-board.md) (#1745).
Apple's foldable is the iPhone Duo.
Every fact below carries its source; anything marked NOT FOUND was looked for and is not in the text read, so it is an assumption until someone checks it on a device or in the release notes.

### Verified in Apple's text

| Fact | Source |
|---|---|
| Layout follows size classes and the space the scene has, never the device, the idiom or the orientation. An iPhone-only app on an iPad becomes fully resizable but keeps the phone idiom, so "regular width means iPad" is false and an iPhone app can have any size-class combination. | [Modernize your UIKit app (WWDC26 278)](https://developer.apple.com/videos/play/wwdc2026/278), [Prepare your app for iPhone Duo](https://developer.apple.com/iphone-duo/prepare/) |
| Supported orientations are a preference that resizable environments ignore. Do not branch layout on orientation. | WWDC26 278, [TN3192](https://developer.apple.com/tutorials/data/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key.md) |
| iPhone Duo, outer display: regular vertical and compact horizontal size class in portrait, compact in both in landscape, like other iPhones. Inner display: regular in both, and it does not honor supported orientations. | [Prepare your app for iPhone Duo (tech talk 111461)](https://developer.apple.com/videos/play/tech-talks/111461/) |
| Folding and unfolding resize the app and arrive as a size and trait change; re-read the size when layout runs, not only at launch. Do not use `UIScreen.main.bounds`. | Prepare page, talk 111461 |
| Apps built with an SDK before iOS 27 run centered on the inner display with empty space. The iOS 27 SDK fills most of it and avoids the status bar on the right edge. The iOS 27.1 SDK or later runs edge to edge, with toolbars and tab bars laid out vertically below the status bar. `ReservedRegion` (SwiftUI) and `UIViewReservedRegion` (UIKit) report system-reserved space from iOS 27.1. | Prepare page, talk 111461 |
| Safe-area insets on the inner display are often asymmetric; read each side. Interactive content stays inside the safe area, background art may extend past it. | Talk 111461 |
| Hinge state (closed, partially open, fully open, with an angle) is for interactions, not layout: `onHingeChange` in SwiftUI, `UIHingeInteraction` in UIKit. Layout uses the arrangement and region APIs from "Strike a pose with adaptive layouts on iPhone Duo". | [Leverage multiple displays and scenes on iPhone Duo (tech talk 111464)](https://developer.apple.com/videos/play/tech-talks/111464) |
| The iPhone Duo supports two apps side by side and multiple instances of an app's UI; an app that supports multiple windows on iPad works there. New windows can be requested only for the inner display, not the outer one, and the request can fail, so hide the control when it is unavailable. | Talk 111464 |
| Scene accessories show content on another display alongside the main UI, on iPhone and iPad; the system controls their availability. Apple's example is a non-interactive companion surface. | Talk 111464 |
| On an iPad, moving an app to an external display changes its scene's screen, so never assume `UIScreen.main`. | WWDC26 278 |
| `UIRequiresFullScreen`: from the iOS 27 SDK it no longer opts an app out of resizing; the app is resized in discrete steps. Apple says to remove the key and support all orientations. `UISceneSizeRestrictions` sets a preferred minimum scene size (Apple's example is 500 points wide) and never blocks rotation. `isInteractivelyResizing` reports a live drag. | TN3192 |
| Testing: the iPhone Duo simulator in Device Hub (Xcode 27.1 and later) with open, close, rotate and fold controls; Split View by dragging from the home indicator; the resizable iOS simulator in Device Hub and Xcode Previews; iPhone Mirroring on macOS 27 at extreme sizes; real devices. | Prepare page, talk 111461, WWDC26 278 |

### NOT FOUND in the text read (treat as unverified)

- The point widths of the iPhone Duo inner display and of an iPad window in each size class.
- Whether an iPad on an external display on iPadOS 27.x gives an app a free-form, resizable, interactive window, or mirrors, or shows only a scene accessory. A third-party summary of the UIKit changes names `UISceneAccessory.externalNonInteractive`; no Apple text read confirms it. Only a physical iPad on a display, or the iPadOS 27 release notes read in a browser, settles this.
- Owner observation, not Apple text (2026-11-13, an iPad on iPadOS 27.2): an app window can be shrunk to almost phone width, grown to full screen, and moved beyond that onto an external display as a larger window. This is the behavior the Board is designed for; it has not been run with Remi on an external display, and the iPad's size class at the smallest window is not recorded.
- A maximum scene size, and Stage Manager behavior.
- The `developer.apple.com/documentation` pages for the release notes and the iPhone Duo technology overview render their text in the browser, so an automated fetch returns only a title; read them by hand. The `videos/play` pages return their transcripts.

### What Remi does with it (rules)

1. A layout decision reads the horizontal size class or the width the view was actually given (`RemiLayoutMode`, `onGeometryChange`), never `UIDevice`, `userInterfaceIdiom`, orientation, a device name or `UIScreen.main`.
2. Folding, unfolding, Split View, a window drag and an external display are all the same event: the size changes while the app runs. State a person is holding (a draft, the focused tile, scroll position) lives above the layout switch so a size change does not rebuild it; #1629 already does this for the draft.
3. The Board's column count comes from the width of the Board's own pane (the window minus the sidebar), through `RemiBoardOrder.columnCount`, so it is the same rule on an iPad, in a narrow iPad window, on the unfolded Duo and in the Mac window.
4. Any change to the shell or the Board is accepted at the sizes in [VISUAL-ACCEPTANCE.md](VISUAL-ACCEPTANCE.md), including an iPad and an iPhone Duo pose; "checked on iPad and on iPhone Duo" without a receipt is not evidence.
5. The iOS 27.1 SDK moves toolbars and tab bars on the Duo inner display. Re-check the shell when the toolchain moves, and record the Xcode build.

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
- [Prepare your app for iPhone Duo](https://developer.apple.com/iphone-duo/prepare/)
- [Prepare your app for iPhone Duo (tech talk 111461)](https://developer.apple.com/videos/play/tech-talks/111461/)
- [Leverage multiple displays and scenes on iPhone Duo (tech talk 111464)](https://developer.apple.com/videos/play/tech-talks/111464)
- [Modernize your UIKit app (WWDC26 278)](https://developer.apple.com/videos/play/wwdc2026/278)
- [TN3192: migrating from UIRequiresFullScreen](https://developer.apple.com/tutorials/data/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key.md)
