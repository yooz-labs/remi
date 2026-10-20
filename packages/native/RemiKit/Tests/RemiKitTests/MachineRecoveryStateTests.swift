import RemiKit
import Testing
@testable import RemiUI

@Suite struct MachineRecoveryStateTests {
    @Test func directFailuresRemainRetryable() {
        let offline = RemiMachineRecoveryState.resolve(status: .disconnected, isRelay: false)
        let unavailable = RemiMachineRecoveryState.resolve(
            status: .unavailable(reason: "Connection refused"),
            isRelay: false
        )

        #expect(offline == .retryableOffline)
        #expect(unavailable == .retryableUnavailable(reason: "Connection refused"))
        #expect(offline.allowsConnectionRetry)
        #expect(unavailable.allowsConnectionRetry)
    }

    @Test func relayFailuresNeverOfferDirectRetry() {
        let offline = RemiMachineRecoveryState.resolve(status: .disconnected, isRelay: true)
        let unavailable = RemiMachineRecoveryState.resolve(
            status: .unavailable(reason: "Token expired"),
            isRelay: true
        )

        #expect(offline == .relayOffline)
        #expect(unavailable == .relayNeedsFreshPairing(reason: "Token expired"))
        #expect(!offline.allowsConnectionRetry)
        #expect(!unavailable.allowsConnectionRetry)
    }

    @Test func approvalStatesPreserveTheFingerprintAndTrustPath() {
        #expect(RemiMachineRecoveryState.resolve(
            status: .waitingForApproval(fingerprint: "client"),
            isRelay: false
        ) == .waitingForDirectApproval(fingerprint: "client"))
        #expect(RemiMachineRecoveryState.resolve(
            status: .waitingForRelayConfirmation(fingerprint: "machine"),
            isRelay: true
        ) == .waitingForRelayConfirmation(fingerprint: "machine"))
    }

    @Test func healthyTransitionsHaveNoRecoveryAction() {
        #expect(RemiMachineRecoveryState.resolve(status: .connecting, isRelay: false) == .none)
        #expect(RemiMachineRecoveryState.resolve(status: .connected, isRelay: true) == .none)
    }
}
