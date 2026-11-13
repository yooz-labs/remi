import SwiftUI

public enum RemiTranscriptScrollTarget: Hashable {
    case latest
}

/// Follow content growth only while the reader remains near the latest activity.
public struct RemiTranscriptScrollBehavior: ViewModifier {
    @Binding private var followsLatest: Bool
    private let isReviewing: Bool
    private let onFollow: () -> Void
    @State private var followingLayout = false
    @State private var isInteracting = false

    public init(followsLatest: Binding<Bool>, isReviewing: Bool, onFollow: @escaping () -> Void) {
        _followsLatest = followsLatest
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
                guard !isReviewing else { followingLayout = false; return }
                if isInteracting {
                    followingLayout = false
                    followsLatest = current.remaining < 100
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
                guard !followingLayout, previous.offset != current.offset else { return }
                followsLatest = current.remaining < 100
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
