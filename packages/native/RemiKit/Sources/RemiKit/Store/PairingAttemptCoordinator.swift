import Foundation
import RemiPush

public struct PairingAttemptState: Sendable, Equatable, Identifiable {
    public enum Phase: Sendable, Equatable {
        case connecting
        case authenticating
        case retrying(code: String)
        case admitted(profileID: String)
        case failed(reason: String)
        case cancelled

        public var isTerminal: Bool {
            switch self {
            case .admitted, .failed, .cancelled: true
            default: false
            }
        }
    }

    public let id: UUID
    public let address: String?
    public let layer: MachineConnectionLayer?
    public let phase: Phase

    public var message: String {
        switch phase {
        case .connecting: "Connecting to \(address ?? "the machine")"
        case .authenticating: "Verifying the machine identity"
        case .retrying(let code):
            code == "PAIRING_PENDING" ? "Waiting for terminal approval (PAIRING_PENDING)" :
                "\(PushDisplayText.escape(RemiConnection.authenticationDescription(code))) Retrying this address (\(PushDisplayText.escape(code)))."
        case .admitted: "Pairing approved"
        case .failed(let reason): PushDisplayText.escape(reason)
        case .cancelled: "Pairing cancelled"
        }
    }
}

/// A synchronous producer boundary and one consumer preserve callback order (#1574).
/// Overflow revokes admission synchronously, before the consumer can promote a queued Hello.
final class PairingCallbackBridge: @unchecked Sendable {
    enum Callback: Sendable {
        case state(RemiConnectionState)
        case event(RemiInboundEvent)
        case authenticationRetry(String)
    }
    let stream: AsyncStream<Callback>
    private let continuation: AsyncStream<Callback>.Continuation
    private let lock = NSLock()
    private var valid = true
    private(set) var overflowed = false

    init() {
        let pair = AsyncStream<Callback>.makeStream(bufferingPolicy: .bufferingOldest(128))
        stream = pair.stream
        continuation = pair.continuation
    }

    func yield(_ callback: Callback) {
        lock.lock(); defer { lock.unlock() }
        guard valid else { return }
        if case .dropped = continuation.yield(callback) {
            overflowed = true
            valid = false
            continuation.finish()
        }
    }

    /// The admission commit and domain forwarding have no suspension point while
    /// holding this fence. An overflow cannot race a successful validity check.
    func ifValid<T>(_ body: () throws -> T) rethrows -> T? {
        lock.lock(); defer { lock.unlock() }
        guard valid else { return nil }
        return try body()
    }

    var didOverflow: Bool {
        lock.lock(); defer { lock.unlock() }; return overflowed
    }

    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        valid = false
        continuation.finish()
    }
}

struct PairingAdoption {
    let endpoint: MachineEndpoint
    let generation: UUID
    let profileID: String
}

/// One initial pairing owner. Candidates are never normal Store routes until
/// verified Hello and the Store's final authority/lifetime check both succeed.
@MainActor
final class PairingAttemptCoordinator {
    let id: UUID
    private var candidates: [MachineEndpoint]
    private let authority: Data
    private let machineID: String
    private let deadline: Date
    private let identity: ClientIdentity
    private let clientVersion: String
    private let clientID: String
    private let validate: () throws -> Void
    private let publish: (PairingAttemptState) -> Void
    private let admit: (RemiConnection, MachineEndpoint, HelloAckMessage, Data) throws -> PairingAdoption
    private let forward: (PairingCallbackBridge.Callback, PairingAdoption) -> Void
    private var active = true
    private var bridge: PairingCallbackBridge?
    private var connection: RemiConnection?
    private var worker: Task<Void, Never>?
    private var expiration: Task<Void, Never>?
    private var retirement: Task<Void, Never>?
    private var predecessorRetirement: Task<Void, Never>?
    private var adoption: PairingAdoption?
    private var address: String?
    private var layer: MachineConnectionLayer?
    #if DEBUG
    var ownedBeforeAdmission: (@MainActor () async -> Void)?
    private(set) var ownedAttemptedAddresses: [String] = []
    private(set) var ownedAdmittedConfiguration: RemiConnectionConfiguration?
    #endif

    init(id: UUID, candidates: [MachineEndpoint], authority: Data, machineID: String,
         deadline: Date, identity: ClientIdentity, clientVersion: String, clientID: String,
         validate: @escaping () throws -> Void, publish: @escaping (PairingAttemptState) -> Void,
         admit: @escaping (RemiConnection, MachineEndpoint, HelloAckMessage, Data) throws -> PairingAdoption,
         forward: @escaping (PairingCallbackBridge.Callback, PairingAdoption) -> Void) {
        self.id = id; self.candidates = candidates; self.authority = authority
        self.machineID = machineID; self.deadline = deadline; self.identity = identity
        self.clientVersion = clientVersion; self.clientID = clientID
        self.validate = validate; self.publish = publish; self.admit = admit; self.forward = forward
    }

    func start(after retirement: Task<Void, Never>?) {
        predecessorRetirement = retirement
        worker = Task { [self] in
            await retirement?.value
            guard active else { return }
            expiration = Task { [weak self, deadline] in
                do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) }
                catch { return }
                guard !Task.isCancelled, self?.adoption == nil else { return }
                self?.fail("The pairing code expired. Run remi pair again.")
            }
            await run()
        }
    }

    @discardableResult func cancel() -> Task<Void, Never> {
        guard active, adoption == nil else { return retirement ?? Task {} }
        active = false
        bridge?.invalidate()
        candidates.removeAll()
        expiration?.cancel()
        let stopping = retireConnection()
        publishState(.cancelled)
        return stopping
    }

    private func publishState(_ phase: PairingAttemptState.Phase) {
        publish(.init(id: id, address: address, layer: layer, phase: phase))
    }

    private func fail(_ reason: String) {
        guard active else { return }
        active = false
        bridge?.invalidate()
        candidates.removeAll()
        expiration?.cancel()
        _ = retireConnection()
        if let adoption { forward(.state(.rejected(reason: reason)), adoption) }
        else { publishState(.failed(reason: reason)) }
    }

    private func retireConnection() -> Task<Void, Never> {
        if let retirement { return retirement }
        let connection = connection, predecessor = predecessorRetirement
        let stopping = Task<Void, Never> { [weak self] in
            // A replacement can itself be cancelled while still waiting for an
            // older socket. Carry that retirement through the entire chain.
            await predecessor?.value
            await connection?.stop()
            if self?.adoption == nil { self?.connection = nil }
        }
        retirement = stopping
        return stopping
    }

    private func check() throws {
        guard active, Date() < deadline else { throw PairingAdmissionError.refused("The pairing attempt is no longer current.") }
        try validate()
    }

    private func run() async {
        while active, !candidates.isEmpty {
            var endpoint = candidates.removeFirst()
            do { try check() } catch { fail(error.localizedDescription); return }
            guard let url = endpoint.webSocketURL else { fail("The pairing address is invalid."); return }
            address = endpoint.displayAddress; layer = endpoint.connectionLayer
            let bridge = PairingCallbackBridge()
            self.bridge = bridge
            let connection = RemiConnection(configuration: .init(url: url, clientVersion: clientVersion,
                clientId: clientID, deviceId: clientID, expectedServerFingerprint: endpoint.expectedFingerprint,
                expectedServerPublicKey: endpoint.expectedPublicKey, pairingNonce: endpoint.pairingNonce,
                pairingLabel: endpoint.pairingLabel, expectedMachineID: machineID,
                directRetryPolicy: .coordinatedPairing), identity: identity,
                authenticationRetryHandler: { bridge.yield(.authenticationRetry($0)) },
                stateHandler: { bridge.yield(.state($0)) }, eventHandler: { bridge.yield(.event($0)) })
            self.connection = connection
            #if DEBUG
            ownedAttemptedAddresses.append(endpoint.displayAddress)
            #endif
            publishState(.connecting)
            await connection.start()
            var advance = false
            for await callback in bridge.stream {
                guard active else { return }
                if bridge.didOverflow { fail("Pairing stopped because the callback queue overflowed."); return }
                if let adoption {
                    _ = bridge.ifValid { forward(callback, adoption) }
                    if case .state(.stopped) = callback { bridge.invalidate(); active = false; return }
                    continue
                }
                switch callback {
                case .state(.reachabilityFailed): advance = true
                case .state(.rejected(let reason)): fail(reason)
                case .state(.awaitingLocalApproval): fail("The machine refused the pairing claim (UNKNOWN_KEY).")
                case .state(.stopped): fail("The pairing connection stopped.")
                case .state(.authenticating): publishState(.authenticating)
                case .authenticationRetry(let code): publishState(.retrying(code: code))
                case .event(.hello(let hello, let key)):
                    do {
                        try check()
                        guard key == authority, (hello.protocolVersion ?? 1) == PairingPayload.protocolVersion,
                              (hello.machine.map { $0.id == machineID } ?? true) else {
                            throw PairingAdmissionError.refused("The pairing Hello did not match the expected machine authority and protocol.")
                        }
                        #if DEBUG
                        await ownedBeforeAdmission?()
                        #endif
                        try await connection.completeCoordinatedAdmission()
                        #if DEBUG
                        let admittedConfiguration = await connection.ownedConfiguration
                        #endif
                        // No original nonce/label survives the adoption, even on future reconnects.
                        endpoint = endpoint.withoutPairingContext
                        try check()
                        guard let adopted = try bridge.ifValid({
                            try admit(connection, endpoint, hello, authority)
                        }) else { throw PairingAdmissionError.refused("Pairing callbacks are no longer current.") }
                        adoption = adopted
                        candidates.removeAll()
                        expiration?.cancel()
                        #if DEBUG
                        ownedAdmittedConfiguration = admittedConfiguration
                        #endif
                        publishState(.admitted(profileID: adopted.profileID))
                    } catch { fail(error.localizedDescription) }
                case .event:
                    // Pre-Hello application frames are refused by RemiConnection. Nothing else
                    // acquires Store dispatch authority until same-socket adoption completes.
                    break
                default: break
                }
                if !active || advance { break }
            }
            bridge.invalidate() // retire callbacks before stop/start of the next candidate
            await connection.stop()
            self.connection = nil
            if active, adoption == nil, !advance {
                fail("Pairing stopped because the callback queue overflowed.")
            }
        }
        if active, adoption == nil { fail("No permitted pairing address is reachable. Check the selected connection layer.") }
    }
}

struct PairingAdmissionError: LocalizedError {
    let reason: String
    static func refused(_ reason: String) -> Self { Self(reason: reason) }
    var errorDescription: String? { reason }
}
