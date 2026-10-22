import Foundation

/// The text a drawer session row shows, kept apart from the view so it can be tested.
public struct PhoneDrawerSessionPresentation: Equatable, Sendable {
    /// "project · machine", or only the machine when the project name repeats the
    /// session name.
    public let subtitle: String
    /// A complete label for VoiceOver, whatever the subtitle leaves out.
    public let accessibilityLabel: String
    /// True when the session's machine is unreachable and what the row shows is the
    /// last thing the phone knew. The row is dimmed and its subtitle says so in words.
    public let isLastKnown: Bool

    /// `machineLabel` replaces the machine name when machines share one. `now` and `locale`
    /// are injected so the relative last-activity time is deterministic in tests.
    public init(
        session: RemiSessionSummary,
        isLastKnown: Bool = false,
        machineLabel: String? = nil,
        now: Date = .now,
        locale: Locale = .current
    ) {
        let machineName = machineLabel ?? session.machineName
        self.isLastKnown = isLastKnown
        let trimmedName = session.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedProject = session.project.trimmingCharacters(in: .whitespacesAndNewlines)
        let repeatsName = trimmedName.caseInsensitiveCompare(trimmedProject) == .orderedSame
        var subtitle = repeatsName ? machineName : "\(session.project) · \(machineName)"
        let activity = session.lastActivityDate.map { min($0, now) }
        if let activity {
            subtitle += " · " + Self.relative(activity, to: now, style: .abbreviated, locale: locale)
        }
        if isLastKnown { subtitle += " · Last known" }
        self.subtitle = subtitle
        var label = "\(session.name), project \(session.project), on \(machineName)"
        if session.openQuestionCount > 0 {
            let count = session.openQuestionCount
            label += count == 1 ? ", 1 question waiting" : ", \(count) questions waiting"
        }
        if let activity {
            label += ", last active " + Self.relative(activity, to: now, style: .full, locale: locale)
        }
        if isLastKnown { label += ", last known, machine offline" }
        accessibilityLabel = label
    }

    private static func relative(
        _ date: Date,
        to now: Date,
        style: RelativeDateTimeFormatter.UnitsStyle,
        locale: Locale
    ) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = style
        // Named, so a zero interval reads "now" and not "in 0s".
        formatter.dateTimeStyle = .named
        formatter.locale = locale
        return formatter.localizedString(for: date, relativeTo: now)
    }
}
