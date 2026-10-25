import SwiftUI

extension ToolbarContent {
    /// Lets the system place this item in a vertical bar. iPhone Duo presents bars on the side of
    /// the display, away from the camera, when the device is closed or the window is narrow.
    /// The item needs an icon and a title, which every item that uses this has.
    @ToolbarContentBuilder
    func verticalBarPreferred() -> some ToolbarContent {
        if #available(iOS 27.1, *) {
            self.axisBehavior(.verticalPreferred)
        } else {
            self
        }
    }
}
