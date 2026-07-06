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
/// satisfied, the extension not running in time, OR the category
/// registration racing and losing on read-back (see `buildDynamicCategory`),
/// leaves `bestAttemptContent`'s `categoryIdentifier` UNCHANGED — i.e.
/// whatever the daemon's push already set (a static category, or none). The
/// daemon's `category` field is therefore a genuine fallback, not just
/// today's behavior: this extension can only ADD a better lock-screen
/// experience, never subtract one.
class NotificationService: UNNotificationServiceExtension {

    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    /// Serializes both delivery call sites — `didReceive`'s async completion
    /// (invoked from whatever queue `getNotificationCategories` calls back
    /// on) and `serviceExtensionTimeWillExpire` (called by the OS) — so the
    /// check-then-clear in `deliver()` is atomic. `UNNotificationServiceExtension`
    /// requires the content handler be invoked EXACTLY once; calling it twice
    /// is undefined behavior, and without this the two sites can race.
    private let deliveryQueue = DispatchQueue(label: "remi.nse.delivery")

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
        // Synchronous (via deliver()'s deliveryQueue.sync): the OS may
        // terminate this extension's process as soon as this method returns,
        // so the content handler must be invoked BEFORE we return here, not
        // queued for later.
        deliver()
    }

    /// Delivers `bestAttemptContent` exactly once. Runs the check-then-clear
    /// on `deliveryQueue` so a concurrent call from the other call site (see
    /// the property doc above) observes a fully-cleared or fully-set state,
    /// never a torn one — the second caller then sees `nil` and is a no-op
    /// instead of double-invoking `contentHandler`.
    private func deliver() {
        deliveryQueue.sync {
            if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
                contentHandler(bestAttemptContent)
            }
            contentHandler = nil
            bestAttemptContent = nil
        }
    }

    /// Process-wide cap on REMI_DYN_* categories accumulated in
    /// `UNUserNotificationCenter`'s registered set over this extension
    /// process's lifetime (#719 review). Without a cap, a long-lived process
    /// handling many sequential/concurrent questions would grow the category
    /// set without bound. 16 is generous headroom for concurrent teammate
    /// questions while keeping the set finite.
    private static let maxDynCategories = 16
    private static let dynCategoryPrefix = "REMI_DYN_"

    /// Attempts to attach a dynamic category built from `opt_0..opt_N` in the
    /// notification's userInfo. ALWAYS calls `completion` exactly once — every
    /// guard failure calls it synchronously without touching `content` (so the
    /// daemon's original `categoryIdentifier` survives untouched), and the one
    /// success path calls it after the read-back barrier below resolves.
    private func buildDynamicCategory(
        for content: UNMutableNotificationContent,
        completion: @escaping () -> Void
    ) {
        let userInfo = content.userInfo

        // Gate: the daemon sets dynCategory="1" only for a single-question
        // prompt with real labels, currently 2-4 options
        // (notification-dispatcher.ts `selectDynOptions`, #719). Absent flag
        // or missing/empty opt_0 -> leave the daemon's static `category`
        // (aps.category) as the fallback.
        guard (userInfo["dynCategory"] as? String) == "1",
            let firstLabel = userInfo["opt_0"] as? String, !firstLabel.isEmpty
        else {
            completion()
            return
        }

        // Collect opt_0..opt_N, stopping at the first missing/empty index or
        // at index 5 (6 options max). INVARIANT CHAIN (#719 review): the
        // daemon's `selectDynOptions` gates at 2-4 options today; the
        // signaling worker's `wantsDynCategory` gate and this ceiling both
        // allow up to 6 — a defensive upper bound so a future loosening of
        // the daemon's gate (up to 6) needs no worker/NSE change. Keep all
        // three in sync if the ceiling itself ever moves.
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
            let destructive: UNNotificationActionOptions = isNegativeLabel(label) ? [.destructive] : []
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
        let categoryId = "\(Self.dynCategoryPrefix)\(questionId)"
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
        // extension does not know about (e.g. one the app registered) is
        // never dropped.
        //
        // WATCH MIRRORING UNVERIFIED (#719 review, on-device verification
        // list): the app's static categories are known to mirror to a paired
        // Apple Watch; whether a category registered from THIS EXTENSION
        // process (rather than the main app process) mirrors the same way is
        // NOT yet confirmed on-device.
        UNUserNotificationCenter.current().getNotificationCategories { existing in
            var merged = existing
            let dynCategories = merged.filter { $0.identifier.hasPrefix(Self.dynCategoryPrefix) }
            if dynCategories.count >= Self.maxDynCategories {
                // Evict arbitrary excess (Set order is unspecified but that is
                // fine here) so the process-wide set never grows unbounded.
                // An evicted category only degrades an OLD, still-displayed
                // notification back to no action buttons — tapping it still
                // opens the app via the default action, never a crash or lost
                // notification. Do NOT prune ALL other REMI_DYN_* categories:
                // concurrent questions in flight need their own distinct
                // categories so their action buttons don't clobber each other.
                let excess = dynCategories.count - (Self.maxDynCategories - 1)
                for cat in dynCategories.prefix(excess) {
                    merged.remove(cat)
                }
            }
            merged.insert(category)
            UNUserNotificationCenter.current().setNotificationCategories(merged)

            // READ-BACK BARRIER (#719 review): setNotificationCategories has
            // no completion handler, so this is the only way to tell whether
            // the registration actually landed before this notification
            // displays. Read the set back and stamp `categoryIdentifier` ONLY
            // if our category is confirmed present; if the registration raced
            // and lost, leave `content.categoryIdentifier` untouched so the
            // daemon's original static category (or none) — the safe
            // fallback — is what displays, rather than an unresolved dynamic
            // id that would render with NO action buttons at all.
            UNUserNotificationCenter.current().getNotificationCategories { confirmed in
                if confirmed.contains(where: { $0.identifier == categoryId }) {
                    content.categoryIdentifier = categoryId
                }
                completion()
            }
        }
    }

    /// True for an honest negative answer ("No", "No, thanks", "No, cancel")
    /// — never for a label that merely starts with the letters "No", such as
    /// "Norway" or "Node.js".
    private func isNegativeLabel(_ label: String) -> Bool {
        label == "No" || label.hasPrefix("No ") || label.hasPrefix("No,")
    }

    private func truncated(_ s: String, to maxLength: Int) -> String {
        guard s.count > maxLength else { return s }
        return "\(s.prefix(maxLength))…"
    }
}
