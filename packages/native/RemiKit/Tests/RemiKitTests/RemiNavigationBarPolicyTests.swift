import Testing
@testable import RemiUI

@Suite struct RemiNavigationBarPolicyTests {
    @Test func sightedPeopleAtStandardSizesGetTheMinimizingBar() {
        #expect(RemiNavigationBarPolicy.minimizesOnScroll(voiceOver: false, switchControl: false, accessibilitySize: false))
    }

    @Test func eachAssistiveConditionKeepsTheBarVisible() {
        #expect(!RemiNavigationBarPolicy.minimizesOnScroll(voiceOver: true, switchControl: false, accessibilitySize: false))
        #expect(!RemiNavigationBarPolicy.minimizesOnScroll(voiceOver: false, switchControl: true, accessibilitySize: false))
        #expect(!RemiNavigationBarPolicy.minimizesOnScroll(voiceOver: false, switchControl: false, accessibilitySize: true))
        #expect(!RemiNavigationBarPolicy.minimizesOnScroll(voiceOver: true, switchControl: true, accessibilitySize: true))
    }
}
