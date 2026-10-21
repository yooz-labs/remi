import CoreGraphics
import Testing
@testable import RemiUI

@Suite struct RemiDrawerGestureTests {
    @Test func opensFromTheEdgeOnRoot() {
        #expect(RemiDrawerGesture.shouldBegin(startX: 5, translation: CGSize(width: 30, height: 4), isOpen: false, isAtRoot: true))
        #expect(RemiDrawerGesture.shouldBegin(startX: RemiDrawerGesture.edgeWidth, translation: CGSize(width: 10, height: 0), isOpen: false, isAtRoot: true))
    }

    @Test func refusesFromOutsideTheEdge() {
        #expect(!RemiDrawerGesture.shouldBegin(startX: 21, translation: CGSize(width: 30, height: 0), isOpen: false, isAtRoot: true))
    }

    @Test func refusesWhenNotAtRoot() {
        #expect(!RemiDrawerGesture.shouldBegin(startX: 5, translation: CGSize(width: 30, height: 0), isOpen: false, isAtRoot: false))
    }

    @Test func refusesVerticalOrLeftwardWhenClosed() {
        #expect(!RemiDrawerGesture.shouldBegin(startX: 5, translation: CGSize(width: 10, height: 30), isOpen: false, isAtRoot: true))
        #expect(!RemiDrawerGesture.shouldBegin(startX: 5, translation: CGSize(width: 10, height: 10), isOpen: false, isAtRoot: true))
        #expect(!RemiDrawerGesture.shouldBegin(startX: 5, translation: CGSize(width: -30, height: 0), isOpen: false, isAtRoot: true))
        #expect(!RemiDrawerGesture.shouldBegin(startX: 5, translation: CGSize(width: 0, height: 0), isOpen: false, isAtRoot: true))
    }

    @Test func openDrawerClosesOnLeftwardHorizontalDrag() {
        #expect(RemiDrawerGesture.shouldBegin(startX: 200, translation: CGSize(width: -30, height: 5), isOpen: true, isAtRoot: false))
        #expect(!RemiDrawerGesture.shouldBegin(startX: 200, translation: CGSize(width: 30, height: 0), isOpen: true, isAtRoot: true))
        #expect(!RemiDrawerGesture.shouldBegin(startX: 200, translation: CGSize(width: -5, height: 30), isOpen: true, isAtRoot: true))
    }

    @Test func progressTracksDragAndClamps() {
        #expect(RemiDrawerGesture.progress(translationX: 100, drawerWidth: 200, isOpen: false) == 0.5)
        #expect(RemiDrawerGesture.progress(translationX: 500, drawerWidth: 200, isOpen: false) == 1)
        #expect(RemiDrawerGesture.progress(translationX: -50, drawerWidth: 200, isOpen: false) == 0)
        #expect(RemiDrawerGesture.progress(translationX: -50, drawerWidth: 200, isOpen: true) == 0.75)
        #expect(RemiDrawerGesture.progress(translationX: -500, drawerWidth: 200, isOpen: true) == 0)
        #expect(RemiDrawerGesture.progress(translationX: 50, drawerWidth: 200, isOpen: true) == 1)
    }

    @Test func zeroWidthReturnsRestingValue() {
        #expect(RemiDrawerGesture.progress(translationX: 40, drawerWidth: 0, isOpen: false) == 0)
        #expect(RemiDrawerGesture.progress(translationX: -40, drawerWidth: -1, isOpen: true) == 1)
    }

    @Test func velocityWinsInItsDirection() {
        let fast = RemiDrawerGesture.velocityThreshold + 1
        #expect(RemiDrawerGesture.settledIsOpen(progress: 0.05, velocityX: fast, isOpen: false))
        #expect(!RemiDrawerGesture.settledIsOpen(progress: 0.95, velocityX: -fast, isOpen: true))
        #expect(!RemiDrawerGesture.settledIsOpen(progress: 0.1, velocityX: RemiDrawerGesture.velocityThreshold, isOpen: false))
    }

    @Test func progressThresholdsDecideWhenSlow() {
        let t = RemiDrawerGesture.openProgressThreshold
        #expect(RemiDrawerGesture.settledIsOpen(progress: t, velocityX: 0, isOpen: false))
        #expect(!RemiDrawerGesture.settledIsOpen(progress: t - 0.01, velocityX: 0, isOpen: false))
        #expect(RemiDrawerGesture.settledIsOpen(progress: 1 - t + 0.01, velocityX: 0, isOpen: true))
        #expect(!RemiDrawerGesture.settledIsOpen(progress: 1 - t, velocityX: 0, isOpen: true))
    }

    @Test func openDrawerRefusesAHorizontalVerticalTie() {
        #expect(!RemiDrawerGesture.shouldBegin(startX: 200, translation: CGSize(width: -20, height: 20), isOpen: true, isAtRoot: true))
    }

    @Test func openDrawerRefusesAZeroLengthDrag() {
        #expect(!RemiDrawerGesture.shouldBegin(startX: 200, translation: .zero, isOpen: true, isAtRoot: true))
    }

    @Test func openDrawerNeedsMoreThanTheVelocityThresholdToCloseFast() {
        let threshold = RemiDrawerGesture.velocityThreshold
        #expect(RemiDrawerGesture.settledIsOpen(progress: 0.9, velocityX: -threshold, isOpen: true))
        #expect(!RemiDrawerGesture.settledIsOpen(progress: 0.9, velocityX: -threshold - 1, isOpen: true))
    }

    @Test func dragStartingInsideAReservedRegionIsDetected() {
        let strip = CGRect(x: 0, y: 100, width: 300, height: 60)
        #expect(RemiDrawerGesture.startsInsideAny(of: [strip], at: CGPoint(x: 150, y: 130)))
        #expect(RemiDrawerGesture.startsInsideAny(of: [strip], at: CGPoint(x: 0, y: 100)))
        #expect(!RemiDrawerGesture.startsInsideAny(of: [strip], at: CGPoint(x: 150, y: 400)))
        #expect(!RemiDrawerGesture.startsInsideAny(of: [strip], at: CGPoint(x: 150, y: 161)))
        #expect(!RemiDrawerGesture.startsInsideAny(of: [], at: CGPoint(x: 1, y: 1)))
    }
}
