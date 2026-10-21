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

    /// `machineLabel` replaces the machine name when machines share one.
    public init(session: RemiSessionSummary, isLastKnown: Bool = false, machineLabel: String? = nil) {
        let machineName = machineLabel ?? session.machineName
        self.isLastKnown = isLastKnown
        let trimmedName = session.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedProject = session.project.trimmingCharacters(in: .whitespacesAndNewlines)
        let repeatsName = trimmedName.caseInsensitiveCompare(trimmedProject) == .orderedSame
        var subtitle = repeatsName ? machineName : "\(session.project) · \(machineName)"
        if isLastKnown { subtitle += " · Last known" }
        self.subtitle = subtitle
        var label = "\(session.name), project \(session.project), on \(machineName)"
        if session.openQuestionCount > 0 {
            let count = session.openQuestionCount
            label += count == 1 ? ", 1 question waiting" : ", \(count) questions waiting"
        }
        if isLastKnown { label += ", last known, machine offline" }
        accessibilityLabel = label
    }
}
