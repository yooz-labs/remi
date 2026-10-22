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
            .padding(.vertical, RemiTheme.Spacing.xxs)
    }

    @ViewBuilder
    private var content: some View {
        switch layout {
        case .none:
            EmptyView()
        case .header(let machine):
            headerLine(machine)
                .padding(.horizontal, RemiTheme.Spacing.m)
        case .menu:
            HStack(spacing: RemiTheme.Spacing.xs) {
                machineMenu
                manageButton
            }
            .padding(.horizontal, RemiTheme.Spacing.m)
        case .chips:
            // Chips scroll to the screen edge, so the strip has no outer horizontal
            // padding here; the row and the scroll carry their own margins.
            HStack(spacing: RemiTheme.Spacing.xs) {
                ViewThatFits(in: .horizontal) {
                    chipRow.padding(.leading, RemiTheme.Spacing.m)
                    chipScroll
                }
                manageButton
            }
            .padding(.trailing, RemiTheme.Spacing.m)
        case .scrollingChips:
            HStack(spacing: RemiTheme.Spacing.xs) {
                chipScroll
                manageButton
            }
            .padding(.trailing, RemiTheme.Spacing.m)
        }
    }

    private func headerLine(_ machine: RemiMachineSummary) -> some View {
        let style = RemiMachineStripPresentation.dotStyle(for: machine.reachability)
        return Button(action: onManage) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                PhoneMachineDot(style: style)
                nameAndState(label: label(machine), style: style)
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
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(RemiMachineStripPresentation.accessibilityLabel(for: machine, label: label(machine)))
        .accessibilityHint("Opens machines")
    }

    /// Name and state side by side, stacked at accessibility sizes so neither is squeezed.
    private func nameAndState(label: String, style: RemiMachineStripPresentation.DotStyle) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.xxxs))
            : AnyLayout(HStackLayout(spacing: RemiTheme.Spacing.xs))
        return layout {
            Text(verbatim: label)
                .font(.subheadline.weight(.semibold))
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            Text(style.accessibilityWord)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        }
    }

    /// The chips in a horizontal scroll. Manage stays outside it as a fixed trailing
    /// control, and the trailing margin lets the last chip scroll fully clear of it.
    ///
    /// Only this scrolling row reserves its frame from the shell's close drag, so a swipe
    /// that starts on it scrolls the chips; the header, the menu, Manage and a chip row
    /// that fits without scrolling do not, and a leftward swipe there closes the drawer.
    private var chipScroll: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) { chipRow }
                .contentMargins(.horizontal, RemiTheme.Spacing.m, for: .scrollContent)
                .phoneDrawerKeepsHorizontalDrag()
                .onAppear { scrollToSelected(proxy, animated: false) }
                .onChange(of: filter) { _, _ in scrollToSelected(proxy, animated: true) }
        }
    }

    private func scrollToSelected(_ proxy: ScrollViewProxy, animated: Bool) {
        let id = selectedChipID
        if animated {
            withAnimation(RemiTheme.Motion.quick) { proxy.scrollTo(id, anchor: .center) }
        } else {
            proxy.scrollTo(id, anchor: .center)
        }
    }

    private var selectedChipID: String {
        if case .machine(let id) = filter { return id }
        return Self.allChipID
    }

    private static let allChipID = "all-machines-chip"

    private var chipRow: some View {
        HStack(spacing: RemiTheme.Spacing.xs) {
            PhoneMachineChip(
                title: String(localized: "All"),
                style: nil,
                count: 0,
                isSelected: filter == .all,
                accessibilityLabel: "All machines",
                hint: "Shows sessions from every machine",
                showsClearGlyph: false,
                action: onSelectAll
            )
            .id(Self.allChipID)
            ForEach(machines) { machine in
                PhoneMachineChip(
                    title: label(machine),
                    style: RemiMachineStripPresentation.dotStyle(for: machine.reachability),
                    count: machine.openQuestionCount,
                    isSelected: filter == .machine(machine.id),
                    accessibilityLabel: RemiMachineStripPresentation.accessibilityLabel(for: machine, label: label(machine)),
                    hint: filter == .machine(machine.id) ? "Shows all machines" : "Shows only this machine's sessions",
                    showsClearGlyph: filter == .machine(machine.id),
                    action: { onSelectMachine(machine.id) }
                )
                .id(machine.id)
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
    let hint: LocalizedStringKey
    /// A small decorative xmark on the selected machine chip: tapping it again clears the
    /// filter, and the hint says so for VoiceOver.
    let showsClearGlyph: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                if let style { PhoneMachineDot(style: style) }
                Text(verbatim: title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    // Capped so part of the next chip shows and the row reads as scrollable.
                    .frame(maxWidth: 148)
                PhoneMachineCountCapsule(count: count)
                if showsClearGlyph {
                    Image(systemName: "xmark")
                        .font(.caption2.weight(.bold))
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .frame(minWidth: RemiTheme.Size.minimumTapTarget, minHeight: RemiTheme.Size.minimumTapTarget)
            .background { chipBackground }
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityHint(hint)
    }

    @ViewBuilder
    private var chipBackground: some View {
        if isSelected {
            Capsule()
                .fill(.primary.opacity(0.12))
                .overlay(Capsule().stroke(.primary.opacity(0.4), lineWidth: 1))
        } else {
            Capsule().stroke(RemiTheme.Color.hairline)
        }
    }
}

/// A neutral reachability symbol, one distinct shape per state (see
/// `DotStyle.symbolName`), sized with Dynamic Type. Meaning never rests on color.
struct PhoneMachineDot: View {
    @ScaledMetric(relativeTo: .caption) private var size: CGFloat = 12
    let style: RemiMachineStripPresentation.DotStyle

    var body: some View {
        Image(systemName: style.symbolName)
            .font(.system(size: size))
            .imageScale(.small)
            .foregroundStyle(.secondary)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
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
                            .fixedSize(horizontal: false, vertical: true)
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
