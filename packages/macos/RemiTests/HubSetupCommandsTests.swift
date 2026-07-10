//
//  HubSetupCommandsTests.swift
//  RemiTests
//
//  Typo lock (#773): these strings get pasted straight into a user's
//  Terminal, so a drift here is a broken onboarding step, not a cosmetic
//  diff.
//

import XCTest


final class HubSetupCommandsTests: XCTestCase {
    func testCommandStrings() {
        XCTAssertEqual(HubSetupCommands.install, "brew install yooz-labs/tap/remi")
        XCTAssertEqual(HubSetupCommands.startHub, "remi start")
        XCTAssertEqual(HubSetupCommands.autostart, "remi --install")
    }
}
