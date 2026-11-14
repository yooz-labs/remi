import Foundation
import Testing

/// #1768: source guards for the one shared, non-interactive Keychain read
/// context (NativeKeychainReadContext). They scan the code lines, not the `//`
/// comment lines, of every Swift file under Sources/RemiPush and Sources/RemiKit.
struct NativeKeychainReadGuardTests {
    private static let helper = "RemiPush/NativeKeychainReadContext.swift"

    /// Each Swift file of the two targets as ("Target/File.swift", its code lines).
    private static func sources() throws -> [(name: String, code: String)] {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        var files: [(name: String, code: String)] = []
        for target in ["RemiPush", "RemiKit"] {
            let directory = packageRoot.appendingPathComponent("Sources/\(target)", isDirectory: true)
            let enumerator = try #require(FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil))
            for case let url as URL in enumerator where url.pathExtension == "swift" {
                let text = try String(contentsOf: url, encoding: .utf8)
                let code = text.split(separator: "\n", omittingEmptySubsequences: false)
                    .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
                    .joined(separator: "\n")
                files.append(("\(target)/\(url.lastPathComponent)", code))
            }
        }
        try #require(files.contains { $0.name == helper })
        return files
    }

    @Test func noLAContextIsCreatedOutsideTheReadContextHelper() throws {
        let files = try Self.sources()
        let offenders = files.filter { $0.name != Self.helper && $0.code.contains("LAContext(") }.map(\.name)
        #expect(offenders.isEmpty, """
            LAContext created in \(offenders). Keychain reads go through NativeKeychainReadContext.readQuery: \
            a new context per read went past coreauthd's limit on allocated contexts (#1768).
            """)
    }

    @Test func everyKeychainReadGoesThroughTheReadContextHelper() throws {
        let files = try Self.sources()
        let readers = files.filter { file in
            ["SecItemCopyMatching(", ".copyMatching(", "func read(query:"].contains { file.code.contains($0) }
        }
        #expect(readers.map(\.name).contains("RemiPush/NativePushKeyStore.swift"))
        #expect(readers.map(\.name).contains("RemiKit/NativeIdentityRecordStore.swift"))
        for file in readers {
            #expect(file.code.contains("NativeKeychainReadContext.readQuery("),
                    "\(file.name) reads the Keychain without NativeKeychainReadContext.readQuery (#1768).")
            guard let start = file.code.range(of: "func read(query:") else { continue }
            let rest = file.code[start.upperBound...]
            let end = try #require(rest.range(of: "\n    }\n"), "\(file.name): the end of read(query:) was not found.")
            let body = rest[..<end.lowerBound]
            #expect(body.contains("NativeKeychainReadContext.readQuery("),
                    "\(file.name): read(query:) does not build its query with NativeKeychainReadContext.readQuery.")
            #expect(!body.contains("kSecUseAuthenticationContext"),
                    "\(file.name): read(query:) sets its own authentication context.")
        }
    }

    @Test func noKeychainItemCarriesAccessControl() throws {
        let files = try Self.sources()
        let offenders = files.filter {
            $0.code.contains("kSecAttrAccessControl") || $0.code.contains("SecAccessControlCreate")
        }.map(\.name)
        #expect(offenders.isEmpty, """
            Access control in \(offenders). Revisit NativeKeychainReadContext first: once the system invalidates \
            the shared context, it stops enforcing non-interactive reads for the rest of the process (#1768).
            """)
    }
}
