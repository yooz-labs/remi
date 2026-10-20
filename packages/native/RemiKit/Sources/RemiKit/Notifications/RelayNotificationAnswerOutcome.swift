/// An authenticated receipt or a conservative local settlement. Uncertainty
/// never means that the answer was not applied and never triggers a retry.
public enum RelayNotificationAnswerOutcome: String, Sendable {
    case delivered, stale, conflict, busy, uncertain, refused
}
