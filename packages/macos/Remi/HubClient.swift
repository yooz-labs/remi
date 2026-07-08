//
//  HubClient.swift
//  Remi
//
//  Attach-only hub monitor (#649). Discovers the local remi hub by probing
//  the daemon port range over HTTP (`/auth-info`, mirroring the web client's
//  port-discovery semantics), holds a query-mode WebSocket to it, and
//  publishes the `hub_status` census for the menu bar.
//
//  The app is sandboxed (App Sandbox + network.client only): it can never
//  spawn `remi` or read ~/.remi, so scanning localhost ports is the ONLY
//  discovery channel. See docs/MACOS_APP.md.
//
//  Hub race note (#649 plan, risk 3): a legacy single-session daemon can
//  hold the preferred port while the hub sits higher in the range. Whatever
//  answers first still works as the web UI's seed connection, but only a
//  session-less peer (hello_ack.sessionId == nil) counts as a hub; while the
//  current peer is not a hub, a slow background rescan keeps looking for one
//  to promote to.
//

import Foundation

@MainActor
final class HubClient: ObservableObject {
    /// Daemon port range: DAEMON_BASE_PORT 18765, 20-port probe
    /// (packages/shared/src/daemon-ports.ts). `nonisolated` so the
    /// nonisolated scan helpers can read them (immutable, Sendable).
    nonisolated static let basePort = 18765
    nonisolated static let portRange = 20

    enum Phase: Equatable {
        case scanning
        case connected(port: Int, isHub: Bool)
        case unreachable
    }

    @Published private(set) var phase: Phase = .scanning
    @Published private(set) var localClients = 0
    @Published private(set) var remoteClients = 0
    @Published private(set) var sessions = 0
    @Published private(set) var hubVersion: String?

    var iconState: IconState {
        switch phase {
        case .connected(_, isHub: true):
            return IconState.derive(
                reachable: true, localClients: localClients, remoteClients: remoteClients)
        default:
            return .unreachable
        }
    }

    /// The URL the embedded web UI should connect to, e.g. ws://127.0.0.1:18765.
    var hubURL: String? {
        guard case let .connected(port, _) = phase else { return nil }
        return "ws://127.0.0.1:\(port)"
    }

    var menuStatusLine: String {
        switch phase {
        case .scanning:
            return "Hub: looking…"
        case .unreachable:
            return "Hub: not running"
        case let .connected(port, isHub):
            guard isHub else { return "Session daemon on \(port) (no hub)" }
            let sessionsPart = sessions == 1 ? "1 session" : "\(sessions) sessions"
            return "Hub: running on \(port) · \(sessionsPart)"
        }
    }

    private var task: URLSessionWebSocketTask?
    private var pingTimer: Timer?
    private var rescanTimer: Timer?
    private var missedPongs = 0
    private var consecutiveFailures = 0
    private var reconnectDelay: TimeInterval = 1
    private var started = false

    /// Stable client id, persisted so the daemon sees one device (#662).
    private let clientId: String = {
        let key = "remi.clientId"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let fresh = UUID().uuidString.lowercased()
        UserDefaults.standard.set(fresh, forKey: key)
        return fresh
    }()

    private let clientVersion =
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"

    func start() {
        guard !started else { return }
        started = true
        Task { await scanAndConnect() }
    }

    // MARK: - Discovery

    /// Probe every port in the daemon range in parallel; hub (session-less)
    /// responders win over session daemons; lowest port breaks ties.
    private func scanAndConnect(preferring hintPort: Int? = nil) async {
        phase = .scanning
        let ports = Self.scanOrder(hintPort: hintPort)
        let responders = await Self.probe(ports: ports)
        guard let port = responders.first else {
            phase = .unreachable
            scheduleReconnect()
            return
        }
        connect(to: port)
    }

    /// Hint port (last known hub) first, then the rest of the range.
    nonisolated static func scanOrder(hintPort: Int?) -> [Int] {
        let range = Array(basePort..<(basePort + portRange))
        guard let hint = hintPort, range.contains(hint) else { return range }
        return [hint] + range.filter { $0 != hint }
    }

    /// HTTP-probe `/auth-info` on each port (1.5 s timeout, mirroring the web
    /// client's port discovery); returns responding ports in ascending order.
    nonisolated static func probe(ports: [Int]) async -> [Int] {
        await withTaskGroup(of: Int?.self) { group in
            for port in ports {
                group.addTask {
                    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/auth-info")!)
                    request.timeoutInterval = 1.5
                    do {
                        let (_, response) = try await URLSession.shared.data(for: request)
                        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                            return nil
                        }
                        return port
                    } catch {
                        return nil
                    }
                }
            }
            var found: [Int] = []
            for await port in group {
                if let port { found.append(port) }
            }
            return found.sorted()
        }
    }

    // MARK: - Connection

    private func connect(to port: Int) {
        let url = URL(string: "ws://127.0.0.1:\(port)/ws")!
        let task = URLSession.shared.webSocketTask(with: url)
        self.task = task
        task.resume()

        sendJSON(HelloFrame(clientVersion: clientVersion, clientId: clientId))
        receiveLoop(task: task, port: port)
    }

    private func receiveLoop(task: URLSessionWebSocketTask, port: Int) {
        task.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, self.task === task else { return }
                switch result {
                case let .success(message):
                    if case let .string(text) = message {
                        self.handleFrame(text, port: port)
                    }
                    self.receiveLoop(task: task, port: port)
                case .failure:
                    self.handleDisconnect()
                }
            }
        }
    }

    private func handleFrame(_ text: String, port: Int) {
        guard let data = text.data(using: .utf8),
            let envelope = try? JSONDecoder().decode(IncomingFrameType.self, from: data)
        else { return }

        switch envelope.type {
        case "hello_ack":
            // Explicit-null detection: JSONDecoder cannot distinguish absent
            // from null through `String?`, and the hub/session distinction
            // hangs on exactly that (#542). Absent => treat as session peer.
            let isHub = Self.helloAckHasNullSessionId(data)
            phase = .connected(port: port, isHub: isHub)
            consecutiveFailures = 0
            reconnectDelay = 1
            startPingTimer()
            if !isHub {
                // A session daemon answered; keep looking for a real hub in
                // the background (60 s cadence) and promote when one appears.
                startBackgroundRescan()
            } else {
                stopBackgroundRescan()
            }
        case "hub_status":
            if let status = try? JSONDecoder().decode(HubStatusFrame.self, from: data) {
                localClients = status.localClients
                remoteClients = status.remoteClients
                sessions = status.sessions
                hubVersion = status.hubVersion
            }
        case "pong":
            missedPongs = 0
        default:
            break
        }
    }

    /// True only when the ack carries a LITERAL `"sessionId": null`.
    nonisolated static func helloAckHasNullSessionId(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let value = object["sessionId"]
        else { return false }
        return value is NSNull
    }

    // MARK: - Liveness + reconnect

    private func startPingTimer() {
        pingTimer?.invalidate()
        missedPongs = 0
        pingTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.missedPongs += 1
                if self.missedPongs > 2 {
                    self.handleDisconnect()
                } else {
                    self.sendJSON(PingFrame())
                }
            }
        }
    }

    private func handleDisconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        pingTimer?.invalidate()
        pingTimer = nil
        localClients = 0
        remoteClients = 0
        sessions = 0
        phase = .unreachable
        consecutiveFailures += 1
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 30)
        // After 3 straight failures do a full range rescan; before that,
        // retry with the last known port first.
        let hint: Int? = consecutiveFailures < 3 ? lastKnownPort : nil
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            await self?.scanAndConnect(preferring: hint)
        }
    }

    private var lastKnownPort: Int? {
        if case let .connected(port, _) = phase { return port }
        return nil
    }

    private func startBackgroundRescan() {
        stopBackgroundRescan()
        rescanTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                // Only meaningful while attached to a non-hub peer.
                guard case .connected(_, isHub: false) = self.phase else {
                    self.stopBackgroundRescan()
                    return
                }
                let responders = await Self.probe(ports: Self.scanOrder(hintPort: nil))
                // Reconnect from scratch if anything else responds; the
                // hello_ack will tell us whether we found a real hub.
                if let candidate = responders.first, candidate != self.lastKnownPort {
                    self.task?.cancel(with: .goingAway, reason: nil)
                    self.task = nil
                    self.pingTimer?.invalidate()
                    self.connect(to: candidate)
                }
            }
        }
    }

    private func stopBackgroundRescan() {
        rescanTimer?.invalidate()
        rescanTimer = nil
    }

    private func sendJSON<T: Encodable>(_ frame: T) {
        guard let task, let data = try? JSONEncoder().encode(frame),
            let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { _ in }
    }
}
