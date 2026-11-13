import Foundation

#if os(macOS)
/// Only these owned helpers inherit PATH. Homes, configuration and agent
/// executables are isolated. Entries keep their own runtime guards; delivery controls can
/// explicitly select a local Bun executable to exercise both supported runtime pins.
@MainActor
enum OwnedRecoveryFixture {
    static func configure(_ process: Process, script: URL, arguments: [String] = [],
                          environment: [String: String] = [:], bunExecutable: String? = nil) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-swift-recovery-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let bin = directory.appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        for name in ["claude", "codex"] {
            try Data("#!/bin/sh\nexit 88\n".utf8).write(to: bin.appendingPathComponent(name))
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: bin.appendingPathComponent(name).path)
        }
        let inherited = (ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin")
            .split(separator: ":").filter { $0.hasPrefix("/") }.joined(separator: ":")
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [bunExecutable ?? "bun", script.path] + arguments
        process.currentDirectoryURL = directory
        process.environment = ["HOME": directory.path, "REMI_HOME": directory.appendingPathComponent("state").path,
            "PATH": bin.path + ":" + inherited, "TMPDIR": FileManager.default.temporaryDirectory.path]
            .merging(environment) { _, explicit in explicit }
        return directory
    }
}
#endif
