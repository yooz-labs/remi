import Foundation
import Testing
@testable import RemiKit

struct RelayRetryDecisionTests {
    @Test func retryDecisionPreservesTerminalFailuresAndBudget() {
        let network = URLError(.networkConnectionLost)
        let recovered = RemiConnection.relayRetryDecision(enrolled: true, error: network,
            healthyAdmittedEpisode: true, attempt: 5)
        #expect(recovered.retry && recovered.attempt == 0)
        let short = RemiConnection.relayRetryDecision(enrolled: true, error: network,
            healthyAdmittedEpisode: false, attempt: 4)
        #expect(short.retry && short.attempt == 4)
        #expect(!RemiConnection.relayRetryDecision(enrolled: true, error: network,
            healthyAdmittedEpisode: false, attempt: 5).retry)
        #expect(!RemiConnection.relayRetryDecision(enrolled: false, error: network,
            healthyAdmittedEpisode: true, attempt: 1).retry)
        #expect(!RemiConnection.relayRetryDecision(enrolled: true, error: RelayFailure.malformed,
            healthyAdmittedEpisode: true, attempt: 1).retry)
    }
}
