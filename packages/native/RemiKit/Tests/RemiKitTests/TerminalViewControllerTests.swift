import Foundation
import Testing
@testable import RemiKit

/// The controller against the real golden `session_terminal_*` frames and its own sequences.
/// The fixtures fix `sessionId` and `requestId`, so a fixed id source makes them answers.
struct TerminalViewControllerTests {
    static let session = "00000000-0000-4000-8000-000000000003"
    static let fixedRequest = "00000000-0000-4000-8000-000000000002"
    static let view = "AAECAwQFBgcICQoLDA0ODw"
    static let leaseEnd = Date(timeIntervalSince1970: 1_792_627_500)  // 2026-10-22T00:05:00Z
    static let beforeLease = Date(timeIntervalSince1970: 1_792_627_200)

    static func frame(
        _ name: String, requestId: String = fixedRequest, _ edits: [String: String] = [:]
    ) throws -> TerminalViewMessage {
        var text = String(decoding: try FixtureConformanceTests.fixture(name), as: UTF8.self)
        text = text.replacingOccurrences(of: fixedRequest, with: requestId)
        for (from, to) in edits { text = text.replacingOccurrences(of: from, with: to) }
        return try TerminalViewMessage.decode(text)
    }

    static func controller() -> TerminalViewController {
        TerminalViewController(sessionId: session, makeRequestId: { fixedRequest })
    }

    /// A controller driven to `open` with the golden opened and snapshot frames.
    static func opened() throws -> TerminalViewController {
        var c = controller()
        _ = c.handle(.open, now: 0, date: beforeLease)
        _ = c.handle(.message(try frame("session_terminal_opened")), now: 0, date: beforeLease)
        _ = c.handle(.message(try frame("session_terminal_snapshot")), now: 0, date: beforeLease)
        return c
    }

    @Test func openingSendsOneOpenAndOpenedStartsTheFirstRead() throws {
        var c = Self.controller()
        #expect(c.handle(.open, now: 0, date: Self.beforeLease) == [.open(requestId: Self.fixedRequest)])
        #expect(c.state == .opening)
        #expect(c.statusText == "Opening the terminal")
        let actions = c.handle(.message(try Self.frame("session_terminal_opened")), now: 0, date: Self.beforeLease)
        #expect(actions == [.read(requestId: Self.fixedRequest, viewId: Self.view, afterRevision: nil)])
        #expect(c.state == .open(viewId: Self.view, revision: nil))
    }

    @Test func snapshotKeepsTheScreenAndNamesItsRevisionInTheNextRead() throws {
        var c = try Self.opened()
        #expect(c.state == .open(viewId: Self.view, revision: 0))
        #expect(c.screen?.lines == ["owned", "界é", "", ""])
        #expect(c.screen?.cursor == TerminalCursor(row: 1, column: 3))
        #expect(c.statusText == nil)
        // The cadence is a rule: nothing before the interval, one read after it.
        #expect(c.handle(.tick, now: 0.5, date: Self.beforeLease).isEmpty)
        #expect(
            c.handle(.tick, now: 1, date: Self.beforeLease)
                == [.read(requestId: Self.fixedRequest, viewId: Self.view, afterRevision: 0)])
        // One request at a time: no second read while the first is outstanding.
        #expect(c.handle(.tick, now: 2, date: Self.beforeLease).isEmpty)
    }

    @Test func unchangedKeepsTheScreenAndRevision() throws {
        var c = try Self.opened()
        _ = c.handle(.tick, now: 1, date: Self.beforeLease)
        _ = c.handle(.message(try Self.frame("session_terminal_unchanged")), now: 1, date: Self.beforeLease)
        #expect(c.state == .open(viewId: Self.view, revision: 0))
        #expect(c.screen?.revision == 0)
        #expect(c.handle(.tick, now: 1.5, date: Self.beforeLease).isEmpty)
        #expect(c.handle(.tick, now: 2, date: Self.beforeLease).count == 1)
    }

    @Test func newerSnapshotReplacesAndOlderIsDropped() throws {
        var c = try Self.opened()
        _ = c.handle(.tick, now: 1, date: Self.beforeLease)
        let newer = try Self.frame("session_terminal_snapshot", ["\"revision\": 0": "\"revision\": 5"])
        _ = c.handle(.message(newer), now: 1, date: Self.beforeLease)
        #expect(c.state == .open(viewId: Self.view, revision: 5))
        _ = c.handle(.tick, now: 2, date: Self.beforeLease)
        let older = try Self.frame("session_terminal_snapshot", ["\"revision\": 0": "\"revision\": 3"])
        _ = c.handle(.message(older), now: 2, date: Self.beforeLease)
        #expect(c.screen?.revision == 5)
        #expect(c.state == .open(viewId: Self.view, revision: 5))
    }

    @Test func foreignAndStaleFramesAreIgnored() throws {
        var c = Self.controller()
        _ = c.handle(.open, now: 0, date: Self.beforeLease)
        let otherSession = try Self.frame(
            "session_terminal_opened", ["0000-4000-8000-000000000003": "0000-4000-8000-000000000009"])
        #expect(c.handle(.message(otherSession), now: 0, date: Self.beforeLease).isEmpty)
        let otherRequest = try Self.frame("session_terminal_opened", requestId: "00000000-0000-4000-8000-0000000000aa")
        #expect(c.handle(.message(otherRequest), now: 0, date: Self.beforeLease).isEmpty)
        #expect(c.state == .opening)
        // A snapshot cannot answer an open.
        #expect(c.handle(.message(try Self.frame("session_terminal_snapshot")), now: 0, date: Self.beforeLease).isEmpty)
        #expect(c.state == .opening)
    }

    @Test func snapshotForAnotherViewIsIgnored() throws {
        var c = try Self.opened()
        _ = c.handle(.tick, now: 1, date: Self.beforeLease)
        let other = try Self.frame(
            "session_terminal_snapshot", ["\"revision\": 0": "\"revision\": 9", Self.view: "BAECAwQFBgcICQoLDA0ODw"])
        _ = c.handle(.message(other), now: 1, date: Self.beforeLease)
        #expect(c.screen?.revision == 0)
    }

    @Test(arguments: TerminalViewRefusalCode.allCases.filter { $0 != .expired })
    func everyOpenRefusalEndsInRefusedWithPlainText(code: TerminalViewRefusalCode) throws {
        var c = Self.controller()
        _ = c.handle(.open, now: 0, date: Self.beforeLease)
        let refusal = try Self.frame(
            "session_terminal_refused",
            ["session_terminal_read": "session_terminal_open", "\"unavailable\"": "\"\(code.rawValue)\""])
        #expect(c.handle(.message(refusal), now: 0, date: Self.beforeLease).isEmpty)
        #expect(c.state == .refused(code))
        #expect(c.screen == nil)
        let text = try #require(c.statusText)
        #expect(text == TerminalViewController.refusalText(code))
        #expect(!text.isEmpty && !text.contains("—") && !text.contains("_"))
    }

    @Test func allSixRefusalTextsAreDistinct() {
        let texts = TerminalViewRefusalCode.allCases.map(TerminalViewController.refusalText)
        #expect(texts.count == 6)
        #expect(Set(texts).count == 6)
    }

    @Test func bindingChangedOnReadEndsTheViewAndDropsTheScreen() throws {
        var c = try Self.opened()
        _ = c.handle(.tick, now: 1, date: Self.beforeLease)
        let refusal = try Self.frame("session_terminal_refused", ["\"unavailable\"": "\"binding_changed\""])
        _ = c.handle(.message(refusal), now: 1, date: Self.beforeLease)
        #expect(c.state == .refused(.bindingChanged))
        #expect(c.screen == nil)
        #expect(c.handle(.tick, now: 5, date: Self.beforeLease).isEmpty)  // no further reads
    }

    @Test func refusalOfAnotherOperationIsIgnored() throws {
        var c = Self.controller()
        _ = c.handle(.open, now: 0, date: Self.beforeLease)
        // The golden refusal answers a read; the controller waits on an open.
        _ = c.handle(.message(try Self.frame("session_terminal_refused")), now: 0, date: Self.beforeLease)
        #expect(c.state == .opening)
    }

    @Test func leaseExpiryReopensOnceThenGivesUp() throws {
        var c = try Self.opened()
        // Lease over: the next event reopens.
        #expect(c.handle(.tick, now: 2, date: Self.leaseEnd) == [.open(requestId: Self.fixedRequest)])
        #expect(c.state == .opening)
        _ = c.handle(.message(try Self.frame("session_terminal_opened")), now: 2, date: Self.beforeLease)
        _ = c.handle(.message(try Self.frame("session_terminal_snapshot")), now: 2, date: Self.beforeLease)
        // Expires again: no second reopen.
        #expect(c.handle(.tick, now: 4, date: Self.leaseEnd).isEmpty)
        #expect(c.state == .expired)
        #expect(c.statusText == "The terminal view timed out and could not be reopened.")
        #expect(c.screen != nil)  // the last screen stays on view, labeled by the state
        #expect(c.handle(.tick, now: 9, date: Self.leaseEnd).isEmpty)
    }

    @Test func hostExpiredRefusalOnReadReopensOnce() throws {
        var c = try Self.opened()
        _ = c.handle(.tick, now: 1, date: Self.beforeLease)
        let expired = try Self.frame("session_terminal_refused", ["\"unavailable\"": "\"expired\""])
        #expect(c.handle(.message(expired), now: 1, date: Self.beforeLease) == [.open(requestId: Self.fixedRequest)])
        _ = c.handle(.message(try Self.frame("session_terminal_opened")), now: 1, date: Self.beforeLease)
        _ = c.handle(.tick, now: 3, date: Self.beforeLease)
        _ = c.handle(.message(expired), now: 3, date: Self.beforeLease)
        #expect(c.state == .expired)
    }

    @Test func personsOpenAfterExpiryStartsAfresh() throws {
        var c = try Self.opened()
        _ = c.handle(.tick, now: 2, date: Self.leaseEnd)
        _ = c.handle(.message(try Self.frame("session_terminal_opened")), now: 2, date: Self.beforeLease)
        _ = c.handle(.tick, now: 4, date: Self.leaseEnd)
        #expect(c.state == .expired)
        #expect(c.handle(.open, now: 10, date: Self.beforeLease) == [.open(requestId: Self.fixedRequest)])
        #expect(c.state == .opening)
        #expect(c.screen == nil)
    }

    @Test func leavingAnOpenViewClosesIt() throws {
        var c = try Self.opened()
        #expect(c.handle(.leave, now: 3, date: Self.beforeLease) == [.close(requestId: Self.fixedRequest, viewId: Self.view)])
        #expect(c.state == .closed)
        // A late snapshot after leaving changes nothing and asks for nothing.
        #expect(c.handle(.message(try Self.frame("session_terminal_snapshot")), now: 3, date: Self.beforeLease).isEmpty)
        #expect(c.handle(.tick, now: 9, date: Self.beforeLease).isEmpty)
    }

    @Test func leavingBeforeOpenedClosesTheViewWhenItArrives() throws {
        var c = Self.controller()
        _ = c.handle(.open, now: 0, date: Self.beforeLease)
        #expect(c.handle(.leave, now: 0.1, date: Self.beforeLease).isEmpty)
        #expect(c.state == .closed)
        let actions = c.handle(.message(try Self.frame("session_terminal_opened")), now: 0.2, date: Self.beforeLease)
        #expect(actions == [.close(requestId: Self.fixedRequest, viewId: Self.view)])
        #expect(c.state == .closed)
    }

    @Test func leavingWhenClosedDoesNothing() {
        var c = Self.controller()
        #expect(c.handle(.leave, now: 0, date: Self.beforeLease).isEmpty)
    }

    @Test func disconnectInterruptsAndNoReadFollows() throws {
        var c = try Self.opened()
        #expect(c.handle(.disconnected, now: 1, date: Self.beforeLease).isEmpty)
        #expect(c.state == .interrupted)
        #expect(c.handle(.tick, now: 9, date: Self.beforeLease).isEmpty)
        #expect(c.handle(.open, now: 10, date: Self.beforeLease).count == 1)  // the person may try again
    }

    @Test func silentHostInterruptsAfterTheResponseTimeout() throws {
        var c = Self.controller()
        _ = c.handle(.open, now: 0, date: Self.beforeLease)
        #expect(c.handle(.tick, now: 14, date: Self.beforeLease).isEmpty)
        #expect(c.state == .opening)
        _ = c.handle(.tick, now: 15, date: Self.beforeLease)
        #expect(c.state == .interrupted)
    }

    @Test func openWhileActiveIsIgnored() throws {
        var c = try Self.opened()
        #expect(c.handle(.open, now: 1, date: Self.beforeLease).isEmpty)
        #expect(c.state == .open(viewId: Self.view, revision: 0))
    }

    @Test func neverSendsAnythingButOpenReadAndClose() throws {
        // Walk a long sequence; every action must be one of the three read-only operations
        // and no action carries text, keys or geometry (no such operation exists).
        var c = try Self.opened()
        var actions: [TerminalViewController.Action] = []
        for step in 1...30 {
            actions += c.handle(.tick, now: Double(step), date: Self.beforeLease)
            actions += c.handle(.message(try Self.frame("session_terminal_unchanged")), now: Double(step), date: Self.beforeLease)
        }
        actions += c.handle(.leave, now: 40, date: Self.beforeLease)
        for action in actions {
            switch action {
            case .open, .read, .close: break
            }
        }
        #expect(!actions.isEmpty)
        #expect(TerminalViewOperation.allCases.map(\.rawValue) == [
            "session_terminal_open", "session_terminal_read", "session_terminal_close",
        ])
    }

    @Test func defaultRequestIdsAreLowercaseVersion4() {
        var c = TerminalViewController(sessionId: Self.session)
        guard case .open(let id)? = c.handle(.open, now: 0, date: Self.beforeLease).first else {
            Issue.record("no open")
            return
        }
        #expect(WireGuards.isUUID4(id))
    }

    @Test func sentFramesRoundTripThroughTheStrictCodec() throws {
        let binding = AttachedBinding(harness: .claude, harnessSessionId: "h-1")
        let header = WireHeader(id: Self.fixedRequest, timestamp: "2026-10-22T00:00:00.000Z", sessionId: Self.session)
        let open = TerminalViewMessage.open(SessionTerminalOpen(header: header, binding: binding))
        let read = TerminalViewMessage.read(SessionTerminalRead(header: header, viewId: Self.view, afterRevision: nil))
        #expect(try open.encodedFrame().contains("session_terminal_open"))
        #expect(try read.encodedFrame().contains("\"afterRevision\":null"))
    }
}
