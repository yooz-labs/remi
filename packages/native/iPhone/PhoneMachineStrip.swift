import RemiUI
import SwiftUI

/// The drawer's machine strip: one line for a single machine, otherwise an All chip and
/// one chip per machine (a menu at accessibility text sizes). It takes plain values and
/// closures and never reads the store.
struct PhoneMachineStrip: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let machines: [RemiMachineSummary]
    let filter: PhoneDrawerFilter
    let onSelectAll: () -> Void
    let onSelectMachine: (String) -> Void
    let onManage: () -> Void

    private var labels: [String: String] { RemiMachineStripPresentation.uniqueLabels(for: machines) }

    private func label(_ machine: RemiMachineSummary) -> String { labels[machine.id] ?? machine.name }

    private var layout: RemiMachineStripPresentation.Layout {
        RemiMachineStripPresentation.layout(for: machines, isAccessibilitySize: dynamicTypeSize.isAccessibilitySize)
    }

    var body: some View {
        content
            .padding(.horizontal, RemiTheme.Spacing.m)
            .padding(.vertical, RemiTheme.Spacing.xxs)
    }

    @ViewBuilder
    private var content: some View {
        switch layout {
        case .none:
            EmptyView()
        case .header(let machine):
            headerLine(machine)
        case .menu:
            HStack(spacing: RemiTheme.Spacing.xs) {
                machineMenu
                manageButton
            }
        case .chips:
            HStack(spacing: RemiTheme.Spacing.xs) {
                ViewThatFits(in: .horizontal) {
                    chipRow
                    ScrollView(.horizontal, showsIndicators: false) { chipRow }
                }
                manageButton
            }
        case .scrollingChips:
            HStack(spacing: RemiTheme.Spacing.xs) {
                ScrollView(.horizontal, showsIndicators: false) { chipRow }
                manageButton
            }
        }
    }

    private func headerLine(_ machine: RemiMachineSummary) -> some View {
        let style = RemiMachineStripPresentation.dotStyle(for: machine.reachability)
        return Button(action: onManage) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                PhoneMachineDot(style: style)
                Text(verbatim: label(machine))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                Text(style.accessibilityWord)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                Spacer(minLength: RemiTheme.Spacing.xs)
                PhoneMachineCountCapsule(count: machine.openQuestionCount)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(RemiMachineStripPresentation.accessibilityLabel(for: machine, label: label(machine)))
        .accessibilityHint("Opens machines")
    }

    private var chipRow: some View {
        HStack(spacing: RemiTheme.Spacing.xs) {
            PhoneMachineChip(
                title: String(localized: "All"),
                style: nil,
                count: 0,
                isSelected: filter == .all,
                accessibilityLabel: "All machines",
                action: onSelectAll
            )
            ForEach(machines) { machine in
                PhoneMachineChip(
                    title: label(machine),
                    style: RemiMachineStripPresentation.dotStyle(for: machine.reachability),
                    count: machine.openQuestionCount,
                    isSelected: filter == .machine(machine.id),
                    accessibilityLabel: RemiMachineStripPresentation.accessibilityLabel(for: machine, label: label(machine)),
                    action: { onSelectMachine(machine.id) }
                )
            }
        }
    }

    private var machineMenu: some View {
        Menu {
            Picker("Machine", selection: menuSelection) {
                Text("All machines").tag(PhoneDrawerFilter.all)
                ForEach(machines) { machine in
                    Text(menuTitle(machine)).tag(PhoneDrawerFilter.machine(machine.id))
                }
            }
        } label: {
            HStack(spacing: RemiTheme.Spacing.xs) {
                Text(menuLabelTitle)
                    .font(.subheadline.weight(.semibold))
                    .multilineTextAlignment(.leading)
                Spacer(minLength: RemiTheme.Spacing.xs)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption.weight(.semibold))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, RemiTheme.Spacing.s)
            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget, alignment: .leading)
            .overlay(Capsule().stroke(RemiTheme.Color.hairline))
            .contentShape(.capsule)
        }
        .accessibilityLabel("Machine filter, \(menuLabelTitle)")
        .accessibilityHint("Chooses which machine's sessions the menu lists")
    }

    private var menuSelection: Binding<PhoneDrawerFilter> {
        Binding(
            get: { filter },
            set: { newValue in
                switch newValue {
                case .all: onSelectAll()
                case .machine(let id): onSelectMachine(id)
                }
            }
        )
    }

    private var menuLabelTitle: String {
        if case .machine(let id) = filter, let machine = machines.first(where: { $0.id == id }) {
            return label(machine)
        }
        return String(localized: "All machines")
    }

    private func menuTitle(_ machine: RemiMachineSummary) -> String {
        let word = RemiMachineStripPresentation.dotStyle(for: machine.reachability).accessibilityWord
        var title = "\(label(machine)), \(word)"
        if machine.openQuestionCount > 0 { title += ", \(machine.openQuestionCount) waiting" }
        return title
    }

    private var manageButton: some View {
        Button(action: onManage) {
            Image(systemName: "desktopcomputer")
                .frame(width: RemiTheme.Size.minimumTapTarget, height: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Manage machines")
        .accessibilityHint("Opens machines")
    }
}

private struct PhoneMachineChip: View {
    let title: String
    let style: RemiMachineStripPresentation.DotStyle?
    let count: Int
    let isSelected: Bool
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                if let style { PhoneMachineDot(style: style) }
                Text(verbatim: title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                PhoneMachineCountCapsule(count: count)
            }
            .foregroundStyle(isSelected ? AnyShapeStyle(.background) : AnyShapeStyle(.primary))
            .padding(.horizontal, RemiTheme.Spacing.s)
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .background { chipBackground }
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityHint(isSelected ? "Shows all machines" : "Shows only this machine's sessions")
    }

    @ViewBuilder
    private var chipBackground: some View {
        if isSelected {
            Capsule().fill(.primary)
        } else {
            Capsule().stroke(RemiTheme.Color.hairline)
        }
    }
}

/// A neutral reachability dot. The shapes differ (solid, half ring, hollow, dashed) so
/// state is not carried by color alone.
struct PhoneMachineDot: View {
    let style: RemiMachineStripPresentation.DotStyle

    var body: some View {
        dot
            .frame(width: RemiTheme.Size.statusDot + 2, height: RemiTheme.Size.statusDot + 2)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var dot: some View {
        switch style {
        case .filled:
            Circle().fill(.secondary)
        case .progress:
            Circle().trim(from: 0, to: 0.65).stroke(.secondary, lineWidth: 1.5).rotationEffect(.degrees(-90))
        case .hollow:
            Circle().stroke(.secondary, lineWidth: 1.5)
        case .dashed:
            Circle().stroke(.secondary, style: StrokeStyle(lineWidth: 1.5, dash: [2, 1.5]))
        }
    }
}

/// The count of open questions. The attention color marks it because it is the one
/// thing here that needs the person.
struct PhoneMachineCountCapsule: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Text(count, format: .number)
                .font(.caption.weight(.bold))
                .foregroundStyle(RemiTheme.Color.attentionInk)
                .padding(.horizontal, RemiTheme.Spacing.xs)
                .padding(.vertical, RemiTheme.Spacing.xxxs)
                .background(RemiTheme.Color.attention, in: .capsule)
                .accessibilityHidden(true)
        }
    }
}

/// One line per machine that needs the person to act ("Studio Mac is offline"). It opens
/// the machines sheet. Secondary text with an icon; the attention color is for questions.
struct PhoneMachineProblemRows: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let machines: [RemiMachineSummary]
    let onManage: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(RemiMachineStripPresentation.problemRows(in: machines)) { row in
                Button(action: onManage) {
                    HStack(spacing: RemiTheme.Spacing.xs) {
                        Image(systemName: icon(row))
                            .accessibilityHidden(true)
                        Text(verbatim: row.message)
                            .multilineTextAlignment(.leading)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                        Spacer(minLength: RemiTheme.Spacing.xs)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .accessibilityHidden(true)
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.accessibilityLabel)
                .accessibilityHint("Opens machines")
            }
        }
    }

    private func icon(_ row: RemiMachineStripPresentation.ProblemRow) -> String {
        guard case .machine(let problem, _) = row else { return "exclamationmark.triangle" }
        switch problem {
        case .unreachable: return "desktopcomputer.trianglebadge.exclamationmark"
        case .waitingForApproval: return "person.badge.clock"
        }
    }
}
