import Foundation
import Testing
import RemiUI
@testable import RemiKit

struct MachineCopyTests {
    @Test func theAddressIsOmittedWhenItIsTheName() {
        #expect(RemiMachineRow.subtitleAddress(name: "Studio Mac", address: "192.168.1.9:18765") == "192.168.1.9:18765")
        #expect(RemiMachineRow.subtitleAddress(name: "127.0.0.1:18792", address: "127.0.0.1:18792") == nil)
    }

    @Test func unreachableMessageSpeaksPlainlyAndNamesTheWay() {
        let message = MachineStore.unreachableMessage(layer: "Local network")
        #expect(message.contains("Local network"))
        #expect(!message.lowercased().contains("connection layer"))
        #expect(!message.contains("is unreachable. Check that network"))
        #expect(message.contains("running"))
    }

    @Test func aHubClosingIsExpectedNotAnError() throws {
        func error(_ code: String) throws -> ErrorMessage {
            let json = #"{"type":"error","id":"1","timestamp":"2026-10-22T00:00:00Z","code":"\#(code)","message":"m"}"#
            return try JSONDecoder().decode(ErrorMessage.self, from: Data(json.utf8))
        }
        #expect(MachineStore.isExpectedClosure(try error("CLOSING")))
        #expect(!MachineStore.isExpectedClosure(try error("AUTH_REQUIRED")))
        #expect(!MachineStore.isExpectedClosure(try error("INTERNAL")))
    }
}
