import Foundation

/// The client side of one read-only terminal view (ADR 0047) as a pure value: no sockets, no
/// timers, no clock reads. A caller feeds it the person's intents and the host's messages with
/// the current time, and sends the actions it returns (it builds each frame from the action's
/// request id and its own header fields).
///
/// The rules:
/// - one request is outstanding at a time; a response is accepted only for the session this
///   controller was made for and the request it is waiting on, so a late or foreign frame is
///   ignored;
/// - the first read after `opened` has `afterRevision` nil; each later read names the revision
///   of the screen on view. `unchanged` keeps the screen, a newer `snapshot` replaces it, and an
///   older one is dropped. The next read goes out `readInterval` seconds after a response;
/// - a view is a lease. When its `expiresAt` passes (the injected clock) or the host refuses a
///   read as `expired`, the controller reopens once; a second expiry, or the first one when the
///   reopen itself is refused, gives up as `.expired`. The person's own `open` starts afresh;
/// - leaving closes the view. A view whose `opened` arrives after the person left is closed at once;
/// - a live view is also closed, best effort, when the response timeout ends it, when the client
///   clock ends its lease before a reopen, and on `interrupt()`. A dropped connection sends no
///   close: the frame cannot go out, and the host retires a view with its connection (ADR 0047);
///   the same holds when the store has no route to send on. A host `expired` refusal sends none
///   either, because the host has already ended that view;
/// - there is no operation for input or resize: a terminal view only reads (ADR 0046).
///
/// The client's clock grants no authority: the host's `expired` refusal is the truth, and the
/// clock only lets the app reopen before asking would fail.
public struct TerminalViewController: Sendable, Equatable {
    /// Seconds between a response and the next read.
    public static let readInterval: TimeInterval = 1
    /// Seconds to wait for a response before the view counts as interrupted.
    public static let responseTimeout: TimeInterval = 15

    public enum State: Sendable, Equatable {
        case closed
        case opening
        /// `revision` is nil until the first snapshot arrives.
        case open(viewId: String, revision: Int?)
        case refused(TerminalViewRefusalCode)
        /// The lease ended and the one reopen was used.
        case expired
        /// The connection dropped or the host stopped answering.
        case interrupted
    }

    public enum Event: Sendable, Equatable {
        /// The person opened the pane, or asked to try again.
        case open
        /// The person left the pane.
        case leave
        /// Time passed with nothing received.
        case tick
        case disconnected
        case message(TerminalViewMessage)
    }

    /// What the caller must send. `requestId` becomes the frame's `id`.
    public enum Action: Sendable, Equatable {
        case open(requestId: String)
        case read(requestId: String, viewId: String, afterRevision: Int?)
        case close(requestId: String, viewId: String)
    }

    private struct Pending: Sendable, Equatable {
        let id: String
        let operation: TerminalViewOperation
        let sentAt: TimeInterval
    }

    public let sessionId: String
    public private(set) var state: State = .closed
    /// The latest screen, kept while the view is open, expired or interrupted so the person
    /// still sees what was last read; cleared when a view is started or refused.
    public private(set) var screen: SessionTerminalSnapshot?

    private let makeRequestId: @Sendable () -> String
    private var pending: Pending?
    private var expiresAt: Date?
    private var nextReadAt: TimeInterval = 0
    private var reopensLeft = 1
    /// An open the person left before it was answered; its view must be closed on arrival.
    private var abandonedOpenId: String?

    /// `now` below is seconds on any monotonic scale for cadence; `date` is the wall clock used
    /// only against `expiresAt`.
    public init(
        sessionId: String,
        makeRequestId: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.sessionId = sessionId
        self.makeRequestId = makeRequestId
    }

    public static func == (left: Self, right: Self) -> Bool {
        left.sessionId == right.sessionId && left.state == right.state && left.screen == right.screen
            && left.pending == right.pending && left.expiresAt == right.expiresAt
            && left.nextReadAt == right.nextReadAt && left.reopensLeft == right.reopensLeft
            && left.abandonedOpenId == right.abandonedOpenId
    }

    public var isActive: Bool {
        switch state {
        case .opening, .open: true
        default: false
        }
    }

    /// `now`: monotonic seconds, for cadence and response timeouts. `date`: the wall clock, for the lease.
    public mutating func handle(_ event: Event, now: TimeInterval, date: Date) -> [Action] {
        switch event {
        case .open:
            guard !isActive else { return [] }
            screen = nil
            reopensLeft = 1
            return beginOpen(now: now)
        case .leave:
            return leave()
        case .disconnected:
            // The connection is gone, so no close can be sent; the host retires the view with it.
            pending = nil
            abandonedOpenId = nil
            if isActive { state = .interrupted }
            return []
        case .tick:
            return advance(now: now, date: date)
        case .message(let message):
            if let actions = advanceIfDue(now: now, date: date) { return actions }
            return receive(message, now: now, date: date)
        }
    }

    /// A frame could not be sent. Returns a best-effort close for a live view, which the caller
    /// may try once; it is never retried, because the state is no longer open.
    /// The connection is gone: no close is possible, and the host retires the view with it.
    public mutating func markDisconnected() { _ = handle(.disconnected, now: 0, date: Date(timeIntervalSince1970: 0)) }

    @discardableResult
    public mutating func interrupt() -> [Action] {
        let close = liveViewClose()
        pending = nil
        abandonedOpenId = nil
        if isActive { state = .interrupted }
        return close
    }

    private mutating func liveViewClose() -> [Action] {
        guard case .open(let viewId, _) = state else { return [] }
        return [.close(requestId: makeRequestId(), viewId: viewId)]
    }

    // MARK: Time

    private mutating func advance(now: TimeInterval, date: Date) -> [Action] {
        if let actions = advanceIfDue(now: now, date: date) { return actions }
        guard case .open(let viewId, let revision) = state, pending == nil, now >= nextReadAt else { return [] }
        return [sendRead(viewId: viewId, after: revision, now: now)]
    }

    /// Ends the view if its lease or the wait for a response ran out; nil when neither did.
    private mutating func advanceIfDue(now: TimeInterval, date: Date) -> [Action]? {
        if let pending, now - pending.sentAt >= Self.responseTimeout {
            let close = liveViewClose()
            self.pending = nil
            if isActive { state = .interrupted }
            return close
        }
        if case .open = state, let expiresAt, date >= expiresAt { return leaseEnded(now: now, closeFirst: true) }
        return nil
    }

    /// `closeFirst`: the client's clock ended the lease, so the host may still hold the view and is
    /// told to drop it. After a host `expired` refusal it is already gone.
    private mutating func leaseEnded(now: TimeInterval, closeFirst: Bool) -> [Action] {
        let close = closeFirst ? liveViewClose() : []
        pending = nil
        expiresAt = nil
        guard reopensLeft > 0 else {
            state = .expired
            return close
        }
        reopensLeft -= 1
        return close + beginOpen(now: now)
    }

    // MARK: Intents

    private mutating func beginOpen(now: TimeInterval) -> [Action] {
        let id = makeRequestId()
        pending = Pending(id: id, operation: .open, sentAt: now)
        expiresAt = nil
        state = .opening
        return [.open(requestId: id)]
    }

    private mutating func sendRead(viewId: String, after revision: Int?, now: TimeInterval) -> Action {
        let id = makeRequestId()
        pending = Pending(id: id, operation: .read, sentAt: now)
        return .read(requestId: id, viewId: viewId, afterRevision: revision)
    }

    private mutating func leave() -> [Action] {
        defer {
            pending = nil
            expiresAt = nil
            screen = nil  // nothing from the terminal lingers once the person has left
        }
        switch state {
        case .open(let viewId, _):
            state = .closed
            return [.close(requestId: makeRequestId(), viewId: viewId)]
        case .opening:
            abandonedOpenId = pending?.id
            state = .closed
            return []
        default:
            state = .closed
            return []
        }
    }

    // MARK: Host messages

    private mutating func receive(_ message: TerminalViewMessage, now: TimeInterval, date: Date) -> [Action] {
        switch message {
        case .opened(let opened):
            guard WireGuards.same(opened.header.sessionId, sessionId) else { return [] }
            if let abandoned = abandonedOpenId, WireGuards.same(opened.requestId, abandoned) {
                abandonedOpenId = nil
                return [.close(requestId: makeRequestId(), viewId: opened.viewId)]
            }
            guard state == .opening, answers(opened.requestId, .open) else { return [] }
            pending = nil
            expiresAt = WireTimestamp.date(from: opened.expiresAt)
            state = .open(viewId: opened.viewId, revision: nil)
            return [sendRead(viewId: opened.viewId, after: nil, now: now)]

        case .snapshot(let snapshot):
            guard WireGuards.same(snapshot.header.sessionId, sessionId),
                case .open(let viewId, let revision) = state, WireGuards.same(snapshot.viewId, viewId),
                answers(snapshot.requestId, .read)
            else { return [] }
            pending = nil
            nextReadAt = now + Self.readInterval
            if revision.map({ snapshot.revision > $0 }) ?? true {
                screen = snapshot
                state = .open(viewId: viewId, revision: snapshot.revision)
            }
            return []

        case .unchanged(let unchanged):
            guard WireGuards.same(unchanged.header.sessionId, sessionId),
                case .open(let viewId, _) = state, WireGuards.same(unchanged.viewId, viewId),
                answers(unchanged.requestId, .read)
            else { return [] }
            pending = nil
            nextReadAt = now + Self.readInterval
            return []

        case .refused(let refused):
            guard WireGuards.same(refused.header.sessionId, sessionId) else { return [] }
            return refusal(refused, now: now)

        case .closed, .open, .read, .close:
            // A close answer needs nothing; client-direction frames are never answers.
            return []
        }
    }

    private mutating func refusal(_ refused: SessionTerminalRefused, now: TimeInterval) -> [Action] {
        if let abandoned = abandonedOpenId, WireGuards.same(refused.requestId, abandoned) {
            abandonedOpenId = nil
            return []
        }
        guard let pending, WireGuards.same(refused.requestId, pending.id), refused.operation == pending.operation
        else { return [] }
        self.pending = nil
        expiresAt = nil
        switch (refused.operation, refused.code) {
        case (.read, .expired):
            return leaseEnded(now: now, closeFirst: false)
        case (.open, .expired):
            // A reopen that is refused as expired has nothing left to try.
            state = .expired
            return []
        default:
            screen = nil
            state = .refused(refused.code)
            return []
        }
    }

    private func answers(_ requestId: String, _ operation: TerminalViewOperation) -> Bool {
        guard let pending else { return false }
        return pending.operation == operation && WireGuards.same(pending.id, requestId)
    }

    // MARK: Text for the person

    /// Plain copy for a refusal. None says who is at fault beyond what the code states.
    public static func refusalText(_ code: TerminalViewRefusalCode) -> String {
        switch code {
        case .malformed:
            "This app asked in a way the machine could not read. Update this app and the remi on that machine."
        case .unavailable:
            "The terminal of this session cannot be shown right now. It may not have been captured from the start."
        case .busy:
            "The machine is already showing as many terminals as it allows. Try again in a moment."
        case .expired:
            "The terminal view timed out. Open it again."
        case .bindingChanged:
            "This session now belongs to a different conversation. Leave the terminal and open it again."
        case .unsupportedScreen:
            "The screen uses features this read-only view cannot show safely, so it is not shown."
        }
    }

    /// One line for the state, or nil while open with a screen on view.
    public var statusText: String? {
        switch state {
        case .closed: nil
        case .opening: "Opening the terminal"
        case .open(_, let revision): revision == nil ? "Reading the screen" : nil
        case .refused(let code): Self.refusalText(code)
        case .expired: "The terminal view timed out and could not be reopened."
        case .interrupted: "The terminal view lost its connection."
        }
    }
}
