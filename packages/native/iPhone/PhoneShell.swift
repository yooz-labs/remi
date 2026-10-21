import RemiUI
import SwiftUI
import UIKit

/// Drag progress for the drawer, in its own object. Only the thin slide and fade modifiers
/// read `progress`, so a drag tick re-renders them and not the shell body, which would
/// rebuild the drawer and content closures. `isDragging` changes only when a drag starts
/// or ends, so the shell body can read it cheaply.
@MainActor @Observable
final class PhoneShellDragModel {
    /// Who is driving the drag. One owner at a time: a second touch on another layer
    /// cannot start, end or reset a drag it does not own.
    enum Owner { case edge, close }

    private(set) var progress: CGFloat?
    private(set) var isDragging = false
    private(set) var owner: Owner?

    func update(_ value: CGFloat?, owner: Owner? = nil) {
        progress = value
        self.owner = value == nil ? nil : owner
        let dragging = value != nil
        if dragging != isDragging { isDragging = dragging }
    }

    func resolved(open: Bool) -> CGFloat { progress ?? (open ? 1 : 0) }
}

private struct PhoneShellSlide: ViewModifier {
    let model: PhoneShellDragModel
    let open: Bool
    let width: CGFloat
    let enabled: Bool

    func body(content: Content) -> some View {
        content.offset(x: enabled ? model.resolved(open: open) * width : 0)
    }
}

private struct PhoneShellFade: ViewModifier {
    let model: PhoneShellDragModel
    let open: Bool
    /// The opacity at full progress; nil leaves the content fully opaque.
    let maximum: CGFloat?

    func body(content: Content) -> some View {
        content.opacity(maximum.map { model.resolved(open: open) * $0 } ?? 1)
    }
}

/// Frames, in global coordinates, of drawer regions that scroll horizontally. A drag that
/// starts inside one belongs to it and never closes the drawer.
private struct PhoneDrawerHorizontalRegionsKey: PreferenceKey {
    static let defaultValue: [CGRect] = []
    static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) {
        value.append(contentsOf: nextValue())
    }
}

extension View {
    /// Marks this view as a horizontally scrolling region of the drawer: the shell's
    /// close drag ignores any drag that starts inside it.
    func phoneDrawerKeepsHorizontalDrag() -> some View {
        background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: PhoneDrawerHorizontalRegionsKey.self,
                    value: [proxy.frame(in: .global)]
                )
            }
        }
    }
}

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
    @Environment(\.scenePhase) private var scenePhase
    @State private var drag = PhoneShellDragModel()
    @State private var isSettling = false
    @State private var settledOpen = false
    @State private var settleGeneration = 0
    @State private var tapBlockGeneration = 0
    @State private var recentlyDragged = false
    @GestureState private var isClosingDrag = false
    /// Where the drawer's horizontal scrollers are while it rests open. Not updated during
    /// a drag, so a sliding drawer does not move the regions under a drag's start.
    @State private var horizontalRegions: [CGRect] = []

    private var isOpen: Bool { state.isDrawerOpen }

    /// The drawer exists only while it shows: at rest it is not in the hierarchy, so its
    /// material cannot paint into the safe areas behind the content. `settledOpen`
    /// differing from the state covers the frame between a change and its settle window.
    private var isActive: Bool {
        isOpen || drag.isDragging || isSettling || settledOpen != isOpen
    }

    /// With Reduce Motion the drawer and dim layer mount at full progress in the open
    /// transaction, so their fade-in is an opacity transition on the same animation as the
    /// state change. Without it the slide carries the motion. Not verified at runtime.
    private var fadeTransition: AnyTransition {
        reduceMotion ? .opacity : .identity
    }

    private var animation: Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : RemiTheme.Motion.standard
    }

    var body: some View {
        let drawerView = drawer()
        let contentView = content()
        GeometryReader { proxy in
            let width = drawerWidth(in: proxy.size.width)
            ZStack(alignment: .leading) {
                drawerLayer(drawerView, width: width)
                contentLayer(contentView, width: width)
                dimLayer(width: width)
            }
            .animation(animation, value: isOpen)
        }
        .onAppear { settledOpen = state.isDrawerOpen }
        .onChange(of: isOpen) { _, open in
            if open { Self.resignFirstResponder() }
            beginSettling()
        }
        .onChange(of: isClosingDrag) { _, closing in
            if !closing, drag.owner == .close { resetUnfinishedDrag() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { resetUnfinishedDrag() }
        }
    }

    private func drawerWidth(in containerWidth: CGFloat) -> CGFloat {
        dynamicTypeSize.isAccessibilitySize ? containerWidth : min(containerWidth * 0.86, 360)
    }

    @ViewBuilder
    private func drawerLayer(_ view: Drawer, width: CGFloat) -> some View {
        if isActive {
            view
                .frame(width: width)
                .frame(maxHeight: .infinity)
                .background { Rectangle().fill(.regularMaterial).ignoresSafeArea() }
                .modifier(PhoneShellFade(model: drag, open: isOpen, maximum: reduceMotion ? 1 : nil))
                .environment(\.phoneDrawerBlocksTaps, drag.isDragging || recentlyDragged)
                .environment(\.phoneDrawerOrderFrozen, isOpen || isSettling || drag.isDragging)
                .environment(\.phoneDrawerIsOpen, isOpen)
                .allowsHitTesting(isOpen)
                .accessibilityHidden(!isOpen)
                .accessibilityElement(children: .contain)
                .accessibilitySortPriority(2)
                .accessibilityAction(.escape) { setOpen(false) }
                .onPreferenceChange(PhoneDrawerHorizontalRegionsKey.self) { regions in
                    if !drag.isDragging { horizontalRegions = regions }
                }
                .simultaneousGesture(closeDrag(width: width))
                .transition(fadeTransition)
                .zIndex(reduceMotion ? 3 : 0)
        }
    }

    private func contentLayer(_ view: Content, width: CGFloat) -> some View {
        view
            .background { contentBackground(shadow: false) }
            .mask { contentShape.ignoresSafeArea() }
            .background { contentBackground(shadow: true) }
            .allowsHitTesting(!isOpen)
            .accessibilityHidden(isOpen)
            .gesture(edgePan(width: width))
            .modifier(PhoneShellSlide(model: drag, open: isOpen, width: width, enabled: !reduceMotion))
            .zIndex(1)
    }

    private var cornerRadius: CGFloat { isActive ? 28 : 0 }

    private var contentShape: some Shape {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    /// Opaque, and extended under the status bar and home indicator, so nothing behind
    /// the content layer shows through.
    private func contentBackground(shadow: Bool) -> some View {
        contentShape
            .fill(Color(.systemBackground))
            .shadow(color: .black.opacity(shadow && isActive ? 0.18 : 0), radius: 14)
            .ignoresSafeArea()
    }

    /// A sibling above the content, so only the real content is non-interactive while the
    /// drawer is open. It is a button covering the whole visible content strip, for sighted
    /// touch; a leftward drag on it closes the drawer too.
    @ViewBuilder
    private func dimLayer(width: CGFloat) -> some View {
        if isActive {
            Button(action: tapDim) {
                Color.black
                    .modifier(PhoneShellFade(model: drag, open: isOpen, maximum: reduceMotion ? 0.25 : 0.12))
                    .ignoresSafeArea()
                    .mask { contentShape.ignoresSafeArea() }
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .modifier(PhoneShellSlide(model: drag, open: isOpen, width: width, enabled: !reduceMotion))
            .simultaneousGesture(closeDrag(width: width))
            // Only an open drawer takes touches, so the layer cannot swallow taps and
            // scrolls on the content while a close settles. The header close button and
            // the escape action are the accessible close paths.
            .allowsHitTesting(isOpen)
            .accessibilityHidden(true)
            .transition(fadeTransition)
            .zIndex(2)
        }
    }

    /// A release at the end of a drag is not a tap.
    private func tapDim() {
        guard !drag.isDragging, !recentlyDragged else { return }
        setOpen(false)
    }

    private func edgePan(width: CGFloat) -> PhoneDrawerEdgePan {
        PhoneDrawerEdgePan(
            isEnabled: !isOpen && isAtRoot,
            onChange: { translationX in
                guard drag.owner != .close else { return }
                if !drag.isDragging { Self.resignFirstResponder() }
                drag.update(
                    RemiDrawerGesture.progress(translationX: translationX, drawerWidth: width, isOpen: false),
                    owner: .edge
                )
            },
            onEnd: { translationX, velocityX in
                guard drag.owner == .edge else { return }
                let progress = RemiDrawerGesture.progress(translationX: translationX, drawerWidth: width, isOpen: false)
                settle(progress: progress, velocityX: velocityX, wasOpen: false)
            },
            onCancel: { if drag.owner == .edge { resetUnfinishedDrag() } }
        )
    }

    private func closeDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($isClosingDrag) { _, closing, _ in closing = true }
            .onChanged { value in
                guard isOpen, drag.owner != .edge,
                      !RemiDrawerGesture.startsInsideAny(of: horizontalRegions, at: value.startLocation),
                      RemiDrawerGesture.shouldBegin(
                    startX: value.startLocation.x,
                    translation: value.translation,
                    isOpen: true,
                    isAtRoot: isAtRoot
                ) else { return }
                drag.update(RemiDrawerGesture.progress(
                    translationX: value.translation.width,
                    drawerWidth: width,
                    isOpen: true
                ), owner: .close)
            }
            .onEnded { value in
                // Any release after a real drag (the gesture has a 10 pt minimum) is not
                // a tap, even when the drag did not begin as a drawer drag.
                suppressTapsBriefly()
                guard drag.owner == .close else { return }
                let progress = RemiDrawerGesture.progress(
                    translationX: value.translation.width,
                    drawerWidth: width,
                    isOpen: true
                )
                settle(progress: progress, velocityX: value.velocity.width, wasOpen: true)
            }
    }

    /// A drag that ends over a row must not also fire the row's button. The drawer reads
    /// `phoneDrawerBlocksTaps` and ignores taps while a drag runs and for a moment after.
    /// Only the latest drag's timer clears the flag.
    private func suppressTapsBriefly() {
        tapBlockGeneration += 1
        let generation = tapBlockGeneration
        recentlyDragged = true
        Task {
            try? await Task.sleep(for: .milliseconds(350))
            if generation == tapBlockGeneration { recentlyDragged = false }
        }
    }

    /// A drag the system cancelled, or one that ended without its end callback, returns to
    /// the resting position so the drawer never stays at a partial position with dead
    /// buttons. Does nothing when no drag is unfinished.
    private func resetUnfinishedDrag() {
        guard drag.isDragging else { return }
        setOpen(isOpen)
    }

    private func settle(progress: CGFloat, velocityX: CGFloat, wasOpen: Bool) {
        setOpen(RemiDrawerGesture.settledIsOpen(progress: progress, velocityX: velocityX, isOpen: wasOpen))
    }

    private func setOpen(_ open: Bool) {
        withAnimation(animation) {
            state.isDrawerOpen = open
            drag.update(nil)
        }
        settledOpen = open
        beginSettling()
    }

    /// Keeps the drawer mounted while a change animates. Time-based, with a generation so
    /// only the latest change clears it; an interrupted animation never leaves it set.
    private func beginSettling() {
        settleGeneration += 1
        let generation = settleGeneration
        isSettling = true
        settledOpen = state.isDrawerOpen
        let duration = reduceMotion ? 350 : 500
        Task {
            try? await Task.sleep(for: .milliseconds(duration))
            if generation == settleGeneration { isSettling = false }
        }
    }

    private static func resignFirstResponder() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

extension EnvironmentValues {
    /// True while the drawer is being dragged and just after, so the drawer's own buttons
    /// ignore the tap a release over them would otherwise fire.
    @Entry var phoneDrawerBlocksTaps = false
    /// True while the drawer is open, dragging or closing, so its session order holds still.
    @Entry var phoneDrawerOrderFrozen = false
    /// True only when the drawer is open and reachable, for VoiceOver focus.
    @Entry var phoneDrawerIsOpen = false
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
        let translationX = context.converter.translation(in: .global)?.x ?? 0
        switch recognizer.state {
        case .began, .changed:
            onChange(translationX)
        case .ended:
            onEnd(translationX, context.converter.velocity(in: .global)?.x ?? 0)
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
