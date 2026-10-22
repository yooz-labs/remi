import SwiftUI
import UIKit

extension View {
    /// Hides the enclosing navigation controller's bar (its title and bar buttons) from
    /// assistive technologies while `hidden` is true, and restores it when false or when
    /// the view goes away. Accessibility only: the bar's layout and appearance do not change.
    ///
    /// `.accessibilityHidden` on the content layer is a SwiftUI accessibility attachment.
    /// The `NavigationStack`'s bar is a UIKit view owned by its navigation controller, so
    /// that modifier is not known to reach it (an accessibility snapshot listed the Menu
    /// button and the Inbox title behind the open drawer). This sets
    /// `accessibilityElementsHidden` on the bar directly. Not verified with VoiceOver.
    func phoneNavigationBarAccessibilityHidden(_ hidden: Bool) -> some View {
        background { PhoneNavigationBarAccessibilityProbe(hidden: hidden) }
    }
}

private struct PhoneNavigationBarAccessibilityProbe: UIViewRepresentable {
    let hidden: Bool

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        view.hidesBar = hidden
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.hidesBar = hidden
    }

    static func dismantleUIView(_ view: ProbeView, coordinator: ()) {
        view.hidesBar = false
    }

    final class ProbeView: UIView {
        var hidesBar = false { didSet { apply() } }
        private weak var appliedBar: UINavigationBar?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }

        private func apply() {
            let bar = navigationBar()
            // A bar this probe hid earlier must not stay hidden if it is no longer the one found.
            if let previous = appliedBar, previous !== bar { previous.accessibilityElementsHidden = false }
            appliedBar = bar
            bar?.accessibilityElementsHidden = hidesBar
        }

        /// The navigation controller that hosts this view, found through the responder chain.
        private func navigationBar() -> UINavigationBar? {
            var responder: UIResponder? = self
            while let current = responder {
                if let controller = current as? UIViewController {
                    return controller.navigationController?.navigationBar
                }
                responder = current.next
            }
            return nil
        }
    }
}
