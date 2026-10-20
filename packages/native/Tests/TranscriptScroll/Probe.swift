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
    static func history() -> [RemiTranscriptEntry] {
        (0..<80).map { .agent(id: "owned-\($0)", text: "Owned renderer row \($0)\nA second line of fixture text.\nA third line of fixture text.") }
    }
}

struct ScrollRoot: View {
    let scenario: ScrollScenario
    var body: some View {
        MacSessionDetail(session: RemiSessionSummary(id: "owned-scroll-session", machineName: "Owned fixture",
            name: "Scroll regression control", harness: "Claude", project: "owned", status: .idle),
            transcript: scenario.entries, questions: [])
            .id(scenario.generation)
    }
}

@main struct Probe {
    @MainActor static func main() async {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
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
        let visible = scroll.documentVisibleRect
        return document.isFlipped ? document.bounds.maxY - visible.maxY : visible.minY - document.bounds.minY
    }

    @MainActor static func atBottom(_ scroll: NSScrollView) -> Bool { abs(bottomGap(scroll)) < 4 }

    @MainActor static func moveToBottom(_ scroll: NSScrollView) {
        guard let document = scroll.documentView else { return }
        let y = document.isFlipped
            ? max(0, document.bounds.maxY - scroll.documentVisibleRect.height)
            : document.bounds.minY
        scroll.contentView.scroll(to: NSPoint(x: 0, y: y))
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
            "flipped": scroll.documentView?.isFlipped ?? false]
    }
}
