import CoreGraphics
import Testing
@testable import RemiUI

@Suite struct RemiDrawerGestureTests {
    @Test func openDrawerClosesOnLeftwardHorizontalDrag() {
        #expect(RemiDrawerGesture.shouldBeginClosing(translation: CGSize(width: -30, height: 5)))
        #expect(!RemiDrawerGesture.shouldBeginClosing(translation: CGSize(width: 30, height: 0)))
        #expect(!RemiDrawerGesture.shouldBeginClosing(translation: CGSize(width: -5, height: 30)))
    }

    @Test func onlyHorizontalDominantDragsSuppressTaps() {
        #expect(RemiDrawerGesture.suppressesTaps(translation: CGSize(width: 30, height: 4)))
        #expect(RemiDrawerGesture.suppressesTaps(translation: CGSize(width: -30, height: 4)))
        #expect(!RemiDrawerGesture.suppressesTaps(translation: CGSize(width: 4, height: 80)))
        #expect(!RemiDrawerGesture.suppressesTaps(translation: CGSize(width: 20, height: 20)))
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
        #expect(!RemiDrawerGesture.shouldBeginClosing(translation: CGSize(width: -20, height: 20)))
    }

    @Test func openDrawerRefusesAZeroLengthDrag() {
        #expect(!RemiDrawerGesture.shouldBeginClosing(translation: .zero))
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

    @Test func reservedRegionIncludesMinEdgesAndExcludesMaxEdges() {
        let strip = CGRect(x: 10, y: 100, width: 300, height: 60)
        #expect(RemiDrawerGesture.startsInsideAny(of: [strip], at: CGPoint(x: 10, y: 100)))
        #expect(!RemiDrawerGesture.startsInsideAny(of: [strip], at: CGPoint(x: strip.maxX, y: 130)))
        #expect(!RemiDrawerGesture.startsInsideAny(of: [strip], at: CGPoint(x: 150, y: strip.maxY)))
        #expect(!RemiDrawerGesture.startsInsideAny(of: [strip], at: CGPoint(x: strip.maxX, y: strip.maxY)))
        #expect(RemiDrawerGesture.startsInsideAny(of: [strip], at: CGPoint(x: strip.maxX - 0.5, y: strip.maxY - 0.5)))
    }

    @Test func severalReservedRegionsAreAllChecked() {
        let a = CGRect(x: 0, y: 0, width: 100, height: 50)
        let b = CGRect(x: 0, y: 200, width: 100, height: 50)
        #expect(RemiDrawerGesture.startsInsideAny(of: [a, b], at: CGPoint(x: 50, y: 25)))
        #expect(RemiDrawerGesture.startsInsideAny(of: [a, b], at: CGPoint(x: 50, y: 225)))
        #expect(!RemiDrawerGesture.startsInsideAny(of: [a, b], at: CGPoint(x: 50, y: 120)))
    }

    @Test func emptyRectsContainNothing() {
        let empty = CGRect(x: 10, y: 10, width: 0, height: 0)
        #expect(!RemiDrawerGesture.startsInsideAny(of: [empty], at: CGPoint(x: 10, y: 10)))
        #expect(!RemiDrawerGesture.startsInsideAny(of: [.zero, .null], at: .zero))
    }
}
