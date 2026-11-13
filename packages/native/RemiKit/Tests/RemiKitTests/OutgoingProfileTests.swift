import CryptoKit
import Darwin
import Foundation
import Testing
@testable import RemiKit

/// Real store state controls at its verified-event seam. Source transport controls independently
/// exercise the actual authentication and concrete-socket provenance before these events.
@MainActor
@Suite(.serialized)
struct OutgoingProfileTests {
    struct Fixture {
        let store: MachineStore
        let routes: [MachineEndpoint]
        let sockets: [Int32]
        let authority: Data
        let session: String
    }

    private func fixture() throws -> Fixture {
        let first = try SessionAddressingTests().listener(), second = try SessionAddressingTests().listener()
        let routes = [first.1, second.1].map { MachineEndpoint(host: "127.0.0.1", port: $0) }
        let store = MachineStore(endpoints: routes, identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        let question = try JSONDecoder().decode(QuestionMessage.self, from: FixtureConformanceTests.fixture("question"))
        return Fixture(store: store, routes: routes, sockets: [first.0, second.0],
            authority: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation, session: question.sessionId)
    }

    private func authenticate(_ fixture: Fixture, at index: Int, authority: Data?, descriptor: Bool = false) throws {
        var payload = try #require(try JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("hello_ack_legacy")) as? [String: Any])
        if descriptor, let authority {
            payload["machine"] = ["id": try MachineIdentityVerifier.machineID(forPublicKey: authority), "name": "Owned routes",
                "platform": "darwin", "remiVersion": "test", "harnesses": ["claude"], "capabilities": []]
        }
        let route = fixture.routes[index]
        let generation = try #require(fixture.store.connectionGenerations[route])
        let hello = try JSONDecoder().decode(HelloAckMessage.self, from: JSONSerialization.data(withJSONObject: payload))
        fixture.store.receive(.hello(hello, authorityPublicKey: authority), from: route, generation: generation)
        let question = try JSONDecoder().decode(QuestionMessage.self, from: FixtureConformanceTests.fixture("question"))
        fixture.store.receive(.question(question), from: route, generation: generation)
    }

    private func source(_ fixture: Fixture, at index: Int) throws -> OutgoingOrigin {
        let endpoint = fixture.routes[index]
        return OutgoingOrigin(endpoint: endpoint, connection: try #require(fixture.store.connectionGenerations[endpoint]), socket: UUID())
    }

    private func refusal(session: String, message: String) throws -> ErrorMessage {
        var payload = try #require(try JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("error")) as? [String: Any])
        payload["code"] = "PROMPT_WAITING"
        payload["details"] = ["sessionId": session, "messageId": message]
        return try JSONDecoder().decode(ErrorMessage.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    @Test(arguments: [true, false])
    func forgetAndRepairSameAddressNeverAdoptsTheForgottenNamespace(sameAuthority: Bool) throws {
        let fixture = try fixture()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, route = fixture.routes[0], session = fixture.session
        try authenticate(fixture, at: 0, authority: fixture.authority)
        let key = store.sessionKey(machineID: route.id, sessionID: session)
        let oldOrigin = try source(fixture, at: 0)
        store.trackOutgoing(key: key, id: "same-message", content: "Earlier profile text", origin: oldOrigin)
        let old = try #require(store.outgoingHistory.first)
        let oldRow = try #require(old.messages.first)
        #expect(store.removeMachine(route))
        store.addMachine(route)
        let nextAuthority = sameAuthority ? fixture.authority : Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        try authenticate(fixture, at: 0, authority: nextAuthority)
        let replacementOrigin = try source(fixture, at: 0)
        store.trackOutgoing(key: key, id: "same-message", content: "Current profile text", origin: replacementOrigin)
        let current = try #require(store.outgoingHistory.first { $0.isCurrentProfile })
        #expect(current.id != old.id)
        #expect(current.id.profile.profileLifetime != old.id.profile.profileLifetime)
        #expect(store.outgoingMessages(machineID: route.id, sessionID: session).map(\.content) == ["Current profile text"])
        #expect(store.outgoingHistory.first { $0.id == old.id }?.messages.first?.content == "Earlier profile text")
        store.receive(.error(try refusal(session: session, message: "same-message"), chatOrigin: oldOrigin.socket),
            from: route, generation: oldOrigin.connection)
        _ = store.recordOutgoingSendResult(.uncertain, groupID: old.id, messageID: "same-message", origin: oldOrigin)
        #expect(store.outgoingMessages(machineID: route.id, sessionID: session).first?.delivery == .sending)
        store.dismissOutgoing(presentationID: oldRow.presentationID)
        #expect(store.outgoingHistory.map(\.id) == [current.id])
        store.dismissOutgoing(groupID: old.id, messageID: "same-message")
        #expect(store.outgoingMessages(machineID: route.id, sessionID: session).first?.content == "Current profile text")
    }

    @Test func legacyUnauthenticatedRowsAreNotAdoptedByAnAuthenticatedHello() throws {
        let fixture = try fixture()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, route = fixture.routes[0]
        try authenticate(fixture, at: 0, authority: nil)
        let key = store.sessionKey(machineID: route.id, sessionID: fixture.session)
        store.trackOutgoing(key: key, id: "legacy", content: "Legacy text", origin: try source(fixture, at: 0))
        let old = try #require(store.outgoingHistory.first)
        try authenticate(fixture, at: 0, authority: fixture.authority)
        #expect(store.outgoingMessages(machineID: route.id, sessionID: fixture.session).isEmpty)
        #expect(store.outgoingHistory.first?.id == old.id)
        #expect(store.outgoingHistory.first?.isCurrentProfile == false)
        store.trackOutgoing(key: key, id: "authenticated", content: "Authenticated text", origin: try source(fixture, at: 0))
        #expect(store.outgoingMessages(machineID: route.id, sessionID: fixture.session).map(\.content) == ["Authenticated text"])
        #expect(store.outgoingHistory.count == 2)
    }

    @Test func authenticatedRouteMergePreservesSixtyRowsAndExactInflightNamespaces() throws {
        let fixture = try fixture()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, session = fixture.session
        try authenticate(fixture, at: 0, authority: fixture.authority)
        try authenticate(fixture, at: 1, authority: fixture.authority)
        let a = store.sessionKey(machineID: fixture.routes[0].id, sessionID: session)
        let b = store.sessionKey(machineID: fixture.routes[1].id, sessionID: session)
        let originA = try source(fixture, at: 0), originB = try source(fixture, at: 1)
        for index in 0..<30 {
            let first = store.trackOutgoing(key: a, id: "m\(index)", content: "First route \(index)", origin: originA)
            let second = store.trackOutgoing(key: b, id: "m\(index)", content: "Second route \(index)", origin: originB)
            #expect(first && second)
        }
        let groupA = try #require(store.outgoingHistory.first { $0.key == a })
        let groupB = try #require(store.outgoingHistory.first { $0.key == b })
        #expect(groupA.id != groupB.id)
        try authenticate(fixture, at: 1, authority: fixture.authority, descriptor: true)
        #expect(store.machines.count == 1)
        let currentMachine = try #require(store.machines.first?.id)
        #expect(store.outgoingMessages(machineID: currentMachine, sessionID: session).count == 60)
        #expect(store.outgoingHistory.allSatisfy { $0.isCurrentProfile })
        #expect(store.outgoingCount == 60)
        // The old second-route socket's refusal is still correlated after the route merge.
        store.receive(.error(try refusal(session: session, message: "m0"), chatOrigin: originB.socket),
            from: originB.endpoint, generation: originB.connection)
        _ = store.recordOutgoingSendResult(.handedOff, groupID: groupB.id, messageID: "m0", origin: originB)
        _ = store.recordOutgoingSendResult(.handedOff, groupID: groupA.id, messageID: "m0", origin: originA)
        #expect(store.outgoingHistory.first { $0.id == groupA.id }?.messages.first?.delivery == .handedOff)
        #expect(store.outgoingHistory.first { $0.id == groupB.id }?.messages.first?.delivery == .refused)
        let currentKey = store.sessionKey(machineID: currentMachine, sessionID: session)
        let overflow = store.trackOutgoing(key: currentKey, id: "new", content: "Keep draft", origin: originB)
        #expect(!overflow)
        #expect(store.outgoingCount == 60)
        // Both groups stay recoverable, including identical message IDs; dismissal is exact.
        for index in 0..<11 { store.dismissOutgoing(groupID: groupA.id, messageID: "m\(index)") }
        #expect(store.outgoingHistory.first { $0.id == groupB.id }?.messages.count == 30)
        #expect(store.outgoingMessages(machineID: currentMachine, sessionID: session).count == 49)
        let afterDismissal = store.trackOutgoing(key: currentKey, id: "new", content: "Explicit new intent", origin: originB)
        #expect(afterDismissal)
        #expect(store.outgoingMessages(machineID: currentMachine, sessionID: session).count == 50)
    }
}
