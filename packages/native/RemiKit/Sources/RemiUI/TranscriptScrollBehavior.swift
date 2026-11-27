import SwiftUI

public enum RemiTranscriptScrollTarget: Hashable {
    case latest
}

struct RemiTranscriptFollowPolicy {
    static func shouldFollow(followsLatest: Bool, isReviewing: Bool) -> Bool {
        followsLatest && !isReviewing
    }

    static func afterUserScroll(followsLatest: Bool, previousOffset: CGFloat, offset: CGFloat, remaining: CGFloat) -> Bool {
        if remaining <= 1 { return true }
        if offset < previousOffset { return false }
        return followsLatest
    }
    static func afterNoninteractiveScroll(followsLatest: Bool, followingLayout: Bool, sizesChanged: Bool,
        previousOffset: CGFloat, offset: CGFloat, remaining: CGFloat) -> Bool {
        if !followingLayout && !sizesChanged && offset < previousOffset && remaining > 1 { return false }
        return followsLatest
    }

}

/// Shared choice for the scroll position and its lifecycle across both native clients.
public enum RemiScrollPositionPolicy {
    public static func effectiveBinding<Value>(followsLatest: Bool, following: Value, review: Value) -> Value {
        followsLatest ? following : review
    }

    public static func positionAfterFollowChange(followsLatest: Bool, visibleEntryID: String?) -> String? {
        followsLatest ? nil : visibleEntryID
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
            .defaultScrollAnchor(RemiTranscriptFollowPolicy.shouldFollow(followsLatest: followsLatest, isReviewing: isReviewing || isInteracting) ? .bottom : nil, for: .sizeChanges)
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
                    followsLatest = RemiTranscriptFollowPolicy.afterUserScroll(followsLatest: followsLatest,
                        previousOffset: previous.offset, offset: current.offset, remaining: current.remaining)
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
                followsLatest = RemiTranscriptFollowPolicy.afterNoninteractiveScroll(followsLatest: followsLatest,
                    followingLayout: followingLayout,
                    sizesChanged: previous.contentSize != current.contentSize || previous.containerSize != current.containerSize,
                    previousOffset: previous.offset, offset: current.offset, remaining: current.remaining)
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
