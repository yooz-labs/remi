/// An authenticated receipt or a conservative local settlement. Uncertainty
/// never means that the answer was not applied and never triggers a retry.
public enum RelayNotificationAnswerOutcome: String, Sendable {
    case delivered, stale, conflict, busy, uncertain, refused

    /// Distinct daemon refusals share the existing stale presentation; neither is delivery.
    static func fromWire(_ value: String) -> Self {
        guard let outcome = AnswerResultWireOutcome(rawValue: value) else { return .uncertain }
        switch outcome {
        case .delivered: return .delivered
        case .stale, .staleBinding, .sessionNotFound: return .stale
        case .conflict: return .conflict
        case .busy: return .busy
        case .uncertain: return .uncertain
        }
    }
}
