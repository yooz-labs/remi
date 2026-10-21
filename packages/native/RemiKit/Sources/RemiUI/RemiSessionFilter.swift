import Foundation

/// The drawer's local session filter: a machine and a text query, both optional.
public enum RemiSessionFilter {
    /// `machineKey` nil keeps every machine; otherwise only sessions whose `machineID`
    /// equals it. A trimmed, non-empty `query` keeps sessions whose name, project, project
    /// path, machine name or last message contains it, ignoring case and diacritics.
    /// Input order is preserved.
    public static func apply(
        to sessions: [RemiSessionSummary],
        query: String,
        machineKey: String?
    ) -> [RemiSessionSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return sessions.filter { session in
            if let machineKey, session.machineID != machineKey { return false }
            guard !needle.isEmpty else { return true }
            let fields = [session.name, session.project, session.projectPath, session.machineName, session.lastMessage]
            return fields.contains { field in
                guard let field else { return false }
                return field.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
        }
    }
}
