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
        XCTAssertTrue(resolved.standardizedFileURL.path.hasPrefix(root.path))
        XCTAssertEqual(resolved.lastPathComponent, "index.html")
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
        let with = WebViewWindow.nativeBootstrapScript(hubUrl: "ws://127.0.0.1:18765")
        XCTAssertTrue(with.contains("window.__REMI_NATIVE__"))
        XCTAssertTrue(with.contains("'macos-menubar'"))
        XCTAssertTrue(with.contains("ws://127.0.0.1:18765"))

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
