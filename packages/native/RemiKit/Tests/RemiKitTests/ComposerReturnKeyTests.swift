import SwiftUI
import Testing
@testable import RemiUI

@Suite struct ComposerReturnKeyTests {
    private func action(
        _ modifiers: EventModifiers = [], canSend: Bool = true, isComposing: Bool = false
    ) -> RemiComposerReturnKey.Action {
        RemiComposerReturnKey.action(modifiers: modifiers, canSend: canSend, isComposing: isComposing)
    }

    @Test func returnSendsAMessage() {
        #expect(action() == .send)
    }

    @Test func shiftReturnAndOptionReturnStartANewLine() {
        #expect(action(.shift) == .passThrough)
        #expect(action(.option) == .passThrough)
        #expect(action([.shift, .command]) == .passThrough)
    }

    @Test func commandAndControlReturnStillSend() {
        #expect(action(.command) == .send)
        #expect(action(.control) == .send)
    }

    @Test func returnWithNothingToSendDoesNothingNotEvenABlankLine() {
        #expect(action(canSend: false) == .ignore)
        #expect(action(.command, canSend: false) == .ignore)
    }

    @Test func returnThatConfirmsAnInputMethodsTextIsLeftToTheField() {
        // Japanese, Chinese or Korean text being composed: Return commits it, and must not send.
        #expect(action(isComposing: true) == .passThrough)
        #expect(action(canSend: false, isComposing: true) == .passThrough)
    }

    @Test func aNewLineKeyStillBreaksTheLineWhileNothingCanBeSent() {
        // Shift+Return on an empty field is the field's own business (a line break), not ignored.
        #expect(action(.shift, canSend: false) == .passThrough)
    }
}
