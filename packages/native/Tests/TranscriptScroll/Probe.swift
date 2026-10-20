import AppKit
import Observation
import RemiKit
import RemiUI
import SwiftUI

// The runner compiles this with a byte-identical copy of MacSessionDetail.swift.
// The actual SwiftUI/AppKit renderer supplies every measured scroll coordinate.
@MainActor @Observable final class ScrollScenario {
    var entries: [RemiTranscriptEntry] = ScrollScenario.history()
    var generation = 0
    var sessionID = "owned-scroll-session"
    var focusedQuestionID: String?
    static func history(prefix: String = "owned") -> [RemiTranscriptEntry] {
        (0..<80).map { .agent(id: "\(prefix)-\($0)", text: "Owned renderer row \($0)\nA second line of fixture text.\nA third line of fixture text.") }
    }
}

struct ScrollRoot: View {
    let scenario: ScrollScenario
    var body: some View {
        MacSessionDetail(session: RemiSessionSummary(id: scenario.sessionID, machineName: "Owned fixture",
            name: "Scroll regression control", harness: "Claude", project: "owned", status: .idle),
            transcript: scenario.entries,
            questions: scenario.focusedQuestionID == nil ? [] : [RemiPreviewData.binaryQuestion],
            initialQuestionID: scenario.focusedQuestionID)
            .id(scenario.generation)
    }
}

@main struct Probe {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in await runProbe() }
        app.run()
    }

    @MainActor static func runProbe() async {
        let scenario = ScrollScenario()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 600),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Remi owned scroll renderer control"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: ScrollRoot(scenario: scenario))
        window.orderBack(nil)
        await settle(window)
        var records: [[String: Any]] = []
        guard let scroll = largestScroll(window.contentView!) else {
            print("No real NSScrollView found; renderer control unavailable")
            window.close(); exit(2)
        }
        records.append(record("initial-long-history", scroll, passed: atBottom(scroll)))
        await startAtBottom(scroll, window)
        records.append(record("append-control-starts-at-bottom", scroll, passed: atBottom(scroll)))
        scenario.entries.append(.agent(id: "owned-new", text: "Owned newly appended entry"))
        await settle(window)
        records.append(record("append-at-bottom", scroll, passed: atBottom(scroll)))
        await startAtBottom(scroll, window)
        records.append(record("growth-control-starts-at-bottom", scroll, passed: atBottom(scroll)))
        scenario.entries[scenario.entries.count - 1] = .agent(id: "owned-new", text: String(repeating: "Owned streaming growth\n", count: 25))
        await settle(window)
        records.append(record("same-entry-growth", scroll, passed: atBottom(scroll)))
        await startAtBottom(scroll, window)
        records.append(record("resize-control-starts-at-bottom", scroll, passed: atBottom(scroll)))
        window.setContentSize(NSSize(width: 600, height: 480))
        await settle(window)
        records.append(record("resize-while-following", scroll, passed: atBottom(scroll)))
        let document = scroll.documentView!
        let middle = max(0, (document.bounds.height - scroll.contentView.bounds.height) / 2)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: middle))
        scroll.reflectScrolledClipView(scroll.contentView)
        await settle(window)
        let readingY = scroll.documentVisibleRect.minY
        scenario.entries.append(.agent(id: "owned-later", text: "Owned output while reviewing older history"))
        await settle(window)
        records.append(record("preserve-history-review", scroll,
            passed: abs(scroll.documentVisibleRect.minY - readingY) < 2 && !atBottom(scroll)))
        scenario.entries = []
        scenario.generation += 1
        await settle(window)
        scenario.entries = ScrollScenario.history()
        await settle(window)
        guard let reloaded = largestScroll(window.contentView!) else { window.close(); exit(2) }
        records.append(record("delayed-initial-history", reloaded, passed: atBottom(reloaded)))
        let middleOfReload = max(0, (reloaded.documentView!.bounds.height - reloaded.contentView.bounds.height) / 2)
        reloaded.contentView.scroll(to: NSPoint(x: 0, y: middleOfReload))
        reloaded.reflectScrolledClipView(reloaded.contentView)
        await settle(window)
        records.append(record("session-switch-control-is-reviewing", reloaded,
            passed: bottomGap(reloaded) > 1_000))
        scenario.sessionID = "owned-other-session"
        scenario.entries = ScrollScenario.history(prefix: "owned-other")
        await settle(window)
        records.append(record("switch-session-starts-latest", reloaded, passed: atBottom(reloaded)))
        scenario.focusedQuestionID = RemiPreviewData.binaryQuestion.questionID
        scenario.generation += 1
        await settle(window)
        guard let focused = largestScroll(window.contentView!) else { window.close(); exit(2) }
        records.append(record("explicit-question-focus", focused,
            passed: focused.documentVisibleRect.minY < 500 && bottomGap(focused) > 1_000))
        let passed = records.allSatisfy { $0["passed"] as? Bool == true }
        let receipt: [String: Any] = ["outcome": passed ? "pass" : "fail", "actualShippingView": "MacSessionDetail.swift",
            "ownedFixtureOnly": true, "records": records]
        let data = try! JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
        if let path = CommandLine.arguments.dropFirst().first {
            try! data.write(to: URL(fileURLWithPath: path))
        }
        print(String(decoding: data, as: UTF8.self))
        window.close()
        exit(passed ? 0 : 1)
    }

    @MainActor static func settle(_ window: NSWindow) async {
        for _ in 0..<25 {
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            try? await Task.sleep(for: .milliseconds(30))
        }
    }

    @MainActor static func largestScroll(_ view: NSView) -> NSScrollView? {
        var candidates: [NSScrollView] = []
        if let scroll = view as? NSScrollView { candidates.append(scroll) }
        for child in view.subviews { if let scroll = largestScroll(child) { candidates.append(scroll) } }
        return candidates.max { $0.frame.height < $1.frame.height }
    }

    @MainActor static func bottomGap(_ scroll: NSScrollView) -> CGFloat {
        guard let document = scroll.documentView else { return .infinity }
        let clip = scroll.contentView
        let proposed = clip.bounds.offsetBy(dx: 0, dy: document.isFlipped ? 1_000_000 : -1_000_000)
        let limit = clip.constrainBoundsRect(proposed).minY
        return document.isFlipped ? limit - clip.bounds.minY : clip.bounds.minY - limit
    }

    @MainActor static func atBottom(_ scroll: NSScrollView) -> Bool { abs(bottomGap(scroll)) < 4 }

    @MainActor static func moveToBottom(_ scroll: NSScrollView) {
        guard let document = scroll.documentView else { return }
        let clip = scroll.contentView
        let proposed = clip.bounds.offsetBy(dx: 0, dy: document.isFlipped ? 1_000_000 : -1_000_000)
        scroll.contentView.scroll(to: clip.constrainBoundsRect(proposed).origin)
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    @MainActor static func startAtBottom(_ scroll: NSScrollView, _ window: NSWindow) async {
        // Realizing lazy rows changes the document's estimated height. Establish
        // the actual edge before measuring growth; never adjust after the update.
        for _ in 0..<3 {
            moveToBottom(scroll)
            await settle(window)
            if atBottom(scroll) { return }
        }
    }

    @MainActor static func record(_ name: String, _ scroll: NSScrollView, passed: Bool) -> [String: Any] {
        ["case": name, "passed": passed, "bottomGap": bottomGap(scroll),
            "visibleMinY": scroll.documentVisibleRect.minY, "visibleMaxY": scroll.documentVisibleRect.maxY,
            "documentHeight": scroll.documentView?.bounds.height ?? 0,
            "contentInsetBottom": scroll.contentInsets.bottom,
            "flipped": scroll.documentView?.isFlipped ?? false]
    }
}
