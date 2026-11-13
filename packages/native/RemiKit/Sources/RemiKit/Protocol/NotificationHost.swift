import Foundation
import RemiPush

struct NotificationHostRequest: Encodable, Sendable {
    let type = "notification_host_request"
    let id = UUID().uuidString.lowercased()
    let timestamp = Date().ISO8601Format()
    let action: String
}

/// Strict counterpart of shared/notification-host.ts (#1679). No token or device selector.
struct NotificationHostResponse: Decodable, Sendable, Equatable {
    let type: String
    let id: String
    let timestamp: String
    let requestId: String
    let success: Bool
    let state: String?
    let relayUrl: String?
    let expiresAt: String?
    let error: String?

    static func decode(_ bytes: Data) throws -> Self {
        let value = try JSONDecoder().decode(Self.self, from: bytes)
        let fields = try RemiPushJSON.object(bytes, maximum: 16384)
        var keys: Set<String> = ["type", "id", "timestamp", "requestId", "success"]
        guard value.type == "notification_host_response", !value.id.isEmpty, !value.requestId.isEmpty else {
            throw RelayFailure.malformed
        }
        if !value.success {
            keys.insert("error")
            guard let error = value.error, ["UNSUPPORTED", "NOT_AUTHORIZED", "HOST_SETUP_REQUIRED",
                "STORE_ERROR", "CAPACITY", "BUSY"].contains(error) else { throw RelayFailure.malformed }
        } else {
            keys.insert("state")
            if value.state != "revoked" {
                keys.formUnion(["relayUrl", "expiresAt"])
                guard let state = value.state, ["registration_required", "active", "renewal_required"].contains(state),
                      let relay = value.relayUrl, let url = URLComponents(string: relay),
                      url.scheme == "wss", url.host != nil, url.user == nil, url.password == nil,
                      url.path.isEmpty, url.query == nil, url.fragment == nil, url.string == relay,
                      url.port != 443, !relay.contains("%"), relay.utf8.count <= 512 else { throw RelayFailure.malformed }
                if let expiry = value.expiresAt {
                    guard ISO8601DateFormatter().date(from: expiry) != nil ||
                            ISO8601DateFormatter.fractional.date(from: expiry) != nil else { throw RelayFailure.malformed }
                }
            }
        }
        guard Set(fields.keys) == keys else { throw RelayFailure.malformed }
        return value
    }
}

private extension ISO8601DateFormatter {
    static var fractional: ISO8601DateFormatter {
        let value = ISO8601DateFormatter()
        value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return value
    }
}
