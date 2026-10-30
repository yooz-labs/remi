#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import RemiKit
@testable import RemiUI

@MainActor
struct DeliveryPresentationTests {
    @Test func everyOutcomeExplainsItsLimitsAndRendersAtPhoneAndMacWidths() throws {
        let fixture = try JSONDecoder().decode(TranscriptContentMessage.self,
            from: FixtureConformanceTests.fixture("transcript_content"))
        for state in RemiOutgoingState.allCases {
            #expect(!state.title.contains("Sent"))
            #expect(!state.guidance.isEmpty)
        }
        for (name, width, size) in [("phone", 390.0, DynamicTypeSize.large),
                                     ("mac", 860.0, DynamicTypeSize.large),
                                     ("phone-accessibility", 390.0, DynamicTypeSize.accessibility2)] {
            let view = VStack(alignment: .leading, spacing: 24) {
                ForEach(Array(RemiOutgoingState.allCases.enumerated()), id: \.offset) { index, state in
                    RemiTranscriptEntryView(entry: .pending(id: "pending-\(index)", text: fixture.content, state: state),
                        onDismissOutgoing: { _ in })
                }
            }
            .environment(\.dynamicTypeSize, size)
            .padding(20)
            .frame(width: width)
            .background(Color(nsColor: .windowBackgroundColor))
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try #require(renderer.cgImage)
            #expect(image.width == Int(width * 2))
            if let directory = ProcessInfo.processInfo.environment["REMI_DELIVERY_RENDER_DIR"] {
                let url = URL(fileURLWithPath: directory).appendingPathComponent("delivery-\(name).png")
                let png = try #require(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
                try png.write(to: url)
            }
        }
    }
    @Test func retainedHistoryEscapesContextAndKeepsCopyTextAfterMachineRemoval() throws {
        let fixture = try JSONDecoder().decode(TranscriptContentMessage.self,
            from: FixtureConformanceTests.fixture("transcript_content"))
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let key = MachineSessionKey(machineID: "removed-machine\u{202E}", sessionID: fixture.sessionId)
        let origin = OutgoingOrigin(endpoint: MachineEndpoint(host: "127.0.0.1", port: 18790), connection: UUID(), socket: UUID())
        store.trackOutgoing(key: key, id: "fixture", content: fixture.content, origin: origin)
        #expect(store.machines.isEmpty)
        let groups = store.outgoingHistory
        #expect(groups.first?.key == key)
        #expect(!RemiDisplayText.escape(key.machineID).contains("\u{202E}"))
        let copy = try #require(groups.first?.messages.first?.content)
        #expect(RemiTranscriptEntry.pending(id: "fixture", text: copy, state: .uncertain).copyText == fixture.content)

    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_DELIVERY_RENDER_DIR"] != nil,
        "Run the expensive NavigationStack snapshot separately from notification callback deadlines."))
    func retainedHistoryRendersOnDemand() async throws {
        let fixture = try JSONDecoder().decode(TranscriptContentMessage.self,
            from: FixtureConformanceTests.fixture("transcript_content"))
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let key = MachineSessionKey(machineID: "removed-owned-machine", sessionID: fixture.sessionId)
        let origin = OutgoingOrigin(endpoint: MachineEndpoint(host: "127.0.0.1", port: 18790), connection: UUID(), socket: UUID())
        store.trackOutgoing(key: key, id: "fixture", content: fixture.content, origin: origin)
        let view = RemiOutgoingHistoryView(groups: store.outgoingHistory) { key, id in
            store.dismissOutgoing(machineID: key.machineID, sessionID: key.sessionID, messageID: id)
        }.frame(width: 390, height: 900)
        let start = ContinuousClock.now
        let pulse = Task { @MainActor in
            try await Task.sleep(for: .milliseconds(20))
            return start.duration(to: .now)
        }
        await Task.yield()
        // NavigationStack needs a hosting window to render its native content. ImageRenderer
        // can return a nonnil, blank image here, which is not visual verification.
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let host = NSHostingView(rootView: view.background(Color.white).environment(\.colorScheme, .light))
        host.frame = NSRect(x: 0, y: 0, width: 390, height: 900)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.setFrameOrigin(NSPoint(x: -12000, y: -12000))
        window.backgroundColor = .white
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(300))
        host.layoutSubtreeIfNeeded()
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        var visibleSamples = 0
        for y in stride(from: 0, to: bitmap.pixelsHigh, by: 8) {
            for x in stride(from: 0, to: bitmap.pixelsWide, by: 8) {
                if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), color.alphaComponent > 0.5,
                   min(color.redComponent, color.greenComponent, color.blueComponent) < 0.9 {
                    visibleSamples += 1
                }
            }
        }
        #expect(visibleSamples > 50, "The history snapshot must contain visible content, not a blank canvas")
        print("Owned history host render: \(start.duration(to: .now)); 20ms MainActor pulse observed \(try await pulse.value)")
        if let directory = ProcessInfo.processInfo.environment["REMI_DELIVERY_RENDER_DIR"],
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("retained-history-host-render.png"))
        }
        window.contentView = nil

    }

}

#endif
