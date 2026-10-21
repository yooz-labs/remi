import RemiUI
import SwiftUI
import UIKit

/// The phone's container: a drawer fixed at the leading edge and a content layer that
/// slides over it. It is a custom container built on the system edge-pan recognizer and
/// system materials. The decisions behind the drag live in `RemiDrawerGesture`.
struct PhoneShell<Content: View, Drawer: View>: View {
    @Binding var state: PhoneShellState
    var isAtRoot = true
    @ViewBuilder var content: () -> Content
    @ViewBuilder var drawer: () -> Drawer

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var dragProgress: CGFloat?

    private var progress: CGFloat { dragProgress ?? (state.isDrawerOpen ? 1 : 0) }

    var body: some View {
        GeometryReader { proxy in
            let width = drawerWidth(in: proxy.size.width)
            ZStack(alignment: .leading) {
                drawerLayer(width: width)
                contentLayer(width: width)
            }
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .onChange(of: state.isDrawerOpen) { _, isOpen in
            if isOpen { Self.resignFirstResponder() }
        }
    }

    private func drawerWidth(in containerWidth: CGFloat) -> CGFloat {
        dynamicTypeSize.isAccessibilitySize ? containerWidth : min(containerWidth * 0.86, 360)
    }

    private func drawerLayer(width: CGFloat) -> some View {
        drawer()
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .background(.regularMaterial)
            .opacity(reduceMotion ? progress : 1)
            .allowsHitTesting(progress > 0)
            .accessibilityHidden(!state.isDrawerOpen)
            .accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { setOpen(false) }
            .simultaneousGesture(closeDrag(width: width))
            .zIndex(reduceMotion ? 2 : 0)
    }

    private func contentLayer(width: CGFloat) -> some View {
        content()
            .clipShape(.rect(cornerRadius: progress > 0 ? 28 : 0, style: .continuous))
            .shadow(color: .black.opacity(progress > 0 ? 0.18 : 0), radius: 14)
            .overlay { dimOverlay(width: width) }
            .offset(x: reduceMotion ? 0 : progress * width)
            .allowsHitTesting(!state.isDrawerOpen)
            .accessibilityHidden(state.isDrawerOpen)
            .gesture(edgePan(width: width))
            .zIndex(1)
    }

    @ViewBuilder
    private func dimOverlay(width: CGFloat) -> some View {
        if progress > 0 {
            Color.black
                .opacity(progress * (reduceMotion ? 0.25 : 0.12))
                .clipShape(.rect(cornerRadius: 28, style: .continuous))
                .contentShape(.rect)
                .onTapGesture { setOpen(false) }
                .gesture(closeDrag(width: width))
                .accessibilityLabel("Close menu")
                .accessibilityAddTraits(.isButton)
        }
    }

    private func edgePan(width: CGFloat) -> PhoneDrawerEdgePan {
        PhoneDrawerEdgePan(
            isEnabled: !state.isDrawerOpen && isAtRoot,
            onChange: { translationX in
                if dragProgress == nil { Self.resignFirstResponder() }
                dragProgress = RemiDrawerGesture.progress(translationX: translationX, drawerWidth: width, isOpen: false)
            },
            onEnd: { translationX, velocityX in
                let progress = RemiDrawerGesture.progress(translationX: translationX, drawerWidth: width, isOpen: false)
                settle(progress: progress, velocityX: velocityX, wasOpen: false)
            },
            onCancel: { settle(progress: 0, velocityX: 0, wasOpen: false) }
        )
    }

    private func closeDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                guard state.isDrawerOpen, RemiDrawerGesture.shouldBegin(
                    startX: value.startLocation.x,
                    translation: value.translation,
                    isOpen: true,
                    isAtRoot: isAtRoot
                ) else { return }
                dragProgress = RemiDrawerGesture.progress(
                    translationX: value.translation.width,
                    drawerWidth: width,
                    isOpen: true
                )
            }
            .onEnded { value in
                guard dragProgress != nil else { return }
                let progress = RemiDrawerGesture.progress(
                    translationX: value.translation.width,
                    drawerWidth: width,
                    isOpen: true
                )
                settle(progress: progress, velocityX: value.velocity.width, wasOpen: true)
            }
    }

    private func settle(progress: CGFloat, velocityX: CGFloat, wasOpen: Bool) {
        let open = RemiDrawerGesture.settledIsOpen(progress: progress, velocityX: velocityX, isOpen: wasOpen)
        setOpen(open)
    }

    private func setOpen(_ open: Bool) {
        let animation: Animation = reduceMotion ? .easeInOut(duration: 0.2) : RemiTheme.Motion.standard
        withAnimation(animation) {
            state.isDrawerOpen = open
            dragProgress = nil
        }
    }

    private static func resignFirstResponder() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// A `UIScreenEdgePanGestureRecognizer` for the left edge, driving the drawer open.
struct PhoneDrawerEdgePan: UIGestureRecognizerRepresentable {
    var isEnabled: Bool
    var onChange: (CGFloat) -> Void
    var onEnd: (CGFloat, CGFloat) -> Void
    var onCancel: () -> Void

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let recognizer = UIScreenEdgePanGestureRecognizer()
        recognizer.edges = .left
        recognizer.isEnabled = isEnabled
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        let translationX = context.converter.localTranslation?.x ?? 0
        switch recognizer.state {
        case .began, .changed:
            onChange(translationX)
        case .ended:
            onEnd(translationX, context.converter.localVelocity?.x ?? 0)
        case .cancelled, .failed:
            onCancel()
        default:
            break
        }
    }
}

#Preview("Closed") {
    PhoneShellPreview(isOpen: false)
}

#Preview("Open, light") {
    PhoneShellPreview(isOpen: true)
        .preferredColorScheme(.light)
}

#Preview("Open, dark") {
    PhoneShellPreview(isOpen: true)
        .preferredColorScheme(.dark)
}

#Preview("Open, accessibility5") {
    PhoneShellPreview(isOpen: true)
        .dynamicTypeSize(.accessibility5)
}

private struct PhoneShellPreview: View {
    @State private var state: PhoneShellState

    init(isOpen: Bool) {
        _state = State(initialValue: PhoneShellState(isDrawerOpen: isOpen))
    }

    var body: some View {
        PhoneShell(state: $state) {
            NavigationStack {
                List(RemiPreviewData.sessions) { Text($0.name) }
                    .navigationTitle("Content")
            }
        } drawer: {
            List(RemiPreviewData.sessions) { Text($0.name) }
                .scrollContentBackground(.hidden)
        }
    }
}
