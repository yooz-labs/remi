import Foundation
@testable import RemiKit
import Testing
@testable import RemiUI

@MainActor
struct RemiPaneAvailabilityTests {
    private func ack(_ capabilities: [String], version: HubSupportAck.Version = .number(1)) -> HubSupportAck {
        HubSupportAck(protocolVersion: version, capabilities: capabilities, daemonVersion: "0.8.0")
    }

    @Test func terminalNeedsTerminalView() {
        let panes = RemiPaneAvailability(ack: ack(["terminal_view"]), isConnected: true)
        #expect(panes.terminal == .available)
        #expect(panes.files.isAvailable == false)
        #expect(panes.offeredPanes == [.chat, .terminal])
    }

    @Test func filesNeedFileDownload() {
        let panes = RemiPaneAvailability(ack: ack(["file_download", "workspaces"]), isConnected: true)
        #expect(panes.files == .available)
        #expect(panes.terminal.isAvailable == false)
        #expect(panes.offeredPanes == [.chat, .files])
    }

    @Test func bothAreOfferedTogether() {
        let panes = RemiPaneAvailability(ack: ack(["file_download", "terminal_view"]), isConnected: true)
        #expect(panes.offeredPanes == [.chat, .terminal, .files])
        #expect(panes.hasAnyPane)
    }

    @Test func legacyAckOffersNothingAndNamesTheUpdate() throws {
        let legacy = HubSupportAck(
            json: try WireJSON.parse(FixtureConformanceTests.fixture("hello_ack_legacy")))
        let panes = RemiPaneAvailability(ack: legacy, isConnected: true)
        #expect(panes.hasAnyPane == false)
        #expect(panes.offeredPanes == [.chat])
        let reason = try #require(panes.terminal.reason)
        #expect(reason.contains("cannot show the terminal of the attached session"))
        #expect(reason.contains("Update remi on that machine and restart it."))
        #expect(try #require(panes.files.reason).contains("download a file from the attached session"))
    }

    @Test func currentFixtureAdvertisesNeitherYet() throws {
        let current = HubSupportAck(json: try WireJSON.parse(FixtureConformanceTests.fixture("hello_ack")))
        #expect(RemiPaneAvailability(ack: current, isConnected: true).terminal.isAvailable == false)
    }

    @Test func unknownCapabilityIsIgnored() {
        let panes = RemiPaneAvailability(ack: ack(["hologram", "terminal_view"]), isConnected: true)
        #expect(panes.offeredPanes == [.chat, .terminal])
        let none = RemiPaneAvailability(ack: ack(["hologram"]), isConnected: true)
        #expect(none.offeredPanes == [.chat])
    }

    @Test func capabilityNamesMatchExactlyNotByCase() {
        #expect(RemiPaneAvailability(ack: ack(["Terminal_View"]), isConnected: true).terminal.isAvailable == false)
    }

    @Test func versionMismatchHidesPanesEvenWithCapabilities() throws {
        let panes = RemiPaneAvailability(
            ack: ack(["terminal_view", "file_download"], version: .number(2)), isConnected: true)
        #expect(panes.hasAnyPane == false)
        #expect(try #require(panes.terminal.reason).contains("Update this app."))
    }

    @Test func disconnectedOrUnansweredMachineOffersNothing() {
        let answered = ack(["terminal_view", "file_download"])
        #expect(RemiPaneAvailability(ack: answered, isConnected: false).hasAnyPane == false)
        #expect(RemiPaneAvailability(ack: nil, isConnected: true).hasAnyPane == false)
    }

    @Test func chatIsAlwaysAvailable() {
        let panes = RemiPaneAvailability(ack: nil, isConnected: false)
        #expect(panes.state(for: .chat) == .available)
        #expect(panes.state(for: .files).isAvailable == false)
    }
}

#if DEBUG
@MainActor
struct MachineStoreHelloAckTests {
    @Test func storeKeepsVersionAndCapabilitiesOfTheLatestAck() throws {
        let origin = MachineEndpoint(host: "192.0.2.30", port: 28030)
        let store = MachineStore(endpoints: [origin], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        #expect(store.machines.first?.helloAck == nil)
        let generation = try #require(store.connectionGenerations[origin])
        let ack = try JSONDecoder().decode(
            HelloAckMessage.self, from: FixtureConformanceTests.fixture("hello_ack_legacy"))
        store.receive(.hello(ack), from: origin, generation: generation)
        let kept = try #require(store.machines.first?.helloAck)
        #expect(kept == HubSupportAck(ack))
        #expect(kept.protocolVersion == .absent)
        #expect(kept.capabilities.isEmpty)
    }
}
#endif
