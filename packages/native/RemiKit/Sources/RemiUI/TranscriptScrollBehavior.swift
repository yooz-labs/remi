import SwiftUI

public enum RemiTranscriptScrollTarget: Hashable {
    case latest
}

struct RemiTranscriptFollowPolicy {
    private(set) var followsLatest: Bool

    init(restoredPosition: Bool) { followsLatest = !restoredPosition }
    func shouldFollow(isReviewing: Bool) -> Bool { followsLatest && !isReviewing }
    mutating func jumpToLatest() { followsLatest = true }
    mutating func userScrolled(previousOffset: CGFloat, offset: CGFloat, remaining: CGFloat) {
        if offset < previousOffset { followsLatest = false }
        else if remaining <= 1 { followsLatest = true }
    }
}

/// Follow content growth only while the reader remains near the latest activity.
public struct RemiTranscriptScrollBehavior: ViewModifier {
    @Binding private var followsLatest: Bool
    @Binding private var atLatest: Bool
    private let isReviewing: Bool
    private let onFollow: () -> Void
    @State private var followingLayout = false
    @State private var isInteracting = false

    public init(followsLatest: Binding<Bool>, atLatest: Binding<Bool>, isReviewing: Bool, onFollow: @escaping () -> Void) {
        _followsLatest = followsLatest
        _atLatest = atLatest
        self.isReviewing = isReviewing
        self.onFollow = onFollow
    }

    public func body(content: Content) -> some View {
        content
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(followsLatest && !isReviewing && !isInteracting ? .bottom : nil, for: .sizeChanges)
            .defaultScrollAnchor(.topLeading, for: .alignment)
            .onScrollGeometryChange(for: Viewport.self) { geometry in
                Viewport(offset: geometry.contentOffset.y,
                    remaining: geometry.contentSize.height - geometry.visibleRect.maxY,
                    contentSize: geometry.contentSize, containerSize: geometry.containerSize)
            } action: { previous, current in
                atLatest = current.remaining <= 1
                guard !isReviewing else { followingLayout = false; return }
                if isInteracting {
                    followingLayout = false
                    var policy = RemiTranscriptFollowPolicy(restoredPosition: !followsLatest)
                    policy.userScrolled(previousOffset: previous.offset, offset: current.offset, remaining: current.remaining)
                    followsLatest = policy.shouldFollow(isReviewing: false)
                    return
                }
                // Reflow can move the viewport before its final size is known.
                // Keep following that layout until the actual tail is visible.
                if followsLatest && (previous.contentSize != current.contentSize ||
                    previous.containerSize != current.containerSize) {
                    followingLayout = current.remaining > 1
                    if followingLayout { onFollow() }
                    return
                }
                if current.remaining <= 1 { followingLayout = false }
            }
            .onScrollPhaseChange { _, phase in
                isInteracting = phase == .tracking || phase == .interacting || phase == .decelerating
                if isInteracting { followingLayout = false }
            }
            .onChange(of: followsLatest) { _, following in
                if !following { followingLayout = false }
            }
    }

    private struct Viewport: Equatable {
        let offset: CGFloat
        let remaining: CGFloat
        let contentSize: CGSize
        let containerSize: CGSize
    }
}
