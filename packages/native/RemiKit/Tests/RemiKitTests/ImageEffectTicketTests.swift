import Dispatch
import Foundation
import Testing
@testable import RemiKit

@Suite struct ImageEffectTicketTests {
    @Test func cancellationBeforeQueuedEffectForbidsInvocation() async {
        let ticket = ImageEffectTicket()
        let queued = DispatchSemaphore(value: 0)
        let effect = Task.detached {
            guard queued.wait(timeout: .now() + 2) == .success else { return false }
            return ticket.enter()
        }
        #expect(ticket.retire() == .noEffect)
        queued.signal()
        #expect(await effect.value == false)
        #expect(ticket.retire() == .noEffect)
    }

    @Test func cancellationAfterEntryReportsPossibleEffectAndNeverReplays() {
        let ticket = ImageEffectTicket()
        #expect(ticket.enter())
        #expect(ticket.retire() == .effectPossible)
        #expect(!ticket.enter())
        #expect(ticket.retire() == .effectPossible)
    }

    @Test func duplicateEntryNeverStartsAnotherEffect() {
        let ticket = ImageEffectTicket()
        #expect(ticket.enter())
        #expect(!ticket.enter())
        #expect(ticket.retire() == .effectPossible)
    }
}
