import UserNotifications

/// #719 — Notification Service Extension (NSE).
///
/// Registers a PER-NOTIFICATION dynamic UNNotificationCategory whose action
/// titles are the real option labels, for the two cases the three static
/// categories (REMI_YN / REMI_YNA / REMI_MULTI, registered once at launch in
/// AppDelegate.registerNotificationCategories) cannot express:
///   - a single-question AskUserQuestion pick (arbitrary labels, e.g.
///     "PostgreSQL" / "MySQL" / "MongoDB" — REMI_YN/YNA's hardcoded
///     Yes/Yes-always/No titles would mislabel these).
///   - a 4-option structured-suggestion permission card, whose static
///     REMI_MULTI titles are the generic "Option 1..4" placeholders.
///
/// Runs in its OWN process, separate from the main app. `RemiAnswerRelay`
/// (App/RemiAnswerRelay.swift) already handles ANY category's `OPT_n` action
/// tap — it reads `response.actionIdentifier` and looks up `opt_<n>` in the
/// notification's userInfo, with no category allowlist — so a dynamic
/// category's taps route identically to a static one's.
///
/// GRACEFUL DEGRADATION (non-negotiable, #719): every guard below that is not
/// satisfied, or the extension simply not running in time, falls through to
/// delivering `bestAttemptContent` UNCHANGED — i.e. with whatever
/// `categoryIdentifier` the daemon's push already set (a static category, or
/// none). The daemon's `category` field is therefore a genuine fallback, not
/// just today's behavior: this extension can only ADD a better lock-screen
/// experience, never subtract one.
class NotificationService: UNNotificationServiceExtension {

    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let bestAttemptContent = bestAttemptContent else {
            // Not expected (mutableCopy() of a UNNotificationContent always
            // succeeds), but the contract is "never drop the notification" —
            // hand back the original content verbatim rather than risk it.
            contentHandler(request.content)
            return
        }

        buildDynamicCategory(for: bestAttemptContent) { [weak self] in
            self?.deliver()
        }
    }

    override func serviceExtensionTimeWillExpire() {
        // iOS gives ~30s total. If buildDynamicCategory's async
        // getNotificationCategories/setNotificationCategories round trip
        // hasn't completed yet, deliver bestAttemptContent AS-IS: it still
        // carries whatever categoryIdentifier the daemon's push set (the
        // static fallback), so a slow/expired NSE run degrades to exactly
        // pre-#719 behavior rather than losing the notification.
        deliver()
    }

    /// Delivers `bestAttemptContent` exactly once. `didReceive`'s own
    /// completion and `serviceExtensionTimeWillExpire` can race (the OS may
    /// call the latter right after the former fires); clearing both refs after
    /// the first call makes a second call a no-op instead of double-invoking
    /// `contentHandler`.
    private func deliver() {
        if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
        contentHandler = nil
        bestAttemptContent = nil
    }

    /// Attempts to attach a dynamic category built from `opt_0..opt_N` in the
    /// notification's userInfo. ALWAYS calls `completion` exactly once — every
    /// guard failure calls it synchronously without touching `content` (so the
    /// daemon's original `categoryIdentifier` survives untouched), and the one
    /// success path calls it from the `setNotificationCategories` callback.
    private func buildDynamicCategory(
        for content: UNMutableNotificationContent,
        completion: @escaping () -> Void
    ) {
        let userInfo = content.userInfo

        // Gate: the daemon sets dynCategory="1" only for a single-question
        // 2-4 option prompt with real labels (notification-dispatcher.ts
        // computeDelivery, #719). Absent flag or missing/empty opt_0 -> leave
        // the daemon's static `category` (aps.category) as the fallback.
        guard (userInfo["dynCategory"] as? String) == "1",
            let firstLabel = userInfo["opt_0"] as? String, !firstLabel.isEmpty
        else {
            completion()
            return
        }

        // Collect opt_0..opt_N, stopping at the first missing/empty index or
        // at index 5 (6 options max). The daemon's own gate today caps at 4
        // options; this ceiling is a defensive upper bound matching the option
        // count #719 originally scoped for AskUserQuestion picks, so a future
        // loosening of the daemon gate does not require an NSE change.
        var labels: [String] = []
        for i in 0...5 {
            guard let label = userInfo["opt_\(i)"] as? String, !label.isEmpty else { break }
            labels.append(label)
        }
        guard labels.count >= 2 else {
            completion()
            return
        }

        let actions = labels.enumerated().map { (idx, label) -> UNNotificationAction in
            // A label starting with "No" (the honest Yes/No/Always fallback
            // set, or a "No, cancel"-style pick) renders destructive (red),
            // matching the static REMI_YN/YNA convention in AppDelegate.swift.
            let destructive: UNNotificationActionOptions = label.hasPrefix("No") ? [.destructive] : []
            return UNNotificationAction(
                identifier: "OPT_\(idx)",
                title: truncated(label, to: 24),
                options: destructive
            )
        }
        guard !actions.isEmpty else {
            completion()
            return
        }

        // Keyed by questionId so concurrent distinct questions never collide;
        // falls back to a fresh UUID (still correct — just not de-duplicated
        // against a retry of the identical question, which is harmless: an
        // orphaned category left registered from an earlier notification is
        // inert until a notification's categoryIdentifier references it again).
        let questionId = (userInfo["questionId"] as? String) ?? UUID().uuidString
        let categoryId = "REMI_DYN_\(questionId)"
        let category = UNNotificationCategory(
            identifier: categoryId,
            actions: actions,
            intentIdentifiers: [],
            options: []
        )

        // KNOWN RACE (#719): this extension runs in its OWN process, separate
        // from the main app (which registers REMI_YN/YNA/REMI_MULTI once at
        // launch in AppDelegate.registerNotificationCategories). We read the
        // CURRENT category set via getNotificationCategories and UNION ours
        // in — never replace wholesale — specifically so a category this
        // extension does not know about (e.g. one the app registered) is never
        // dropped. Whether this extension's setNotificationCategories call
        // lands in time for THIS notification's action buttons is itself a
        // race against the ~30s extension budget and Apple's undocumented
        // internal timing; if it loses, `content.categoryIdentifier` is never
        // rewritten (still whatever the daemon's push set), which is exactly
        // the static-category fallback #719 requires as the safety net.
        UNUserNotificationCenter.current().getNotificationCategories { existing in
            var merged = existing
            merged.insert(category)
            UNUserNotificationCenter.current().setNotificationCategories(merged)
            content.categoryIdentifier = categoryId
            completion()
        }
    }

    private func truncated(_ s: String, to maxLength: Int) -> String {
        guard s.count > maxLength else { return s }
        return "\(s.prefix(maxLength))…"
    }
}
