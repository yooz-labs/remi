import RemiUI
import SwiftUI

extension EnvironmentValues {
    /// Set by the split layout. When present, choosing a session shows it in the detail pane
    /// instead of pushing it onto the navigation stack that contains the choice.
    @Entry var openSessionInDetail: ((RemiSessionSummary) -> Void)?

    /// The session shown in the detail pane, so the lists can mark it as selected.
    @Entry var selectedSessionID: String?

    /// True when a detail pane sits beside Home (a wide window). Home then leaves its actions to
    /// the detail pane's bar, and opens its popovers to the right, over the detail pane. Read this
    /// rather than the size class, which the sidebar column reports as compact.
    @Entry var hasDetailPane = false

    /// Set by the root to ask Home to run an action from the detail pane's bar.
    @Entry var homeActionRequest: Binding<PhoneHomeAction?>?
}
