import SwiftUI

struct MacNotificationSettingsControls: View {
    @Binding var questions: Bool
    @Binding var turnComplete: Bool

    var body: some View {
        Toggle("Question notifications", isOn: $questions)
        Toggle("Turn-complete notifications", isOn: $turnComplete)
        Text("Turn-complete alerts require the host setting and minimum duration (60 seconds by default). Error and denial alerts are off; host-configured subagent alerts may still arrive. Changes apply when connected machines update their notification registration.")
            .font(.callout)
            .foregroundStyle(.secondary)
    }
}
