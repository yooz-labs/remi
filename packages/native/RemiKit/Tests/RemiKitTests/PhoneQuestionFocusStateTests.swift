import Testing
@testable import RemiUI

@Suite struct PhoneQuestionFocusStateTests {
    @Test func loadedQuestionIsFocusedAtOnce() {
        var state = PhoneQuestionFocusState()
        state.request("q1", loaded: ["q1", "q2"])
        #expect(state.focused == "q1")
        #expect(state.pending == nil)
    }

    @Test func unloadedQuestionStaysPendingUntilItAppears() {
        var state = PhoneQuestionFocusState()
        state.request("q3", loaded: ["q1"])
        #expect(state.focused == nil)
        #expect(state.pending == "q3")
        state.questionsChanged(["q1", "q2"])
        #expect(state.pending == "q3")
        state.questionsChanged(["q1", "q3"])
        #expect(state.focused == "q3")
        #expect(state.pending == nil)
    }

    @Test func focusedQuestionThatDisappearsIsDropped() {
        var state = PhoneQuestionFocusState(initial: "q1", loaded: ["q1"])
        #expect(state.focused == "q1")
        state.questionsChanged([])
        #expect(state.focused == nil)
    }

    @Test func aNewRequestReplacesTheOldOne() {
        var state = PhoneQuestionFocusState()
        state.request("q3", loaded: [])
        state.request("q1", loaded: ["q1"])
        #expect(state.focused == "q1")
        #expect(state.pending == nil)
        state.request("q4", loaded: ["q1"])
        #expect(state.focused == nil)
        #expect(state.pending == "q4")
    }

    @Test func clearDropsBothFocusAndPending() {
        var state = PhoneQuestionFocusState()
        state.request("q3", loaded: [])
        state.clear()
        #expect(state.pending == nil)
        state.questionsChanged(["q3"])
        #expect(state.focused == nil)
    }

    @Test func initialQuestionNotYetLoadedIsPending() {
        let state = PhoneQuestionFocusState(initial: "q9", loaded: [])
        #expect(state.focused == nil)
        #expect(state.pending == "q9")
        #expect(PhoneQuestionFocusState(initial: nil, loaded: ["q1"]).focused == nil)
    }
}
