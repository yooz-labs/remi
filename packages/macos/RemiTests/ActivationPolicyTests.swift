//
//  ActivationPolicyTests.swift
//  RemiTests
//
//  Table test for the Dock/Cmd-Tab activation-policy reducer (#785):
//  any visible presence window -> .regular, none -> .accessory.
//

import XCTest

final class ActivationPolicyTests: XCTestCase {
    func testNoWindowsIsAccessory() {
        XCTAssertEqual(ActivationPolicy.derive(visibleWindowCount: 0), .accessory)
    }

    func testAnyVisibleWindowIsRegular() {
        let cases = [1, 2, 3, 10]
        for count in cases {
            XCTAssertEqual(
                ActivationPolicy.derive(visibleWindowCount: count), .regular,
                "visibleWindowCount=\(count)")
        }
    }

    func testNegativeCountTreatedAsNone() {
        // Defensive: a miscount should never fail open into .regular.
        XCTAssertEqual(ActivationPolicy.derive(visibleWindowCount: -1), .accessory)
    }

    func testTransitionTable() {
        // Main window opens (1 -> .regular), Settings also opens (2, stays
        // .regular), main closes but Settings remains (1, stays .regular),
        // Settings closes too (0 -> .accessory).
        let sequence: [(visibleWindowCount: Int, expected: ActivationPolicy)] = [
            (0, .accessory),
            (1, .regular),
            (2, .regular),
            (1, .regular),
            (0, .accessory),
        ]
        for step in sequence {
            XCTAssertEqual(
                ActivationPolicy.derive(visibleWindowCount: step.visibleWindowCount),
                step.expected,
                "visibleWindowCount=\(step.visibleWindowCount)")
        }
    }
}
