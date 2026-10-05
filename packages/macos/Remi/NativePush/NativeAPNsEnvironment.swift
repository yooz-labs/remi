import Foundation

/// #1200: constructor scaffolding only. Until the bounded public OS query is
/// installed, secure setup is unavailable; no guessed environment is returned.
@MainActor
final class NativeAPNsEnvironment {
    enum Match { case match, mismatch, unavailable }
    enum Outcome: Equatable { case production, sandbox, unavailable }
    typealias Cancel = () -> Void
    typealias Query = (Bool, @escaping (Match) -> Void) -> Cancel

    private let query: Query

    init(query: @escaping Query = { _, completion in
        completion(.unavailable)
        return {}
    }) {
        self.query = query
    }

    func resolve(stillCurrent: @escaping @MainActor () -> Bool = { NativeForegroundUnlock.isActive() }) async -> Outcome {
        .unavailable
    }
}
