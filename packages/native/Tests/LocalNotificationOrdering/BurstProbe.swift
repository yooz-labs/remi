#if BURST_DIAGNOSTICS
import Foundation

/// Test-only OS boundary: records request IDs and can delay adds or removals independently.
final class BurstProbe: @unchecked Sendable {
    struct Request: Equatable, Sendable { let identifier: String; let logicalID: String; let body: String }
    static let shared = BurstProbe()
    private let lock = NSLock()
    private var recorded: [String] = []
    private var heldAdds: Set<String> = []
    private var pendingAdds: [String: (Request, CheckedContinuation<Void, Never>)] = [:]
    private var heldRemovals: Set<String> = []
    private var pendingRemovals: Set<String> = []
    private var visible: [String: Request] = [:]

    func reset() {
        lock.lock(); defer { lock.unlock() }
        recorded.removeAll(); heldAdds.removeAll(); pendingAdds.removeAll()
        heldRemovals.removeAll(); pendingRemovals.removeAll(); visible.removeAll()
    }
    func holdNextAdd(_ logicalID: String) { lock.lock(); defer { lock.unlock() }; heldAdds.insert(logicalID) }
    func holdNextRemoval(_ requestID: String) { lock.lock(); defer { lock.unlock() }; heldRemovals.insert(requestID) }
    func snapshot() -> [String] { lock.lock(); defer { lock.unlock() }; return recorded }
    func requests(for logicalID: String) -> [Request] {
        lock.lock(); defer { lock.unlock() }
        return visible.values.filter { $0.logicalID == logicalID }.sorted { $0.identifier < $1.identifier }
    }
    func pendingAddRequest(for logicalID: String) -> Request? {
        lock.lock(); defer { lock.unlock() }; return pendingAdds[logicalID]?.0
    }
    func observe(_ ids: Set<String>) { lock.lock(); defer { lock.unlock() }; recorded.append("observe:" + ids.sorted().joined(separator: ",")) }
    func finished(_ logicalID: String) { lock.lock(); defer { lock.unlock() }; recorded.append("finished:" + logicalID) }
    func remove(_ ids: [String]) {
        lock.lock(); defer { lock.unlock() }
        for id in ids.sorted() {
            recorded.append("remove:" + id)
            if heldRemovals.remove(id) != nil { pendingRemovals.insert(id) }
            else { visible.removeValue(forKey: id) }
        }
    }
    func releaseRemoval(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        guard pendingRemovals.remove(id) != nil else { return }
        recorded.append("remove-complete:" + id); visible.removeValue(forKey: id)
    }
    func add(identifier: String, logicalID: String, body: String) async {
        let request = Request(identifier: identifier, logicalID: logicalID, body: body)
        await withCheckedContinuation { continuation in
            lock.lock(); recorded.append("begin:" + logicalID + ":" + body)
            if heldAdds.remove(logicalID) != nil {
                pendingAdds[logicalID] = (request, continuation); lock.unlock()
            } else {
                visible[identifier] = request; recorded.append("add:" + logicalID + ":" + body)
                lock.unlock(); continuation.resume()
            }
        }
    }
    func releaseAdd(_ logicalID: String) {
        lock.lock()
        guard let (request, continuation) = pendingAdds.removeValue(forKey: logicalID) else { lock.unlock(); return }
        visible[request.identifier] = request; recorded.append("add:" + logicalID + ":" + request.body)
        lock.unlock(); continuation.resume()
    }
}
#endif
