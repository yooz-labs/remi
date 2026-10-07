#if DEBUG
import RemiUI
import SwiftUI

private struct MacWindowPreview: View {
    let machines: [MacMachine]
    let sessions: [RemiSessionSummary]

    var body: some View {
        MacRootView(machines: machines, sessions: sessions)
            .frame(width: 1180, height: 720)
    }
}

private struct NewSessionPreview: View {
    var body: some View {
        NewSessionSheet(machines: MacPreviewData.machines)
    }
}

private struct MenuPreview: View {
    var body: some View {
        NeedsYouMenu(questions: [RemiPreviewData.binaryQuestion])
    }
}

#Preview("Window · Light") { MacWindowPreview(machines: MacPreviewData.machines, sessions: RemiPreviewData.sessions).preferredColorScheme(.light) }
#Preview("Window · Dark") { MacWindowPreview(machines: MacPreviewData.machines, sessions: RemiPreviewData.sessions).preferredColorScheme(.dark) }
#Preview("Window · Large Type") { MacWindowPreview(machines: MacPreviewData.machines, sessions: RemiPreviewData.sessions).environment(\.dynamicTypeSize, .accessibility2) }
#Preview("Window · Unreachable") { MacWindowPreview(machines: MacPreviewData.unreachableMachines, sessions: RemiPreviewData.sessions) }
#Preview("Window · Waiting Approval") { MacWindowPreview(machines: MacPreviewData.machines, sessions: RemiPreviewData.sessions) }

#Preview("New Session · Light") { NewSessionPreview().preferredColorScheme(.light) }
#Preview("New Session · Dark") { NewSessionPreview().preferredColorScheme(.dark) }
#Preview("New Session · Large Type") { NewSessionPreview().environment(\.dynamicTypeSize, .accessibility2) }

#Preview("Menu · Light") { MenuPreview().preferredColorScheme(.light) }
#Preview("Menu · Dark") { MenuPreview().preferredColorScheme(.dark) }
#Preview("Menu · Large Type") { MenuPreview().environment(\.dynamicTypeSize, .accessibility2) }

#Preview("First Run · Light") { MacWindowPreview(machines: [], sessions: []).preferredColorScheme(.light) }
#Preview("First Run · Dark") { MacWindowPreview(machines: [], sessions: []).preferredColorScheme(.dark) }
#Preview("First Run · Large Type") { MacWindowPreview(machines: [], sessions: []).environment(\.dynamicTypeSize, .accessibility2) }
#endif
