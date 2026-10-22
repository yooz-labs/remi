import Foundation
import Testing
@testable import RemiKit

struct RemiConnectionTests {
    @Test func preHelloRelayBufferBoundsCountBytesAndResetsAfterDrain() throws {
        var buffer = RelayHelloBuffer()
        for _ in 0..<32 { try buffer.append(Data([1])) }
        #expect(throws: RelayFailure.oversize) { try buffer.append(Data([2])) }
        #expect(buffer.drain() == Array(repeating: Data([1]), count: 32))
        for _ in 0..<4 { try buffer.append(Data(repeating: 3, count: 262_144)) }
        #expect(throws: RelayFailure.oversize) { try buffer.append(Data([4])) }
        #expect(buffer.drain().count == 4)
        try buffer.append(Data([5]))
        #expect(buffer.drain() == [Data([5])])
        #expect(buffer.drain().isEmpty)
    }

    @Test func reconnectBackoffIsBounded() {
        #expect(RemiConnection.reconnectDelay(forAttempt: 1) == 1)
        #expect(RemiConnection.reconnectDelay(forAttempt: 2) == 2)
        #expect(RemiConnection.reconnectDelay(forAttempt: 6) == 30)
        #expect(RemiConnection.reconnectDelay(forAttempt: 20) == 30)
    }

    @Test func relayFallbackAcceptsReachabilityFailuresOnly() {
        #expect(RemiConnection.isDirectReachabilityFailure(URLError(.cannotConnectToHost)))
        #expect(RemiConnection.isDirectReachabilityFailure(URLError(.networkConnectionLost)))
        #expect(!RemiConnection.isDirectReachabilityFailure(URLError(.serverCertificateUntrusted)))
        #expect(!RemiConnection.isDirectReachabilityFailure(
            AuthenticationHandshakeError.invalidServerSignature
        ))
        #expect(!RemiConnection.isDirectReachabilityFailure(RemiConnectionError.malformedMessage))
    }

    @Test func aSocketLostAfterAdmissionIsRetriedNotRejected() {
        // A hub that closes gracefully or restarts ends an admitted socket with an error that is
        // not on the reachability list (for example "Socket is not connected"). That is transport
        // loss, not an authentication failure (#1599).
        let closedByPeer = NSError(domain: NSPOSIXErrorDomain, code: Int(ENOTCONN))
        #expect(RemiConnection.shouldRetryDirectFailure(
            error: closedByPeer, deadlineUnreachable: false, wasAdmitted: true
        ))
        #expect(RemiConnection.shouldRetryDirectFailure(
            error: RemiConnectionError.malformedMessage, deadlineUnreachable: false, wasAdmitted: true
        ))
    }

    @Test func aFailureBeforeAdmissionStillFailsClosedUnlessUnreachable() {
        let closedByPeer = NSError(domain: NSPOSIXErrorDomain, code: Int(ENOTCONN))
        #expect(!RemiConnection.shouldRetryDirectFailure(
            error: closedByPeer, deadlineUnreachable: false, wasAdmitted: false
        ))
        #expect(!RemiConnection.shouldRetryDirectFailure(
            error: AuthenticationHandshakeError.invalidServerSignature,
            deadlineUnreachable: false, wasAdmitted: false
        ))
        #expect(RemiConnection.shouldRetryDirectFailure(
            error: closedByPeer, deadlineUnreachable: true, wasAdmitted: false
        ))
        #expect(RemiConnection.shouldRetryDirectFailure(
            error: URLError(.cannotConnectToHost), deadlineUnreachable: false, wasAdmitted: false
        ))
    }

    @Test func authErrorsDoNotClaimEveryFailureIsPendingApproval() {
        #expect(RemiConnection.authenticationDescription("INVALID_SIGNATURE") ==
            "Signature verification failed.")
        #expect(RemiConnection.authenticationDescription("PENDING_QUEUE_FULL") ==
            "The daemon's pending approval queue is full.")
    }

    @Test func appTransportPolicyRefusalIsExplicitAndCannotTriggerFallback() {
        let refusal = URLError(.appTransportSecurityRequiresSecureConnection)
        #expect(RemiConnection.directPolicyRejectionDescription(refusal)?.contains("ATS -1022") == true)
        #expect(!RemiConnection.isDirectReachabilityFailure(refusal))
        #expect(RemiConnection.directPolicyRejectionDescription(URLError(.cannotConnectToHost)) == nil)
        #expect(RemiConnection.directPolicyRejectionDescription(URLError(.serverCertificateUntrusted)) == nil)
        #expect(RemiConnection.directPolicyRejectionDescription(RemiConnectionError.malformedMessage) == nil)
    }

    @Test func pairingRetryErrorsAreExplicitAndBounded() {
        #expect(RemiConnection.shouldRetryAuthentication("PAIRING_PENDING"))
        #expect(RemiConnection.shouldRetryAuthentication("PENDING_QUEUE_FULL"))
        #expect(RemiConnection.shouldRetryAuthentication("AUTH_STORE_ERROR"))
        #expect(RemiConnection.shouldRetryAuthentication("AUTH_STORE_ERROR: locked"))
        #expect(!RemiConnection.shouldRetryAuthentication("PAIRING_REJECTED"))
        #expect(!RemiConnection.shouldRetryAuthentication("PAIRING_EXPIRED"))
    }

    @Test func manualRetryOnlyRestartsTerminalDirectStates() {
        #expect(RemiConnection.allowsManualRetry(.stopped))
        #expect(RemiConnection.allowsManualRetry(.awaitingLocalApproval(fingerprint: "client")))
        #expect(RemiConnection.allowsManualRetry(.rejected(reason: "refused")))
        #expect(!RemiConnection.allowsManualRetry(.connecting(attempt: 1)))
        #expect(!RemiConnection.allowsManualRetry(.awaitingRelayConfirmation(fingerprint: "host")))
        #expect(!RemiConnection.allowsManualRetry(.connected(sessionId: nil)))
        #expect(!RemiConnection.allowsManualRetry(.retrying(attempt: 2, delaySeconds: 2)))
        #expect(!RemiConnection.allowsManualRetry(.reachabilityFailed(attempt: 3)))
    }
}
