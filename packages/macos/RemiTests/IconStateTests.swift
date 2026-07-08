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

    func testAssetNamesMapToCatalogEntries() {
        // Names must match the imagesets in Assets.xcassets (#650); the
        // unreachable state reuses the idle glyph, dimmed.
        XCTAssertEqual(IconState.idle.assetName, "menubar-idle")
        XCTAssertEqual(IconState.unreachable.assetName, "menubar-idle")
        XCTAssertEqual(IconState.localAttached.assetName, "menubar-local")
        XCTAssertEqual(IconState.remoteConnected.assetName, "menubar-remote")
    }
}
