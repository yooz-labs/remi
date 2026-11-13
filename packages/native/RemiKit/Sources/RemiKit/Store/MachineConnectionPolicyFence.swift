import Foundation

/// A layer lock restricts existing notification authority. It never enrolls
/// a device, installs trust, or supplies a machine key.
final class MachineConnectionPolicyFence: @unchecked Sendable {
    static let shared = MachineConnectionPolicyFence()
    private let lock = NSLock()
    private struct Entry { var owner: UInt64; var revision: UInt64; var permits: Bool }
    private var entries: [String: Entry] = [:]
    private var removedThrough: [String: UInt64] = [:]
    private var nextOwner: UInt64 = 0

    func makeOwner() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        nextOwner += 1
        return nextOwner
    }

    func seed(_ profiles: [MachineRouteProfile]) {
        lock.lock(); defer { lock.unlock() }
        for profile in profiles {
            guard let verified = try? profile.verifiedSavedIdentity() else { continue }
            let id = verified.machineID
            let permits = profile.connectionPreference == .automatic || profile.connectionPreference == .relayOnly
            // A cold snapshot cannot replace a live selection or resurrect a
            // forgotten profile. Process restart reads the durable policy anew.
            if entries[id] == nil, removedThrough[id] == nil {
                entries[id] = Entry(owner: 0, revision: 0, permits: permits)
            }
        }
    }

    func publish(_ preference: MachineConnectionPreference, machineID: String, owner: UInt64, explicit: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        guard owner > (removedThrough[machineID] ?? 0) else { return }
        let previous = entries[machineID]
        guard explicit || previous?.owner == owner || owner >= (previous?.revision ?? 0) else { return }
        let permits = preference == .automatic || preference == .relayOnly
        // Only a current explicit UI selection relaxes a restriction. A newer
        // Store can take ownership without an older snapshot unlocking Relay.
        if explicit { nextOwner += 1 }
        entries[machineID] = Entry(owner: owner,
            revision: explicit ? nextOwner : max(owner, previous?.revision ?? 0),
            permits: explicit ? permits : (previous?.permits ?? true) && permits)
    }

    func remove(machineID: String, owner: UInt64) {
        lock.lock(); defer { lock.unlock() }
        guard owner > (removedThrough[machineID] ?? 0) else { return }
        nextOwner += 1
        entries[machineID] = nil
        removedThrough[machineID] = nextOwner
    }

    func permitsRelay(room: Data) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard room.count == 16 else { return false }
        return entries[RelayCrypto.hex(room)]?.permits ?? true
    }
}
