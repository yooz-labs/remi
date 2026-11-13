import Foundation

/// What the New session sheet says when the machine the person narrowed the drawer to
/// cannot start a session, kept apart from the view so the rule can be tested. The sheet
/// only offers connected machines, so a preferred machine that is not connected is
/// replaced by the first one that is, and the person is told.
public enum RemiNewSessionPreference {
    /// The note to show, or nil when there is nothing to say: no preferred machine, it is
    /// available, or it is not a machine the app knows (so there is no label to name).
    /// `labels` is machine id to the unique label from `RemiMachineStripPresentation`.
    public static func unavailableNote(
        preferredMachineID: String?,
        availableMachineIDs: [String],
        labels: [String: String]
    ) -> String? {
        guard let preferredMachineID,
              !availableMachineIDs.contains(preferredMachineID),
              let label = labels[preferredMachineID]
        else { return nil }
        return "\(label) is not connected. Choose another machine."
    }
}
