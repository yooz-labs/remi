import Foundation

/// The part every protocol message shares: its `type`, which selects the shape of the rest.
///
/// The wire is JSON over WebSocket, defined in `packages/shared/src/protocol.ts`. The golden
/// fixtures in `packages/shared/tests/fixtures/protocol/` are the oracle: a model here is right
/// when it decodes them (see `RemiKitTests`).
public struct Envelope: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String?
    public let timestamp: String?
}
