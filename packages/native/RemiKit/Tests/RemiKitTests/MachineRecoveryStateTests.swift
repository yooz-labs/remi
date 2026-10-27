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

    @Test func everyStateThatNeedsThePersonHasPlainCopy() {
        let states: [RemiMachineRecoveryState] = [
            .waitingForDirectApproval(fingerprint: "ab"),
            .waitingForRelayConfirmation(fingerprint: "ab"),
            .retryableOffline,
            .retryableUnavailable(reason: nil),
            .relayOffline,
            .relayNeedsFreshPairing(reason: nil),
        ]
        for state in states {
            #expect(state.title?.isEmpty == false)
            #expect(state.detail(machineName: "Studio")?.contains("Studio") == true)
        }
        #expect(RemiMachineRecoveryState.none.title == nil)
        #expect(RemiMachineRecoveryState.none.detail(machineName: "Studio") == nil)
    }

    @Test func reasonReplacesTheGenericSentenceAndPrefixesRelayPairing() {
        #expect(RemiMachineRecoveryState.retryableUnavailable(reason: "Port closed")
            .detail(machineName: "Studio") == "Port closed")
        #expect(RemiMachineRecoveryState.relayNeedsFreshPairing(reason: "Token expired.")
            .detail(machineName: "Studio") == "Token expired. Create a fresh relay pairing token on Studio.")
        #expect(RemiMachineRecoveryState.relayNeedsFreshPairing(reason: "")
            .detail(machineName: "Studio") == "Create a fresh relay pairing token on Studio.")
    }
}
