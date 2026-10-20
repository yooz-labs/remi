import Foundation
import Network

enum LocalDiscoveryOutcome: Sendable, Equatable {
    case completed, permissionDenied, unavailable, cancelled, noEligibleProfiles
}

enum LocalDiscoveryEvent: Sendable {
    /// Replaces the sweep's previous snapshot, including removed services.
    case candidates([LocalDiscoveryCandidate])
    case finished(LocalDiscoveryOutcome)
}

/// One bounded browse per instance, with actual Bonjour service resolution.
/// All mutable state and NetService run-loop callbacks belong to the main actor.
@MainActor
final class LocalMachineDiscovery {
    private var browser: NWBrowser?
    private var expiry: Task<Void, Never>?
    private var epoch = UUID()
    private var targets: [LocalDiscoveryTarget] = []
    private var services: [LocalDiscoveryService: String] = [:]
    private var pending: [LocalDiscoveryService] = []
    private var attempted: Set<LocalDiscoveryService> = []
    private var resolvers: [LocalDiscoveryService: LocalServiceResolution] = [:]
    private var resolved: [LocalDiscoveryService: [LocalDiscoveryCandidate]] = [:]
    private var handler: (@MainActor (LocalDiscoveryEvent) -> Void)?

    var isBrowsing: Bool { browser != nil }
    var retainedServiceCount: Int { services.count }
    var activeResolverCount: Int { resolvers.count }
    #if DEBUG
    private(set) var ownedDiscoveryObservation: [String] = []
    #endif

    func start(targets: [LocalDiscoveryTarget], handler: @escaping @MainActor (LocalDiscoveryEvent) -> Void) {
        cancel()
        let eligible = targets.filter { $0.preference == .automatic || $0.preference == .localOnly }
        guard !eligible.isEmpty else { handler(.finished(.noEligibleProfiles)); return }
        self.targets = eligible
        self.handler = handler
        #if DEBUG
        ownedDiscoveryObservation = []
        #endif
        let run = epoch
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_remi._tcp", domain: "local."), using: parameters)
        self.browser = browser
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self, self.epoch == run, self.browser != nil else { return }
                self.update(results)
            }
        }
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self, self.epoch == run, self.browser != nil else { return }
                switch state {
                case .waiting(let error), .failed(let error):
                    // Apple's TN3179: Bonjour policy denial is this DNS error.
                    if error == .dns(-65570) { self.finish(.permissionDenied) }
                    else if case .failed = state { self.finish(.unavailable) }
                default: break
                }
            }
        }
        browser.start(queue: .main)
        expiry = Task { [weak self] in
            do { try await Task.sleep(for: LocalDiscoveryLimits.browseWindow) } catch { return }
            guard let self, self.epoch == run else { return }
            self.finish(.completed)
        }
    }

    func cancel() {
        if handler != nil { finish(.cancelled) }
        else { clear() }
    }

    private func clear() {
        epoch = UUID()
        expiry?.cancel(); expiry = nil
        browser?.cancel(); browser = nil
        for resolver in resolvers.values { resolver.cancel() }
        resolvers.removeAll(); services.removeAll(); pending.removeAll()
        attempted.removeAll(); resolved.removeAll(); targets.removeAll()
    }

    private func finish(_ outcome: LocalDiscoveryOutcome) {
        let callback = handler
        handler = nil
        clear()
        callback?(.finished(outcome))
    }

    private func update(_ results: Set<NWBrowser.Result>) {
        let fingerprints = Set(targets.map(\.fingerprint))
        var matches: [(LocalDiscoveryService, String)] = []
        for result in results {
            #if DEBUG
            if case .bonjour(let txt) = result.metadata,
               fingerprints.contains(where: { txt.data.range(of: Data($0.utf8)) != nil }), ownedDiscoveryObservation.count < 32 {
                ownedDiscoveryObservation.append("\(result.endpoint) auth=\(String(describing: txt.getEntry(for: "auth"))) role=\(String(describing: txt.getEntry(for: "role")))")
            }
            #endif
            guard case .bonjour(let txt) = result.metadata,
                  txt["auth"] == "true", txt["role"] == "hub",
                  let fingerprint = txt["fingerprint"], Self.isCanonicalFingerprint(fingerprint),
                  fingerprints.contains(fingerprint),
                  case .service(let name, let type, let domain, _) = result.endpoint,
                  let service = LocalDiscoveryService(name: name, type: type, domain: domain) else { continue }
            matches.append((service, fingerprint))
        }
        matches.sort { $0.0.sortKey < $1.0.sortKey }
        var next: [LocalDiscoveryService: String] = [:]
        for (service, fingerprint) in matches where next.count < LocalDiscoveryLimits.services {
            next[service] = fingerprint
        }
        for service in Array(services.keys) where next[service] != services[service] {
            resolvers.removeValue(forKey: service)?.cancel()
            resolved[service] = nil
            attempted.remove(service)
        }
        services = next
        pending = next.keys.filter { !attempted.contains($0) }.sorted { $0.sortKey < $1.sortKey }
        publish()
        resolveNext()
    }

    static func isCanonicalFingerprint(_ value: String) -> Bool {
        value.utf8.count == 16 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private func resolveNext() {
        while resolvers.count < LocalDiscoveryLimits.resolvers, !pending.isEmpty {
            let service = pending.removeFirst()
            guard let fingerprint = services[service], !attempted.contains(service) else { continue }
            attempted.insert(service)
            let run = epoch
            let resolution = LocalServiceResolution(service: service) { [weak self] addresses, port, failure in
                guard let self, self.epoch == run, self.services[service] == fingerprint,
                      self.resolvers.removeValue(forKey: service) != nil else { return }
                var candidates: [LocalDiscoveryCandidate] = []
                for target in self.targets where target.fingerprint == fingerprint {
                    let retained = self.resolved.values.flatMap { $0 }.filter { $0.target.profileID == target.profileID }
                    var seen = Set(retained.map(\.id))
                    guard seen.count < LocalDiscoveryLimits.candidatesPerProfile else { continue }
                    for address in addresses {
                        guard let host = LocalDiscoveryAddress.numericHost(address, port: port) else { continue }
                        let candidate = LocalDiscoveryCandidate(target: target, service: service, host: host, port: port)
                        guard target.preference.permits(candidate.endpoint), seen.insert(candidate.id).inserted else { continue }
                        candidates.append(candidate)
                        if seen.count == LocalDiscoveryLimits.candidatesPerProfile { break }
                    }
                }
                self.resolved[service] = candidates
                #if DEBUG
                if self.ownedDiscoveryObservation.count < 32 {
                    self.ownedDiscoveryObservation.append("resolved port=\(port) addresses=\(addresses.count) accepted=\(candidates.count) failure=\(failure ?? "none")")
                }
                #endif
                self.publish()
                self.resolveNext()
            }
            resolvers[service] = resolution
            resolution.start()
        }
    }

    private func publish() {
        var counts: [String: Int] = [:]
        var seen: Set<String> = []
        var candidates: [LocalDiscoveryCandidate] = []
        for service in resolved.keys.sorted(by: { $0.sortKey < $1.sortKey }) {
            for candidate in resolved[service] ?? [] {
                let id = candidate.target.profileID
                guard counts[id, default: 0] < LocalDiscoveryLimits.candidatesPerProfile,
                      seen.insert(candidate.id).inserted else { continue }
                counts[id, default: 0] += 1
                candidates.append(candidate)
            }
        }
        handler?(.candidates(candidates))
    }
}

@MainActor
private final class LocalServiceResolution: NSObject, @preconcurrency NetServiceDelegate {
    let service: NetService
    private var completion: (@MainActor ([Data], Int, String?) -> Void)?
    private var timeout: Task<Void, Never>?

    init(service: LocalDiscoveryService, completion: @escaping @MainActor ([Data], Int, String?) -> Void) {
        self.service = NetService(domain: service.domain, type: service.type, name: service.name)
        self.completion = completion
    }

    func start() {
        service.delegate = self
        service.schedule(in: .main, forMode: .common)
        service.resolve(withTimeout: LocalDiscoveryLimits.resolutionTimeout)
        timeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(LocalDiscoveryLimits.resolutionTimeout)) } catch { return }
            self?.finish(addresses: [], port: 0, failure: "resolution deadline")
        }
    }

    func cancel() {
        completion = nil
        timeout?.cancel(); timeout = nil
        service.stop(); service.delegate = nil
        service.remove(from: .main, forMode: .common)
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        finish(addresses: sender.addresses ?? [], port: sender.port)
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        let failure = errorDict.keys.sorted().map { "\($0)=\(errorDict[$0]?.stringValue ?? "unknown")" }.joined(separator: ",")
        finish(addresses: [], port: 0, failure: failure)
    }

    private func finish(addresses: [Data], port: Int, failure: String? = nil) {
        let callback = completion
        cancel()
        callback?(addresses, port, failure)
    }
}
