import Foundation
import NativeAPNsRuntime

/// #1200: exact public runtime entitlement queries. Each attempt owns both
/// queries and one two-second deadline; context loss never installs a result.
@MainActor
final class NativeAPNsEnvironment {
    enum Match: Equatable, Sendable { case match, mismatch, unavailable }
    enum Outcome: Equatable { case production, sandbox, unavailable }
    typealias Cancel = () -> Void
    typealias Query = (Bool, @escaping (Match) -> Void) -> Cancel

    private let query: Query
    private var active: Attempt?

    private final class Attempt {
        let id: UUID
        let stillCurrent: @MainActor () -> Bool
        let continuation: CheckedContinuation<Outcome, Never>
        var results: [Bool: Match] = [:]
        var leases: [Cancel] = []
        var timeout: Task<Void, Never>?

        init(id: UUID, stillCurrent: @escaping @MainActor () -> Bool,
             continuation: CheckedContinuation<Outcome, Never>) {
            self.id = id; self.stillCurrent = stillCurrent; self.continuation = continuation
        }
    }

    init(query: @escaping Query = { production, completion in
        RemiQueryAPNsValue(production) { raw in
            completion(raw == 1 ? .match : raw == 0 ? .mismatch : .unavailable)
        }
    }) {
        self.query = query
    }

    func resolve(stillCurrent: @escaping @MainActor () -> Bool) async -> Outcome {
        cancel()
        guard stillCurrent(), !Task.isCancelled else { return .unavailable }
        let id = UUID()
        return await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { continuation in
                guard stillCurrent(), !Task.isCancelled else {
                    continuation.resume(returning: .unavailable)
                    return
                }
                let attempt = Attempt(id: id, stillCurrent: stillCurrent, continuation: continuation)
                active = attempt
                attempt.timeout = Task { @MainActor [weak self] in
                    do { try await Task.sleep(nanoseconds: 2_000_000_000) }
                    catch { return }
                    self?.finish(id: id, result: .unavailable)
                }
                for production in [true, false] {
                    attempt.leases.append(query(production) { [weak self] match in
                        Task { @MainActor [weak self] in self?.received(match, production: production, id: id) }
                    })
                }
            }
        }, onCancel: { [weak self] in
            Task { @MainActor [weak self] in self?.finish(id: id, result: .unavailable) }
        })
    }

    func cancel() {
        if let active { finish(id: active.id, result: .unavailable) }
    }

    private func received(_ match: Match, production: Bool, id: UUID) {
        guard let active, active.id == id else { return }
        guard active.stillCurrent(), active.results[production] == nil, match != .unavailable else {
            finish(id: id, result: .unavailable)
            return
        }
        active.results[production] = match
        guard let prod = active.results[true], let development = active.results[false] else { return }
        let result: Outcome = prod == .match && development == .mismatch ? .production :
            prod == .mismatch && development == .match ? .sandbox : .unavailable
        finish(id: id, result: result)
    }

    private func finish(id: UUID, result: Outcome) {
        guard let attempt = active, attempt.id == id else { return }
        active = nil
        attempt.timeout?.cancel()
        for cancel in attempt.leases { cancel() }
        attempt.continuation.resume(returning: attempt.stillCurrent() ? result : .unavailable)
    }
}
