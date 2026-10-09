import RemiPush

/// Verified alerts only. RemiKit and the Dpk signer are app-exclusive (#1242).
final class NotificationService: RemiPushServiceExtension, @unchecked Sendable {}
