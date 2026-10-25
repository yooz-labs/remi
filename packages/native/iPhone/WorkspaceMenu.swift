import SwiftUI

/// A menu drawn above the whole screen, next to the row it belongs to.
///
/// A system popover cannot be placed reliably from the sidebar: that column reports a compact size
/// class, so the system opens the popover below the row and clips it at the bottom of the list.
/// The root draws this instead, so it opens to the right of the row, over the detail pane, and is
/// kept inside the window whatever row it comes from.
struct PhoneWorkspaceMenu: Identifiable {
    /// The workspace the menu belongs to.
    let id: String
    /// The row's frame in the window.
    let anchor: CGRect
    let content: AnyView
}

extension EnvironmentValues {
    /// Set by the root. Home puts a menu here to show it; clearing it hides it.
    @Entry var workspaceMenu: Binding<PhoneWorkspaceMenu?>?
}

/// Row frames, kept outside view state so scrolling does not redraw the list for each change.
@MainActor
final class PhoneRowFrames {
    var frames: [String: CGRect] = [:]
}

/// Offers its child at most `max` points of height and then takes the child's own size, unlike
/// `frame(maxHeight:)`, which grows to fill whatever it is offered.
private struct CappedHeight: Layout {
    let max: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        return child.sizeThatFits(ProposedViewSize(width: proposal.width, height: max))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(
            at: bounds.origin,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
        )
    }
}

struct PhoneWorkspaceMenuOverlay: View {
    private static let width: CGFloat = 320
    private static let margin: CGFloat = 8

    @Binding var menu: PhoneWorkspaceMenu?
    /// True when a detail pane sits beside Home, which is where the menu opens.
    let besideRow: Bool
    @State private var size: CGSize = .zero

    var body: some View {
        GeometryReader { proxy in
            if let menu {
                let origin = proxy.frame(in: .global).origin
                let anchor = menu.anchor.offsetBy(dx: -origin.x, dy: -origin.y)
                ZStack(alignment: .topLeading) {
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture { dismiss() }
                        .accessibilityHidden(true)

                    CappedHeight(max: maxHeight(anchor: anchor, bounds: proxy.size)) {
                        menu.content
                    }
                        .frame(width: min(Self.width, proxy.size.width - 2 * Self.margin))
                        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24))
                        .shadow(color: .black.opacity(0.18), radius: 24, y: 8)
                        .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
                        .offset(position(anchor: anchor, bounds: proxy.size))
                        // Hidden until measured, so it does not flash at the corner.
                        .opacity(size == .zero ? 0 : 1)
                        .transition(.scale(scale: 0.96, anchor: .leading).combined(with: .opacity))
                }
                .accessibilityAction(.escape) { dismiss() }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(menu != nil)
        .onChange(of: menu?.id) { _, _ in size = .zero }
    }

    private func dismiss() {
        withAnimation(.snappy) { menu = nil }
    }

    /// Beside a detail pane the menu opens to the right of the row, over the detail pane, and may
    /// use the window's height. Otherwise it uses the side of the row with more room.
    private func maxHeight(anchor: CGRect, bounds: CGSize) -> CGFloat {
        if besideRow { return bounds.height - 2 * Self.margin }
        return opensBelow(anchor: anchor, bounds: bounds)
            ? room(below: anchor, bounds: bounds)
            : room(above: anchor)
    }

    private func room(below anchor: CGRect, bounds: CGSize) -> CGFloat {
        max(bounds.height - anchor.maxY - 2 * Self.margin, 120)
    }

    private func room(above anchor: CGRect) -> CGFloat {
        max(anchor.minY - 2 * Self.margin, 120)
    }

    /// Below the row unless it has clearly less room than above. Depends only on where the row is,
    /// so the choice does not change as the menu is measured.
    private func opensBelow(anchor: CGRect, bounds: CGSize) -> Bool {
        let below = room(below: anchor, bounds: bounds)
        return below >= room(above: anchor) || below >= 280
    }

    private func position(anchor: CGRect, bounds: CGSize) -> CGSize {
        let margin = Self.margin
        let maxX = max(margin, bounds.width - size.width - margin)
        let maxY = max(margin, bounds.height - size.height - margin)
        if besideRow {
            let x = min(anchor.maxX + margin, maxX)
            let y = min(max(anchor.minY, margin), maxY)
            return CGSize(width: x, height: y)
        }
        let x = min(max(anchor.maxX - size.width, margin), maxX)
        let y = opensBelow(anchor: anchor, bounds: bounds)
            ? anchor.maxY + margin
            : anchor.minY - margin - size.height
        return CGSize(width: x, height: min(max(y, margin), maxY))
    }
}

#if DEBUG
private struct PreviewMenuRows: View {
    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<7) { index in
                Text("Session \(index + 1)").padding().frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // Scrolls only when the offered height is too short, like the real menu content.
    var body: some View {
        ViewThatFits(in: .vertical) {
            rows
            ScrollView { rows }
        }
    }
}

private struct WorkspaceMenuPreview: View {
    let besideRow: Bool
    let rowFrame: CGRect
    @State private var menu: PhoneWorkspaceMenu?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(white: 0.96)
            Rectangle().fill(.blue.opacity(0.15))
                .frame(width: 380).frame(maxHeight: .infinity)
                .overlay(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 8).fill(.blue.opacity(0.4))
                        .frame(width: rowFrame.width, height: rowFrame.height)
                        .offset(x: rowFrame.minX, y: rowFrame.minY)
                }
            Text("detail pane").frame(maxWidth: .infinity, maxHeight: .infinity).padding(.leading, 380)
        }
        .overlay { PhoneWorkspaceMenuOverlay(menu: $menu, besideRow: besideRow) }
        .onAppear {
            menu = PhoneWorkspaceMenu(
                id: "w",
                anchor: rowFrame,
                content: AnyView(PreviewMenuRows())
            )
        }
    }
}

#Preview("Menu beside a row near the bottom", traits: .fixedLayout(width: 952, height: 562)) {
    WorkspaceMenuPreview(besideRow: true, rowFrame: CGRect(x: 16, y: 430, width: 340, height: 110))
}

#Preview("Menu below a row, compact", traits: .fixedLayout(width: 380, height: 562)) {
    WorkspaceMenuPreview(besideRow: false, rowFrame: CGRect(x: 16, y: 120, width: 340, height: 110))
}
#endif
