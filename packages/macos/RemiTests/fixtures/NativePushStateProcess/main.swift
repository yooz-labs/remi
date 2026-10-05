import Foundation

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
    case "invalidate":
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        _ = try lease.invalidateIdentityAuthority()
        print("closed")
    default: exit(2)
    }
} catch { exit(3) }
