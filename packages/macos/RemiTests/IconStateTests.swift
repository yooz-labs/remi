//
//  IconStateTests.swift
//  RemiTests
//
//  Table test for the icon-state reducer (#650 precedence:
//  unreachable > remote > local > idle).
//

import XCTest


final class IconStateTests: XCTestCase {
    func testPrecedenceTable() {
        let cases: [(reachable: Bool, local: Int, remote: Int, expected: IconState)] = [
            (false, 0, 0, .unreachable),
            (false, 3, 2, .unreachable),  // unreachable wins over everything
            (true, 0, 0, .idle),
            (true, 1, 0, .localAttached),
            (true, 5, 0, .localAttached),
            (true, 0, 1, .remoteConnected),
            (true, 2, 1, .remoteConnected),  // remote wins over local
        ]
        for c in cases {
            XCTAssertEqual(
                IconState.derive(
                    reachable: c.reachable, localClients: c.local, remoteClients: c.remote),
                c.expected,
                "reachable=\(c.reachable) local=\(c.local) remote=\(c.remote)")
        }
    }

    func testUnreachableDims() {
        XCTAssertEqual(IconState.unreachable.opacity, 0.4)
        XCTAssertEqual(IconState.idle.opacity, 1.0)
        XCTAssertEqual(IconState.remoteConnected.opacity, 1.0)
    }

    func testAssetNamesMapToCatalogEntries() throws {
        // Verify against the ACTUAL asset catalog on disk, not string
        // literals mirroring IconState.swift (#746 review: the literal
        // version was tautological — a renamed/deleted imageset could never
        // fail it). #filePath navigation reaches the source tree in both
        // local and CI runs.
        let catalogURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // RemiTests/
            .deletingLastPathComponent()  // packages/macos/
            .appendingPathComponent("Remi/Assets.xcassets")
        let imagesets = try Set(
            FileManager.default.contentsOfDirectory(atPath: catalogURL.path)
                .filter { $0.hasSuffix(".imageset") }
                .map { $0.replacingOccurrences(of: ".imageset", with: "") })

        let states: [IconState] = [.idle, .unreachable, .localAttached, .remoteConnected]
        for state in states {
            XCTAssertTrue(
                imagesets.contains(state.assetName),
                "\(state) -> '\(state.assetName)' has no imageset in Assets.xcassets")
        }
        // The unreachable state reuses the idle glyph, dimmed.
        XCTAssertEqual(IconState.unreachable.assetName, IconState.idle.assetName)
    }
}
