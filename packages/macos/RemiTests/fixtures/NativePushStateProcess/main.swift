import Foundation

private struct PublicContentFixture: Decodable {
    let rid: Data; let collapseId: String; let revision: Int64; let kind: Int
    let nonce: Data; let digest: Data; let issuedAt: Int64; let expiresAt: Int64
    var record: NativePushState.ContentRecord {
        .init(rid: rid, collapseId: collapseId, revision: revision, kind: kind,
              nonce: nonce, digest: digest, issuedAt: issuedAt, expiresAt: expiresAt)
    }
}

// Test-only executable constructs the actual production store in a different
// process. No private identity, Keychain namespace or App Group is accessed.
do {
    guard CommandLine.arguments.count == 4 else { exit(2) }
    let state = try NativePushState(file: URL(fileURLWithPath: CommandLine.arguments[1]))
    switch CommandLine.arguments[2] {
    case "probe":
        do {
            let lease = try state.acquireIdentityMutation()
            lease.release()
            print("acquired")
        } catch NativePushStateError.busy { print("busy") }
    case "observe":
        print(try state.currentAuthority()?.revision == CommandLine.arguments[3] ? "current" : "changed")
    case "record":
        guard let bytes = Data(base64Encoded: CommandLine.arguments[3]) else { exit(2) }
        let content = try JSONDecoder().decode(PublicContentFixture.self, from: bytes).record
        guard let trust = try state.machineTrust(rid: content.rid) else { exit(3) }
        let file = URL(fileURLWithPath: CommandLine.arguments[1])
        try Data().write(to: file.appendingPathExtension("ready-" + String(ProcessInfo.processInfo.processIdentifier)))
        let deadline = ProcessInfo.processInfo.systemUptime + 10
        while !FileManager.default.fileExists(atPath: file.appendingPathExtension("start").path) {
            guard ProcessInfo.processInfo.systemUptime < deadline else { exit(4) }
            Thread.sleep(forTimeInterval: 0.01)
        }
        switch try state.recordVerifiedContent(content, trust: trust, now: 1000) {
        case .publish: print("publish")
        case .duplicate: print("duplicate")
        case .dismiss: print("dismiss")
        }
    case "invalidate":
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        _ = try lease.invalidateIdentityAuthority()
        print("closed")
    default: exit(2)
    }
} catch { exit(3) }
