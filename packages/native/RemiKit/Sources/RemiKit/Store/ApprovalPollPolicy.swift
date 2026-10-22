/// How long and how often a machine that is waiting for local approval is retried by itself.
///
/// The person approves the phone's key on the machine (`remi authorize`); once they have, the
/// app should connect without another tap (#1599). Each retry is a fresh signed connection that
/// refreshes the machine's pending request, so the window is bounded: after it the machine stays
/// on "waiting for approval" until the person taps Retry connection.
struct ApprovalPollPolicy: Equatable, Sendable {
    let interval: Duration
    let window: Duration

    static let standard = ApprovalPollPolicy(interval: .seconds(5), window: .seconds(180))

    func shouldContinue(elapsed: Duration) -> Bool { elapsed < window }
}
