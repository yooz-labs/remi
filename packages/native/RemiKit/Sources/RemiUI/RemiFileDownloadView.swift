import RemiKit
import SwiftUI
import UniformTypeIdentifiers

/// The bytes of a verified download, offered to the system's save panel and nowhere else.
struct RemiDownloadedFile: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    static var writableContentTypes: [UTType] { [.data] }

    let data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

/// Download one file of a session's workspace by its path (ADR 0045, #1639).
///
/// The protocol has no directory listing, so the person types a path relative to the
/// workspace. The flow is the strict state machine in `FileDownloadFlow`; this view only shows
/// it. A file is never previewed or opened: when every byte has matched its digest, Save hands
/// the bytes to the system's file exporter, an explicit action. Cancel, a dropped connection
/// and leaving discard the partial data.
public struct RemiFileDownloadView: View {
    let flow: FileDownloadFlow?
    let onStart: (String) -> Void
    let onCancel: () -> Void
    /// Drops the download and its bytes: after Save, or when the person is done with it.
    let onDiscard: () -> Void
    /// Why a download cannot start right now (from the store), shown under the field.
    let startIssue: String?

    @State private var path = ""
    @State private var exporting = false
    @State private var savedName: String?
    @State private var saveFailed = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    public init(
        flow: FileDownloadFlow?, startIssue: String? = nil, onStart: @escaping (String) -> Void,
        onCancel: @escaping () -> Void, onDiscard: @escaping () -> Void
    ) {
        self.flow = flow
        self.startIssue = startIssue
        self.onStart = onStart
        self.onCancel = onCancel
        self.onDiscard = onDiscard
    }

    private var pathIssue: FileDownloadPathIssue? { FileDownloadPath.issue(in: path) }
    private var isRunning: Bool { flow.map { !$0.isFinished } ?? false }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
                Text("Download a file by its path in the session workspace.")
                    .font(.headline)
                Text("There is no folder browser. Type the path from the workspace root, such as src/main.swift. Nothing is opened; you choose where to save it.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                pathField
                content
            }
            .padding(RemiTheme.Spacing.m)
            .remiReadableColumn()
        }
        .fileExporter(
            isPresented: $exporting,
            document: flow?.verifiedFile.map { RemiDownloadedFile(data: $0.data) },
            contentType: .data,
            defaultFilename: flow?.verifiedFile?.fileName
        ) { result in
            switch result {
            case .success:
                savedName = flow?.verifiedFile.map { RemiDisplayText.escape($0.fileName) }
                onDiscard()
            case .failure:
                saveFailed = true
            }
        }
        .onChange(of: path) { _, _ in savedName = nil }
    }

    private var pathField: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            TextField("Path, for example src/main.swift", text: $path)
                .textFieldStyle(.roundedBorder)
                .font(RemiTheme.Typography.code)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                #endif
                .autocorrectionDisabled()
                .disabled(isRunning)
                .onSubmit(start)
                .accessibilityLabel("File path in the session workspace")
            if !path.isEmpty, let pathIssue {
                Text(pathIssue.text).font(.footnote).foregroundStyle(.secondary)
            }
            if let startIssue {
                Text(startIssue).font(.footnote).foregroundStyle(.secondary)
            }
            if !isRunning, flow?.verifiedFile == nil {
                Button("Download", systemImage: "arrow.down.circle", action: start)
                    .buttonStyle(.borderedProminent)
                    .disabled(pathIssue != nil)
            }
        }
    }

    private func start() {
        guard !isRunning, pathIssue == nil else { return }
        savedName = nil
        onStart(path)
    }

    @ViewBuilder
    private var content: some View {
        if let savedName {
            Label("Saved \(savedName).", systemImage: "checkmark.circle")
                .font(.subheadline)
        }
        if let flow {
            switch flow.status {
            case .requesting:
                running(title: "Asking the machine for \(escapedName(flow.relativePath))") {
                    ProgressView().controlSize(.small)
                }
            case .receiving(let received, let total, let name):
                running(title: "Downloading \(RemiDisplayText.escape(name))") {
                    ProgressView(value: Double(received), total: Double(max(total, 1)))
                    Text("\(Self.size(received)) of \(Self.size(total))")
                        .font(.footnote).foregroundStyle(.secondary)
                        .accessibilityLabel("\(Self.size(received)) of \(Self.size(total)) received")
                }
            case .verified(let name, let count, let hostSettled):
                verified(name: name, count: count, hostSettled: hostSettled)
            case .failed(let message):
                finished(message, systemImage: "exclamationmark.triangle")
            case .cancelled:
                finished("Cancelled. Nothing was kept.", systemImage: "xmark.circle")
            }
        }
    }

    private func escapedName(_ path: String) -> String {
        RemiDisplayText.escape(FileDownloadPath.baseName(of: path))
    }

    private func running<Extra: View>(title: String, @ViewBuilder extra: () -> Extra) -> some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Text(title).font(.subheadline.weight(.semibold))
            extra()
            Button("Cancel", role: .cancel, action: onCancel)
                .buttonStyle(.bordered)
        }
        .padding(RemiTheme.Spacing.m)
        .background(RemiTheme.Color.surface, in: RoundedRectangle(cornerRadius: RemiTheme.Radius.control))
    }

    private func verified(name: String, count: Int, hostSettled: Bool) -> some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Label("Verified", systemImage: "checkmark.seal")
                .font(.subheadline.weight(.semibold))
            Text(RemiDisplayText.escape(name)).font(RemiTheme.Typography.code)
            Text("\(Self.size(count)). Every byte matched the checksum the machine gave.")
                .font(.footnote).foregroundStyle(.secondary)
            if !hostSettled {
                Text("The machine did not confirm it finished, but the file itself is complete.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if saveFailed {
                Text("The file could not be saved. Try again, or choose another place.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            HStack {
                Button("Save", systemImage: "square.and.arrow.down") {
                    saveFailed = false
                    exporting = true
                }
                .buttonStyle(.borderedProminent)
                Button("Discard", role: .destructive, action: onDiscard)
                    .buttonStyle(.bordered)
            }
        }
        .padding(RemiTheme.Spacing.m)
        .background(RemiTheme.Color.surface, in: RoundedRectangle(cornerRadius: RemiTheme.Radius.control))
    }

    private func finished(_ message: String, systemImage: String) -> some View {
        Label(message, systemImage: systemImage)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(RemiTheme.Spacing.m)
    }

    private static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

#if DEBUG
import CryptoKit

/// Flows at each stage, driven through the real state machine with real chunks and SHA-256.
public enum RemiFileDownloadPreviewFlows {
    static let session = "00000000-0000-4000-8000-000000000003"
    static let begin = "00000000-0000-4000-8000-000000000002"
    static let binding = AttachedBinding(harness: .claude, harnessSessionId: "preview-claude")
    static let stamp = "2026-10-22T00:00:00.000Z"
    static let payload = Data((0..<(FileFetchLimits.chunkBytes + 5_000)).map { UInt8(truncatingIfNeeded: $0 &* 31) })

    private static func header(_ n: Int) -> WireHeader {
        WireHeader(id: String(format: "00000000-0000-4000-8000-%012x", n), timestamp: stamp, sessionId: session)
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    public static func flow(upTo stage: Int, path: String = "docs/notes.txt") -> FileDownloadFlow {
        let started = FileDownloadFlow.begin(
            path: path, binding: binding, sessionId: session, requestId: begin, timestamp: stamp, now: 0)
        guard case .success(let first) = started else { preconditionFailure("The preview path is not valid") }
        var flow = first.flow
        func feed(_ message: FileFetchMessage) {
            _ = flow.handle(.message(message), now: 1, makeID: { begin }, timestamp: stamp)
        }
        guard stage >= 1 else { return flow }
        let digest = base64URL(Data(SHA256.hash(data: payload)))
        feed(.accepted(FileFetchAccepted(
            header: header(1), requestId: begin, transferId: "AAECAwQFBgcICQoLDA0ODw", fileName: "notes.txt",
            byteLength: payload.count, digest: digest, expiresAt: "2026-10-22T00:05:00.000Z")))
        func chunk(_ seq: Int) -> FileFetchMessage {
            let start = seq * FileFetchLimits.chunkBytes
            let slice = payload.subdata(in: start..<min(payload.count, start + FileFetchLimits.chunkBytes))
            return .chunk(FileFetchChunk(
                header: header(10 + seq), requestId: header(20 + seq).id, transferId: "AAECAwQFBgcICQoLDA0ODw", seq: seq,
                data: base64URL(slice)))
        }
        guard stage >= 2 else { return flow }
        feed(chunk(0))
        guard stage >= 3 else { return flow }
        feed(chunk(1))
        feed(.result(FileFetchResult(header: header(30), requestId: header(31).id, transferId: "AAECAwQFBgcICQoLDA0ODw")))
        return flow
    }

    public static func refused() -> FileDownloadFlow {
        var flow = flow(upTo: 0)
        _ = flow.handle(
            .message(.refused(FileFetchRefused(header: header(40), requestId: begin, operation: .begin, code: .unavailable))),
            now: 1, makeID: { begin }, timestamp: stamp)
        return flow
    }
}

#Preview("Empty") {
    RemiFileDownloadView(flow: nil, onStart: { _ in }, onCancel: {}, onDiscard: {})
}

#Preview("Receiving") {
    RemiFileDownloadView(
        flow: RemiFileDownloadPreviewFlows.flow(upTo: 2), onStart: { _ in }, onCancel: {}, onDiscard: {})
}

#Preview("Verified") {
    RemiFileDownloadView(
        flow: RemiFileDownloadPreviewFlows.flow(upTo: 3), onStart: { _ in }, onCancel: {}, onDiscard: {})
}

#Preview("Refused, accessibility size") {
    RemiFileDownloadView(
        flow: RemiFileDownloadPreviewFlows.refused(), onStart: { _ in }, onCancel: {}, onDiscard: {}
    )
    .environment(\.dynamicTypeSize, .accessibility3)
}
#endif
