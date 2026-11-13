# Codex asynchronous questions and replies (#1687)

The owner now sees conversation history in the app and supplied the raw question-reply envelope that needs proper rendering, notification and answering. Read-only inspection of installed Codex 0.164.0 confirms asynchronous questions are `agentMessage` items with `delivery: "async"`, a source call ID and `questions: [{title, options}]`. The paired reply is a user message containing `<send_user_message_question_reply>` with answer/question/questionItemId records. Remi currently ignores the metadata and renders both serializations as prose.

## Implementation

1. Add a bounded strict codec for the observed question metadata and reply envelope. Preserve original call ID and question indices; render recognized history as readable questions/answers. Unknown or malformed forms remain ordinary text, never actionable guessed questions.
2. Present live pending asynchronous questions through the existing Remi multi-question card/selections contract. Retain raw source titles/options separately from escaped display. Confirm replies before recovering pending questions from history so answered historical forms do not push again. Full recovery is bounded; incomplete history never invents pending questions. Existing permission approvals remain a separate channel.
3. Reply only to a current card on its current bound main thread/runtime/app-server epoch, through the existing guarded Codex text writer's start/steer request. Send one exact structured user-reply envelope with a fresh client message ID; no PTY input, permission response, config override or automatic replay. Extend the internal decision seam to await this result while preserving synchronous Claude answers. Existing answer_result uncertainty is retained; an uncertain submission closes local retry authority and tells the person to inspect the conversation.
4. Reuse the paired APNs pipeline: complex forms get the approved short Review request action, then the full current form in the app. Expiry, revocation, preferences, current context and recipient checks remain unchanged.

The public Remi question/selection and answer-result wire already carries these values; no new public message family or permission meaning is required. Codex's asynchronous-question frontend does not expose an atomic cross-frontend question claim in its public text API. Remi can make at most one submission per local question lifetime and observe/recheck outside replies; do not claim global first-answer arbitration against another Codex frontend. Request acceptance is not model completion.

## Verification

Use real QuestionStore/SessionRegistry/MessageAPI and actual Codex client/writer transport controls, with redacted copies of the observed item shapes. Cover metadata bounds, multiple/free-text choices, exact source-index mapping, formatted history, old replies preventing recovered pushes, partial external answers, thread/link/identity changes across awaits, concurrent answers, final authority refusal, uncertain acceptance and zero PTY writes. Do not answer a live owner question, run an account-backed model turn, restart owner daemons or sign/publish apps in diagnostics. Review and hosted gates precede rollout; signed phone/Watch and real owner question receipts remain separate.

## Separate resume limitation

The owner confirmed `/resume` inside Codex. ADR 0033 already records that this emits no `thread/started`, so Remi keeps the launch thread. The local older wrapper points to a missing rollout; another thread in its directory being active does not prove it belongs to that wrapper. Never rebind by newest thread or directory alone. An automatic resume fix needs an authoritative per-CLI identity signal; the existing explicit `remi codex resume <thread-id>` launch remains the verified binding path.
