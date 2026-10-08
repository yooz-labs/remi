import Testing
@testable import RemiKit

struct RemiConnectionTests {
    @Test func reconnectBackoffIsBounded() {
        #expect(RemiConnection.reconnectDelay(forAttempt: 1) == 1)
        #expect(RemiConnection.reconnectDelay(forAttempt: 2) == 2)
        #expect(RemiConnection.reconnectDelay(forAttempt: 6) == 30)
        #expect(RemiConnection.reconnectDelay(forAttempt: 20) == 30)
    }

    @Test func authErrorsDoNotClaimEveryFailureIsPendingApproval() {
        #expect(RemiConnection.authenticationDescription("INVALID_SIGNATURE") ==
            "Signature verification failed.")
        #expect(RemiConnection.authenticationDescription("PENDING_QUEUE_FULL") ==
            "The daemon's pending approval queue is full.")
    }

    @Test func pairingRetryErrorsAreExplicitAndBounded() {
        #expect(RemiConnection.shouldRetryAuthentication("PAIRING_PENDING"))
        #expect(RemiConnection.shouldRetryAuthentication("PENDING_QUEUE_FULL"))
        #expect(RemiConnection.shouldRetryAuthentication("AUTH_STORE_ERROR"))
        #expect(RemiConnection.shouldRetryAuthentication("AUTH_STORE_ERROR: locked"))
        #expect(!RemiConnection.shouldRetryAuthentication("PAIRING_REJECTED"))
        #expect(!RemiConnection.shouldRetryAuthentication("PAIRING_EXPIRED"))
    }
}
