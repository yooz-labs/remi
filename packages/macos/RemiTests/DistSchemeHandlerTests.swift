//
//  DistSchemeHandlerTests.swift
//  RemiTests
//
//  Path resolution (SPA fallback, traversal guard) and MIME mapping for the
//  bundled-web scheme handler (#649), plus the native bootstrap script
//  injected into the WKWebView.
//

import XCTest


final class DistSchemeHandlerTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/bundle/Resources/web", isDirectory: true)

    func testResolvesFilesAndSPARoutes() {
        XCTAssertEqual(
            DistSchemeHandler.resolve(path: "/index.html", webRoot: root).lastPathComponent,
            "index.html")
        XCTAssertEqual(
            DistSchemeHandler.resolve(path: "/assets/app-abc123.js", webRoot: root).path,
            "/bundle/Resources/web/assets/app-abc123.js")
        // Client-side routes (no extension) fall back to index.html.
        XCTAssertEqual(
            DistSchemeHandler.resolve(path: "/sessions/abc", webRoot: root).lastPathComponent,
            "index.html")
        XCTAssertEqual(
            DistSchemeHandler.resolve(path: "/", webRoot: root).lastPathComponent, "index.html")
        XCTAssertEqual(
            DistSchemeHandler.resolve(path: "", webRoot: root).lastPathComponent, "index.html")
    }

    func testPathTraversalStaysInWebRoot() {
        let resolved = DistSchemeHandler.resolve(path: "/../../etc/passwd", webRoot: root)
        XCTAssertTrue(resolved.standardizedFileURL.path.hasPrefix(root.path + "/"))
        XCTAssertEqual(resolved.lastPathComponent, "index.html")
    }

    func testSiblingPrefixCollisionCannotEscape() {
        // #745 review (critical): "/bundle/Resources/web-evil/…" shares the
        // raw string prefix of a root ending in ".../web"; the guard must be
        // path-boundary aware, not substring-based.
        let resolved = DistSchemeHandler.resolve(path: "/../web-evil/secret.txt", webRoot: root)
        XCTAssertEqual(resolved, root.appendingPathComponent("index.html"))

        let dotted = DistSchemeHandler.resolve(path: "/../web.bak/secret.txt", webRoot: root)
        XCTAssertEqual(dotted, root.appendingPathComponent("index.html"))
    }

    func testChoosePortPrefersLiveHint() {
        // #745 review: probe() returns ascending responders, so the
        // last-known-hub preference must be applied at selection time.
        XCTAssertEqual(HubClient.choosePort(responders: [18765, 18771], hint: 18771), 18771)
        XCTAssertEqual(HubClient.choosePort(responders: [18765, 18771], hint: nil), 18765)
        XCTAssertEqual(HubClient.choosePort(responders: [18765], hint: 18771), 18765)
        XCTAssertNil(HubClient.choosePort(responders: [], hint: 18771))
    }

    func testMimeTypes() {
        XCTAssertEqual(DistSchemeHandler.mimeType(forExtension: "html"), "text/html")
        XCTAssertEqual(DistSchemeHandler.mimeType(forExtension: "js"), "text/javascript")
        XCTAssertEqual(DistSchemeHandler.mimeType(forExtension: "css"), "text/css")
        XCTAssertEqual(DistSchemeHandler.mimeType(forExtension: "svg"), "image/svg+xml")
        XCTAssertEqual(DistSchemeHandler.mimeType(forExtension: "woff2"), "font/woff2")
        XCTAssertEqual(
            DistSchemeHandler.mimeType(forExtension: "weird"), "application/octet-stream")
    }

    func testNativeBootstrapScript() {
        // hubUrl carries the /ws path (#766 review, finding 1): the daemon's
        // WebSocket upgrade only matches the exact configured path, no
        // fallback for a bare "ws://host:port".
        let with = WebViewWindow.nativeBootstrapScript(hubUrl: "ws://127.0.0.1:18765/ws")
        XCTAssertTrue(with.contains("window.__REMI_NATIVE__"))
        XCTAssertTrue(with.contains("'macos-menubar'"))
        XCTAssertTrue(with.contains("ws://127.0.0.1:18765/ws"))

        let without = WebViewWindow.nativeBootstrapScript(hubUrl: nil)
        XCTAssertTrue(without.contains("hubUrl: null"))
    }

    func testScanOrderPrefersHint() {
        XCTAssertEqual(HubClient.scanOrder(hintPort: 18770).first, 18770)
        XCTAssertEqual(HubClient.scanOrder(hintPort: nil).first, HubClient.basePort)
        // Out-of-range hints are ignored.
        XCTAssertEqual(HubClient.scanOrder(hintPort: 9999).first, HubClient.basePort)
        XCTAssertEqual(HubClient.scanOrder(hintPort: nil).count, HubClient.portRange)
        XCTAssertEqual(HubClient.scanOrder(hintPort: 18770).count, HubClient.portRange)
    }
}
