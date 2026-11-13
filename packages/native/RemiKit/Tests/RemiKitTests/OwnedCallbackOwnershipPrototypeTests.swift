import Foundation
import Testing
@testable import RemiKit

// #1727 qualification only. No production transport, Store, or scheduling caller uses this model.
// These toy capacities count logical payloads, not Foundation heap or whole-process memory.
private struct ToyOwner: Hashable, Sendable { let profile: Int; let epoch: Int }
private struct ToyTicket: Hashable, Sendable {
    let id: Int
    let owner: ToyOwner
    let payload: String
    var bytes: Int { payload.utf8.count }
}
private enum ToyRPCOutcome: Sendable, Equatable { case reply(String), timeout, closed, cancelled }
private struct ToySnapshot: Sendable {
    let owners: Int, queued: Int, entered: Int, waiters: Int, bytes: Int, peakBytes: Int, peakItems: Int, peakEntered: Int
    let released: Int, effects: [String]
}

/// A deliberately synchronous actor model. It never waits for Store, calls a user closure,
/// or suspends while admitting, selecting, revoking, transferring, or completing tickets.
private actor ToyOrderedOwnership {
    private struct OwnerState {
        var adopted = false
        var revoked = false
        var queue: [ToyTicket] = []
        var entered: ToyTicket?
        var bytes = 0
        var control = false
    }
    private struct Waiter {
        let id: String
        let continuation: CheckedContinuation<ToyRPCOutcome, Never>
        let timeout: Task<Void, Never>
    }
    private let totalBytes: Int, ownerBytes: Int, ownerItems: Int, ownerLimit: Int, workerLimit: Int
    private var owners: [ToyOwner: OwnerState] = [:]
    private var ready: [ToyOwner] = []
    private var waiters: [ToyOwner: Waiter] = [:]
    private var nextID = 0, usedBytes = 0, usedItems = 0, enteredCount = 0
    private var peakBytes = 0, peakItems = 0, peakEntered = 0, released = 0
    private var effects: [String] = []

    init(totalBytes: Int, ownerBytes: Int, ownerItems: Int, ownerLimit: Int, workerLimit: Int = 2) {
        self.totalBytes = totalBytes; self.ownerBytes = ownerBytes
        self.ownerItems = ownerItems; self.ownerLimit = ownerLimit; self.workerLimit = workerLimit
    }
    func admit(_ owner: ToyOwner) -> Bool {
        guard owners.count < ownerLimit, owners[owner] == nil,
              !owners.contains(where: { $0.key.profile == owner.profile && !$0.value.revoked }) else { return false }
        owners[owner] = OwnerState()
        return true
    }
    func enqueue(_ payload: String, owner: ToyOwner) -> ToyTicket? {
        guard var state = owners[owner], !state.revoked else { return nil }
        let count = payload.utf8.count
        guard count > 0, count <= totalBytes - usedBytes, count <= ownerBytes - state.bytes,
              state.queue.count + (state.entered == nil ? 0 : 1) < ownerItems else { return nil }
        nextID += 1
        let ticket = ToyTicket(id: nextID, owner: owner, payload: payload)
        state.queue.append(ticket); state.bytes += count
        usedBytes += count; usedItems += 1
        peakBytes = max(peakBytes, usedBytes); peakItems = max(peakItems, usedItems)
        owners[owner] = state
        if state.entered == nil && !ready.contains(owner) { ready.append(owner) }
        return ticket
    }
    func adopt(_ owner: ToyOwner, expected: ToyOwner) -> Bool {
        guard owner == expected, var state = owners[owner], !state.revoked, !state.adopted else { return false }
        state.adopted = true; owners[owner] = state
        return true
    }
    func signalControl(_ owner: ToyOwner) -> Bool {
        guard var state = owners[owner], !state.revoked else { return false }
        state.control = true; owners[owner] = state; return true
    }
    func hasControl(_ owner: ToyOwner) -> Bool { owners[owner]?.control == true }
    func beginNext() -> ToyTicket? {
        guard enteredCount < workerLimit else { return nil }
        while !ready.isEmpty {
            let owner = ready.removeFirst()
            guard var state = owners[owner], !state.revoked, state.entered == nil, !state.queue.isEmpty else { continue }
            let ticket = state.queue.removeFirst(); state.entered = ticket; owners[owner] = state
            enteredCount += 1; peakEntered = max(peakEntered, enteredCount)
            return ticket
        }
        return nil
    }
    func finish(_ ticket: ToyTicket) -> Bool {
        guard var state = owners[ticket.owner], state.entered == ticket else { return false }
        state.entered = nil; state.bytes -= ticket.bytes
        usedBytes -= ticket.bytes; usedItems -= 1; enteredCount -= 1; released += 1
        // Modeled entry linearizes before revocation; a real reentrant Store mutation is unproven.
        effects.append("\(ticket.owner.profile).\(ticket.owner.epoch):\(ticket.payload)")
        if state.revoked && state.queue.isEmpty { owners.removeValue(forKey: ticket.owner) }
        else {
            owners[ticket.owner] = state
            if !state.revoked && !state.queue.isEmpty && !ready.contains(ticket.owner) { ready.append(ticket.owner) }
        }
        return true
    }
    func revoke(_ owner: ToyOwner) {
        guard var state = owners[owner], !state.revoked else { return }
        state.revoked = true
        for ticket in state.queue {
            state.bytes -= ticket.bytes; usedBytes -= ticket.bytes; usedItems -= 1; released += 1
        }
        state.queue.removeAll(); ready.removeAll { $0 == owner }
        closeWaiter(owner, result: .closed)
        if state.entered == nil { owners.removeValue(forKey: owner) } else { owners[owner] = state }
    }
    func validateAndEnqueue(_ payload: String, owner: ToyOwner, descriptor: MachineDescriptor?,
                            sessions: [DiscoverableSession], authority: Data) -> Bool {
        guard let state = owners[owner], !state.revoked else { return false }
        do {
            try MachineIdentityVerifier.verify(descriptor: descriptor, sessions: sessions, authorityPublicKey: authority)
            return enqueue(payload, owner: owner) != nil
        } catch {
            revoke(owner)
            return false
        }
    }
    func waitForRPC(_ id: String, owner: ToyOwner, timeout: Duration) async -> ToyRPCOutcome {
        guard let state = owners[owner], !state.revoked, waiters[owner] == nil else { return .closed }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let timer = Task {
                    do { try await Task.sleep(for: timeout) } catch { return }
                    expire(owner, id: id)
                }
                waiters[owner] = Waiter(id: id, continuation: continuation, timeout: timer)
                if Task.isCancelled { closeWaiter(owner, result: .cancelled) }
            }
        } onCancel: {
            Task { await self.cancel(owner, id: id) }
        }
    }
    func hasWaiter(_ owner: ToyOwner, id: String) -> Bool { waiters[owner]?.id == id }
    func respond(_ id: String, owner: ToyOwner, payload: String) -> Bool {
        guard let state = owners[owner], !state.revoked, waiters[owner]?.id == id else { return false }
        closeWaiter(owner, result: .reply(payload)); return true
    }
    private func expire(_ owner: ToyOwner, id: String) {
        guard waiters[owner]?.id == id else { return }
        closeWaiter(owner, result: .timeout)
    }
    private func cancel(_ owner: ToyOwner, id: String) {
        guard waiters[owner]?.id == id else { return }
        closeWaiter(owner, result: .cancelled)
    }
    private func closeWaiter(_ owner: ToyOwner, result: ToyRPCOutcome) {
        guard let waiter = waiters.removeValue(forKey: owner) else { return }
        waiter.timeout.cancel(); waiter.continuation.resume(returning: result)
    }
    func snapshot() -> ToySnapshot {
        ToySnapshot(owners: owners.count, queued: owners.values.reduce(0) { $0 + $1.queue.count },
                    entered: enteredCount, waiters: waiters.count, bytes: usedBytes,
                    peakBytes: peakBytes, peakItems: peakItems, peakEntered: peakEntered, released: released, effects: effects)
    }
}

@Suite(.serialized)
struct OwnedCallbackOwnershipPrototypeTests {
    private let a = ToyOwner(profile: 1, epoch: 1)
    private let b = ToyOwner(profile: 2, epoch: 1)

    @Test func heldOwnerRetainsFIFOButOtherOwnerMakesFairProgress() async throws {
        let model = ToyOrderedOwnership(totalBytes: 8, ownerBytes: 5, ownerItems: 3, ownerLimit: 2)
        #expect(await model.admit(a)); #expect(await model.admit(b))
        let question = try #require(await model.enqueue("Q", owner: a))
        let resolution = try #require(await model.enqueue("R", owner: a))
        let b1 = try #require(await model.enqueue("1", owner: b))
        #expect(await model.beginNext() == question)
        #expect(await model.beginNext() == b1)
        #expect(await model.beginNext() == nil) // The first A callback remains entered.
        #expect(await model.finish(b1))
        let b2 = try #require(await model.enqueue("2", owner: b))
        #expect(await model.finish(question))
        #expect(await model.beginNext() == b2)
        #expect(await model.finish(b2))
        let b3 = try #require(await model.enqueue("3", owner: b))
        #expect(await model.beginNext() == resolution) // A precedes B's requeued third event.
        #expect(await model.finish(resolution))
        #expect(await model.beginNext() == b3)
        #expect(await model.finish(b3))
        let observed = await model.snapshot()
        #expect(observed.effects == ["2.1:1", "1.1:Q", "2.1:2", "1.1:R", "2.1:3"])
        #expect(observed.bytes == 0 && observed.released == 5 && observed.peakBytes == 3 && observed.peakEntered == 2)
        await model.revoke(a); await model.revoke(b)
        #expect(await model.snapshot().owners == 0)
    }

    @Test func fullPayloadPoolKeepsControlAndEnforcesBothShares() async throws {
        let model = ToyOrderedOwnership(totalBytes: 5, ownerBytes: 3, ownerItems: 2, ownerLimit: 2)
        #expect(await model.admit(a)); #expect(await model.admit(b))
        #expect(!(await model.admit(ToyOwner(profile: 3, epoch: 1))))
        let a1 = try #require(await model.enqueue("aa", owner: a))
        #expect(await model.enqueue("aa", owner: a) == nil) // Per-owner byte share.
        let a2 = try #require(await model.enqueue("a", owner: a))
        #expect(await model.enqueue("x", owner: a) == nil) // Per-owner item share.
        let b1 = try #require(await model.enqueue("bb", owner: b))
        #expect(await model.enqueue("x", owner: b) == nil) // Global pool.
        #expect(await model.signalControl(b)); #expect(await model.hasControl(b))
        let full = await model.snapshot()
        #expect(full.peakBytes == 5 && full.peakItems == 3)
        #expect(await model.beginNext() == a1); #expect(await model.beginNext() == b1)
        #expect(await model.finish(a1)); #expect(await model.finish(b1))
        #expect(await model.beginNext() == a2); #expect(await model.finish(a2))
        await model.revoke(a); await model.revoke(b)
        let end = await model.snapshot()
        #expect(end.owners == 0 && end.queued == 0 && end.entered == 0 && end.bytes == 0 && end.released == 3)
        let itemModel = ToyOrderedOwnership(totalBytes: 8, ownerBytes: 5, ownerItems: 2, ownerLimit: 1)
        #expect(await itemModel.admit(a))
        #expect(await itemModel.enqueue("a", owner: a) != nil)
        #expect(await itemModel.enqueue("b", owner: a) != nil)
        #expect(await itemModel.enqueue("c", owner: a) == nil) // Bytes remain; the item cap refuses.
        await itemModel.revoke(a)
        #expect(await itemModel.snapshot().bytes == 0)
        let workerModel = ToyOrderedOwnership(totalBytes: 8, ownerBytes: 4, ownerItems: 2, ownerLimit: 2, workerLimit: 1)
        #expect(await workerModel.admit(a)); #expect(await workerModel.admit(b))
        let workerA = try #require(await workerModel.enqueue("a", owner: a))
        let workerB = try #require(await workerModel.enqueue("b", owner: b))
        #expect(await workerModel.beginNext() == workerA)
        #expect(await workerModel.beginNext() == nil)
        #expect(await workerModel.finish(workerA))
        #expect(await workerModel.beginNext() == workerB)
        #expect(await workerModel.finish(workerB))
        let workers = await workerModel.snapshot()
        #expect(workers.peakEntered == 1 && workers.entered == 0)
        await workerModel.revoke(a); await workerModel.revoke(b)
    }

    @Test func adoptionPreservesPreHelloAndPostHelloFIFOAndCharges() async throws {
        let model = ToyOrderedOwnership(totalBytes: 8, ownerBytes: 8, ownerItems: 4, ownerLimit: 1)
        #expect(await model.admit(a))
        let preHello = try #require(await model.enqueue("P", owner: a))
        let before = await model.snapshot()
        #expect(await model.adopt(a, expected: a))
        let after = await model.snapshot()
        #expect(before.bytes == after.bytes && before.queued == after.queued && before.released == after.released)
        let admitted = try #require(await model.enqueue("A", owner: a))
        #expect(preHello.id != admitted.id)
        #expect(await model.beginNext() == preHello)
        #expect(await model.beginNext() == nil)
        #expect(await model.finish(preHello))
        #expect(await model.beginNext() == admitted)
        #expect(await model.finish(admitted))
        await model.revoke(a)
        let end = await model.snapshot()
        #expect(end.effects == ["1.1:P", "1.1:A"] && end.bytes == 0 && end.released == 2 && end.owners == 0)
    }

    @Test func adoptionTransfersExactTicketsAndRevocationCannotEnterOldQueue() async throws {
        let model = ToyOrderedOwnership(totalBytes: 12, ownerBytes: 8, ownerItems: 4, ownerLimit: 3)
        let replacement = ToyOwner(profile: a.profile, epoch: 2)
        #expect(await model.admit(a)); #expect(await model.admit(b))
        let first = try #require(await model.enqueue("A", owner: a))
        let second = try #require(await model.enqueue("Z", owner: a))
        #expect(!(await model.adopt(a, expected: b)))
        #expect(!(await model.adopt(a, expected: replacement)))
        #expect(await model.adopt(a, expected: a)); #expect(!(await model.adopt(a, expected: a)))
        #expect(await model.beginNext() == first)
        await model.revoke(a) // Entered first stays charged; queued second is released.
        #expect(await model.enqueue("old", owner: a) == nil)
        #expect(await model.admit(replacement))
        #expect(!(await model.adopt(a, expected: replacement)))
        let third = try #require(await model.enqueue("N", owner: replacement))
        let other = try #require(await model.enqueue("B", owner: b))
        #expect(!(await model.finish(second)))
        #expect(await model.beginNext() == third)
        let saturated = await model.snapshot()
        #expect(saturated.entered == 2 && saturated.queued == 1 && saturated.peakEntered == 2)
        #expect(await model.beginNext() == nil) // Old and replacement A occupy both workers.
        #expect(await model.finish(third))
        let stillHeld = await model.snapshot()
        #expect(stillHeld.entered == 1 && stillHeld.queued == 1)
        #expect(await model.beginNext() == other) // B enters while old A is still held.
        #expect(await model.finish(other))
        #expect(await model.finish(first)); #expect(!(await model.finish(first)))
        await model.revoke(replacement); await model.revoke(b)
        let end = await model.snapshot()
        #expect(end.owners == 0 && end.queued == 0 && end.entered == 0 && end.bytes == 0 && end.released == 4)
        #expect(end.effects == ["1.2:N", "2.1:B", "1.1:A"])
    }

    @Test func identityValidationPrecedesModeledRPCAndHeldStoreDoesNotBlockReply() async throws {
        let model = ToyOrderedOwnership(totalBytes: 20, ownerBytes: 10, ownerItems: 3, ownerLimit: 3)
        let c = ToyOwner(profile: 3, epoch: 1)
        #expect(await model.admit(a)); #expect(await model.admit(b)); #expect(await model.admit(c))
        let identity = ClientIdentity(), stranger = ClientIdentity()
        let goodID = try MachineIdentityVerifier.machineID(forPublicKey: identity.publicKeyRaw)
        let badID = try MachineIdentityVerifier.machineID(forPublicKey: stranger.publicKeyRaw)
        func descriptor(_ id: String) -> MachineDescriptor {
            MachineDescriptor(id: id, name: "Owned Test", platform: "macOS", remiVersion: "test",
                              harnesses: [], capabilities: [])
        }
        let sessionData = Data("""
        {"sessionId":"owned","projectPath":"/synthetic","status":"idle","source":"daemon","machineId":"\(badID)"}
        """.utf8)
        let badSession = try JSONDecoder().decode(DiscoverableSession.self, from: sessionData)
        #expect(await model.validateAndEnqueue("Q", owner: a, descriptor: descriptor(goodID), sessions: [], authority: identity.publicKeyRaw))
        let held = try #require(await model.beginNext())
        let pending = Task { await model.waitForRPC("request-a", owner: a, timeout: .seconds(2)) }
        try await until { await model.hasWaiter(self.a, id: "request-a") }
        #expect(!(await model.respond("wrong", owner: a, payload: "no")))
        #expect(await model.respond("request-a", owner: a, payload: "ok"))
        #expect(await pending.value == .reply("ok"))
        #expect(await model.snapshot().entered == 1) // Reply resolved before the held commit completed.

        let invalidPending = Task { await model.waitForRPC("request-b", owner: b, timeout: .seconds(2)) }
        try await until { await model.hasWaiter(self.b, id: "request-b") }
        #expect(!(await model.validateAndEnqueue("bad", owner: b, descriptor: descriptor(goodID),
                                                sessions: [badSession], authority: identity.publicKeyRaw)))
        #expect(await invalidPending.value == .closed)
        #expect(!(await model.respond("request-b", owner: b, payload: "late")))
        #expect(!(await model.validateAndEnqueue("bad", owner: c, descriptor: descriptor(badID),
                                                sessions: [], authority: identity.publicKeyRaw)))
        #expect(!(await model.respond("late", owner: c, payload: "late")))
        #expect(await model.finish(held))
        let timeout = Task { await model.waitForRPC("timeout", owner: a, timeout: .milliseconds(40)) }
        #expect(await timeout.value == .timeout)
        let cancelled = Task { await model.waitForRPC("cancelled", owner: a, timeout: .seconds(2)) }
        try await until { await model.hasWaiter(self.a, id: "cancelled") }
        cancelled.cancel()
        #expect(await cancelled.value == .cancelled)
        await model.revoke(a)
        let end = await model.snapshot()
        #expect(end.owners == 0 && end.queued == 0 && end.entered == 0 && end.waiters == 0 && end.bytes == 0)
    }

    @Test func concurrentDuplicateFinishAndRevocationReleaseExactlyOnce() async throws {
        let model = ToyOrderedOwnership(totalBytes: 8, ownerBytes: 8, ownerItems: 2, ownerLimit: 1)
        #expect(await model.admit(a))
        let ticket = try #require(await model.enqueue("owned", owner: a))
        #expect(await model.beginNext() == ticket)
        let ownerA = a
        let wins = await withTaskGroup(of: Bool.self, returning: Int.self) { group in
            for _ in 0..<32 { group.addTask { await model.finish(ticket) } }
            group.addTask { await model.revoke(ownerA); return false }
            var count = 0
            for await win in group { if win { count += 1 } }
            return count
        }
        await model.revoke(a)
        let end = await model.snapshot()
        #expect(wins == 1 && end.released == 1 && end.bytes == 0 && end.owners == 0)
    }

    private enum Failure: Error { case deadline }
    private func until(_ condition: () async -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while ContinuousClock.now < deadline {
            if await condition() { return }
            await Task.yield()
        }
        throw Failure.deadline
    }
}
