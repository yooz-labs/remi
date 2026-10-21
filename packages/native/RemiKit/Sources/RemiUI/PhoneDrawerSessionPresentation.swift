import Foundation

/// The text a drawer session row shows, kept apart from the view so it can be tested.
public struct PhoneDrawerSessionPresentation: Equatable, Sendable {
    /// "project · machine", or only the machine when the project name repeats the
    /// session name.
    public let subtitle: String
    /// A complete label for VoiceOver, whatever the subtitle leaves out.
    public let accessibilityLabel: String

    public init(session: RemiSessionSummary) {
        let trimmedName = session.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedProject = session.project.trimmingCharacters(in: .whitespacesAndNewlines)
        let repeatsName = trimmedName.caseInsensitiveCompare(trimmedProject) == .orderedSame
        subtitle = repeatsName ? session.machineName : "\(session.project) · \(session.machineName)"
        var label = "\(session.name), project \(session.project), on \(session.machineName)"
        if session.openQuestionCount > 0 {
            let count = session.openQuestionCount
            label += count == 1 ? ", 1 question waiting" : ", \(count) questions waiting"
        }
        accessibilityLabel = label
    }
}
