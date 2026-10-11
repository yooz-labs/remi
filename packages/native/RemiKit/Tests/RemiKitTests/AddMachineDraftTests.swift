import Testing
@testable import RemiKit

@MainActor
@Suite struct AddMachineDraftTests {
    @Test func defaultsToValidLoopbackEndpoint() throws {
        let draft = AddMachineDraft()

        #expect(draft.mode == .direct)
        #expect(draft.canSubmit)
        #expect(draft.connectionSummary == "Direct to 127.0.0.1:18765")
        #expect(try #require(draft.makeEndpoint()).id == "127.0.0.1:18765")
    }

    @Test func trimsDirectHostAtSubmission() throws {
        let draft = AddMachineDraft()
        draft.host = "  studio.local\n"
        draft.port = 8765

        let endpoint = try #require(draft.makeEndpoint())
        #expect(endpoint.host == "studio.local")
        #expect(endpoint.port == 8765)
    }

    @Test(arguments: [0, -1, 65536])
    func refusesOutOfRangePorts(_ port: Int) {
        let draft = AddMachineDraft()
        draft.port = port

        #expect(draft.validationIssue == .invalidPort)
        #expect(!draft.canSubmit)
        #expect(draft.makeEndpoint() == nil)
        #expect(draft.submissionIssue == .invalidPort)
    }

    @Test func acceptsPortBoundaries() {
        let draft = AddMachineDraft()
        draft.port = 1
        #expect(draft.canSubmit)
        draft.port = 65535
        #expect(draft.canSubmit)
    }

    @Test func refusesWhitespaceOnlyHost() {
        let draft = AddMachineDraft()
        draft.host = " \n "

        #expect(draft.validationIssue == .missingHost)
        #expect(draft.makeEndpoint() == nil)
    }

    @Test func relaySubmissionTrimsTokenAndUsesContract() throws {
        var receivedToken: String?
        let expected = MachineEndpoint(host: "relay.example", port: 443)
        let draft = AddMachineDraft { token in
            receivedToken = token
            return expected
        }
        draft.mode = .relay
        draft.relayToken = "  token-value\n"

        #expect(draft.makeEndpoint() == expected)
        #expect(receivedToken == "token-value")
        #expect(draft.submissionIssue == nil)
    }

    @Test func invalidRelayTokenSurfacesAndEditingClearsError() {
        struct Rejected: Error {}
        let draft = AddMachineDraft { _ in throw Rejected() }
        draft.mode = .relay
        draft.relayToken = "expired"

        #expect(draft.makeEndpoint() == nil)
        #expect(draft.submissionIssue == .invalidRelayToken)

        draft.relayToken = "replacement"
        #expect(draft.submissionIssue == nil)
    }

    @Test func changingModeClearsModeSpecificError() {
        let draft = AddMachineDraft()
        draft.mode = .relay
        #expect(draft.makeEndpoint() == nil)
        #expect(draft.submissionIssue == .missingRelayToken)

        draft.mode = .direct
        #expect(draft.submissionIssue == nil)
        #expect(draft.canSubmit)
    }
}
