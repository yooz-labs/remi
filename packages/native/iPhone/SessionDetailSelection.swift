import RemiUI
import SwiftUI

extension EnvironmentValues {
    /// Set by the split layout. When present, choosing a session shows it in the detail pane
    /// instead of pushing it onto the navigation stack that contains the choice.
    @Entry var openSessionInDetail: ((RemiSessionSummary) -> Void)?
}
