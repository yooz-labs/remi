import CryptoKit
import Foundation
import Testing
@testable import RemiKit

struct RelayClientTests {
    func handshake(_ oracle: [String: Any], mode: String, machine: Data? = nil) throws -> RelayHandshake {
        let identities = try #require(oracle["identities"] as? [String: [String: Any]])
        let sessions = try #require(oracle["sessions"] as? [String: [String: Any]])
        let session = try #require(sessions[mode])
        let ephemeral = try #require(session["clientEphemeral"] as? [String: Any])
        return try RelayHandshake(
            machine: machine ?? RelayOracle.bytes(#require(identities["machine"]), "publicKey"),
            identity: ClientIdentity(rawPrivateKey: RelayOracle.bytes(#require(identities["device"]), "seed")),
            secret: mode == "pair" ? RelayOracle.bytes(session, "psk") : nil,
            ephemeral: P256.KeyAgreement.PrivateKey(rawRepresentation: RelayOracle.bytes(ephemeral, "scalar")),
            nonce: RelayOracle.bytes(session, "clientNonce"), name: #require(session["deviceName"] as? String))
    }

    @Test func bothHandshakesUseTheRealOracleAndChannel() throws {
        let oracle = try RelayOracle.load()
        let sessions = try #require(oracle["sessions"] as? [String: [String: Any]])
        for (mode, session) in sessions {
            let client = try handshake(oracle, mode: mode)
            #expect(client.hello == (session["hello"] as? String))
            let response = try client.acknowledge(#require(session["helloAck"] as? String))
            #expect(response.fingerprint == (session["fingerprint"] as? String))
            let keys = try #require(session["keys"] as? [String: Any])
            let auth = try RelayCrypto.control(response.auth, type: "auth", fields: [("c", 112...176)])[0]
            let opened = try RelayCrypto.open(auth, key: SymmetricKey(data: RelayOracle.bytes(keys, "c2h")), type: 1, direction: 1, counter: 0)
            let identities = try #require(oracle["identities"] as? [String: [String: Any]])
            let deviceKey = try RelayOracle.bytes(#require(identities["device"]), "publicKey")
            #expect(opened.prefix(32) == deviceKey)
            #expect(RelayCrypto.verify(opened.dropFirst(32).prefix(64),
                input: try RelayOracle.bytes(session, "clientSigningInput"), key: deviceKey))
            #expect(opened.dropFirst(96) == Data(try #require(session["deviceName"] as? String).utf8))
            let channel = try client.ready(#require(session["ready"] as? String))
            let data = try #require(session["data"] as? [String: [[String: Any]]])
            for item in try #require(data["c2h"]) {
                #expect(try channel.seal(RelayOracle.bytes(item, "plaintext")) == RelayOracle.bytes(item, "frame"))
            }
            for item in try #require(data["h2c"]) {
                #expect(try channel.open(RelayOracle.bytes(item, "frame")) == RelayOracle.bytes(item, "plaintext"))
            }
            let bye = try #require(session["bye"] as? [String: [String: Any]])
            #expect(try channel.seal(Data(), bye: true) == RelayOracle.bytes(#require(bye["c2h"]), "frame"))
            #expect(try channel.open(RelayOracle.bytes(#require(bye["h2c"]), "frame")) == nil)
            #expect(channel.streamEnd == "clean")
            #expect(throws: RelayFailure.state) { try client.ready(#require(session["ready"] as? String)) }
            #expect(throws: RelayFailure.ended) { try channel.seal(Data([1])) }
        }
    }

    @Test func canonicalHostControlsRejectAllApplicableVectors() throws {
        let oracle = try RelayOracle.load()
        let negatives = try #require(oracle["negative"] as? [[String: Any]])
        var checked = 0
        for item in negatives where item["kind"] as? String == "control_decode" {
            let type = try #require(item["frame"] as? String)
            let fields: [(String, ClosedRange<Int>)]
            switch type {
            case "hello_ack": fields = [("e", 65...65), ("n", 32...32), ("s", 64...64)]
            case "ready": fields = [("c", 17...17)]
            case "auth": fields = [("c", 112...176)]
            default: continue // A client never decodes host-only hello.
            }
            checked += 1
            let frame = try #require(item["text"] as? String)
            var accepted = false
            var code: String?
            do {
                let values = try RelayCrypto.control(frame, type: type, fields: fields)
                if type == "hello_ack", values[0].first != 4 { throw RelayFailure.malformed }
                accepted = true
            } catch { code = (error as? RelayFailure)?.wireCode }
            #expect(accepted == (item["expect"] as? String == "accept"), "\(item["name"] ?? "")")
            #expect(code == item["code"] as? String, "\(item["name"] ?? "")")
        }
        #expect(checked > 0)
    }

    @Test func hostIdentityAndReadyConfirmationVectors() throws {
        let oracle = try RelayOracle.load()
        let negatives = try #require(oracle["negative"] as? [[String: Any]])
        let sessions = try #require(oracle["sessions"] as? [String: [String: Any]])
        var checked = 0
        for item in negatives {
            let kind = item["kind"] as? String
            guard kind == "hello_ack_verify" || kind == "ready_open" else { continue }
            checked += 1
            let mode = try #require(item["session"] as? String)
            let client = try handshake(oracle, mode: mode,
                machine: kind == "hello_ack_verify" ? RelayOracle.bytes(item, "machinePublicKey") : nil)
            var accepted = false
            var code: String?
            do {
                if kind == "hello_ack_verify" {
                    _ = try client.acknowledge(#require(item["helloAck"] as? String))
                } else {
                    let session = try #require(sessions[mode])
                    _ = try client.acknowledge(#require(session["helloAck"] as? String))
                    _ = try client.ready(#require(item["ready"] as? String))
                }
                accepted = true
            } catch { code = (error as? RelayFailure)?.wireCode }
            #expect(accepted == (item["expect"] as? String == "accept"), "\(item["name"] ?? "")")
            #expect(code == item["code"] as? String, "\(item["name"] ?? "")")
        }
        #expect(checked == 21)
    }

    @Test func pairingTokenVectorsAndPublicPinPersistence() throws {
        let oracle = try RelayOracle.load()
        let negatives = try #require(oracle["negative"] as? [[String: Any]])
        var checked = 0
        for item in negatives where item["kind"] as? String == "token_decode" {
            checked += 1
            var accepted = false
            var code: String?
            do {
                let token = try RelayPairingToken(#require(item["text"] as? String), now: #require(item["nowSec"] as? NSNumber).uint64Value)
                let encoded = try JSONEncoder().encode(token.pin)
                #expect(try JSONDecoder().decode(RelayMachinePin.self, from: encoded) == token.pin)
                #expect(!String(decoding: encoded, as: UTF8.self).contains(RelayCrypto.b64(token.secret)))
                accepted = true
            } catch { code = (error as? RelayFailure)?.wireCode }
            #expect(accepted == (item["expect"] as? String == "accept"), "\(item["name"] ?? "")")
            #expect(code == item["code"] as? String, "\(item["name"] ?? "")")
        }
        #expect(checked == 34)
    }

    @Test func channelSequenceVectorsFailClosed() throws {
        let oracle = try RelayOracle.load()
        let negatives = try #require(oracle["negative"] as? [[String: Any]])
        var checked = 0
        for item in negatives where item["kind"] as? String == "data_sequence" {
            checked += 1
            let key = SymmetricKey(data: try RelayOracle.bytes(item, "key"))
            let peerDirection = try #require(item["direction"] as? NSNumber).uint8Value
            let channel = RelayChannel(send: key, receive: key, direction: 3 - peerDirection,
                nextReceive: try #require(item["startRecv"] as? NSNumber).uint64Value)
            var accepted = 0
            var code: String?
            for frame in try #require(item["frames"] as? [String]) {
                do { _ = try channel.open(RelayOracle.hex(frame)); accepted += 1 }
                catch { code = (error as? RelayFailure)?.wireCode; break }
            }
            #expect(accepted == (item["accepted"] as? NSNumber)?.intValue, "\(item["name"] ?? "")")
            #expect(channel.failed == (item["expect"] as? String == "reject"))
            #expect(code == item["code"] as? String, "\(item["name"] ?? "")")
            if channel.failed {
                #expect(channel.closed)
                #expect(throws: (any Error).self) { try channel.open(Data()) }
            }
        }
        #expect(checked == 41)
    }

    @Test func finalCounterIsReservedForByeAndLocalSizeRefusalKeepsReceiveOpen() throws {
        let oracle = try RelayOracle.load()
        let sessions = try #require(oracle["sessions"] as? [String: [String: Any]])
        let session = try #require(sessions["resume"])
        let keys = try #require(session["keys"] as? [String: Any])
        let channel = RelayChannel(send: SymmetricKey(data: try RelayOracle.bytes(keys, "c2h")),
            receive: SymmetricKey(data: try RelayOracle.bytes(keys, "h2c")), nextSend: RelayCrypto.maxCounter)
        #expect(throws: RelayFailure.counter) { try channel.seal(Data([1])) }
        #expect(!channel.closed)
        #expect(throws: RelayFailure.malformed) { try channel.seal(Data()) }
        #expect(throws: RelayFailure.oversize) { try channel.seal(Data(count: RelayCrypto.maxPlaintext + 1)) }
        #expect(!channel.closed)
        #expect(try channel.seal(Data(), bye: true).count == 25)
        #expect(channel.streamEnd == "unclean")
    }

    @Test func realP256ImportsAndFrameHeaderBoundaryVectors() throws {
        let oracle = try RelayOracle.load()
        let negatives = try #require(oracle["negative"] as? [[String: Any]])
        var checked = 0
        for item in negatives {
            let kind = item["kind"] as? String
            guard kind == "ec_point" || kind == "frame_length" else { continue }
            checked += 1
            var accepted = false
            do {
                if kind == "ec_point" {
                    _ = try P256.KeyAgreement.PublicKey(x963Representation: RelayOracle.bytes(item, "publicKey"))
                } else {
                    let length = try #require(item["length"] as? NSNumber).intValue
                    var bytes = Data(count: length)
                    if !bytes.isEmpty { bytes[0] = try #require(item["type"] as? NSNumber).uint8Value }
                    _ = try RelayChannel.header(bytes)
                }
                accepted = true
            } catch {}
            #expect(accepted == (item["expect"] as? String == "accept"), "\(item["name"] ?? "")")
        }
        #expect(checked == 17)
    }
}
