import Foundation
import RemiPush

public enum PairedNotificationState: Sendable, Equatable {
    case registering, registered, renewalRequired, disabled, hostSetupRequired, unsupported, failed
    public var title: String {
        switch self {
        case .registering: "Registering notifications"
        case .registered: "Notifications registered"
        case .renewalRequired: "Continue notifications?"
        case .disabled: "Notifications disabled"
        case .hostSetupRequired: "Host notification setup needed"
        case .unsupported: "Update the host for notifications"
        case .failed: "Notification registration failed"
        }
    }
}

/// One bounded encrypted registration, sharing room ownership with foreground/action channels.
enum PairedNotificationRegistration {
    static func register(pin: RelayMachinePin, identity: ClientIdentity, pushStore: RemiPushStore,
                         token: String, environment: String, renewExpired: Bool,
                         validate: @escaping @Sendable () throws -> Void,
                         ownedSession: URLSession? = nil) async throws -> RelayPushResponse {
        let room = RelayCrypto.room(try RelayCrypto.unb64(pin.machinePublicKey))
        guard let lease = RelayChannelBroker.shared.claim(key: RelayChannelBroker.key(device: identity.publicKeyRaw, room: room)) else {
            throw RelayFailure.state
        }
        await lease.retired.value
        let deadline = ContinuousClock.now.advanced(by: .seconds(18))
        var connection: RemiConnection?
        do {
            try validate()
            guard let url = pin.clientURL, let recipient = try pushStore.recipient(createIfMissing: true) else {
                throw RemiPushError.unavailable
            }
            let guardedIdentity = identity.restrictingSignatures(validate)
            let channel = RemiConnection(configuration: .init(url: url, clientVersion: "native-notifications",
                clientId: UUID().uuidString.lowercased(), relayPin: pin), identity: guardedIdentity,
                readyHandler: validate, stateHandler: { _ in }, eventHandler: { _ in })
            connection = channel
            try await channel.configureOneShot()
            #if DEBUG
            if let ownedSession { try await channel.useOwnedTestSession(ownedSession) }
            #endif
            try validate()
            await channel.start()
            try await channel.waitForRelayReady(until: deadline)
            try validate()
            var request = RelayPushRequest(type: "secure_push_register_request", id: UUID().uuidString.lowercased(),
                timestamp: Date().ISO8601Format(), token: token, environment: environment,
                pushPublicKey: RelayCrypto.b64(recipient.publicKey), keyVersion: recipient.keyVersion)
            request.renewExpired = renewExpired ? true : nil
            let result = try await channel.exchange(request, id: request.id,
                expected: .push(type: "secure_push_register_response", keyVersion: recipient.keyVersion),
                until: deadline, validate: {
                    try validate()
                    guard try pushStore.recipient() == recipient else { throw RemiPushError.changed }
                })
            try validate()
            guard case .push(let response) = result else { throw RelayFailure.malformed }
            await channel.stop()
            RelayChannelBroker.shared.release(lease)
            return response
        } catch {
            await connection?.stop()
            RelayChannelBroker.shared.release(lease)
            throw error
        }
    }
}
