//
//  DistSchemeHandlerServingTests.swift
//  RemiTests
//
//  Exercises the ACTUAL serving path (webView(_:start:)) against a real
//  temp-directory web root with real files (#745 review) — not just the
//  pure resolve/mime helpers. The recorder conforms to the WKURLSchemeTask
//  protocol to capture what production code hands WebKit; the files, reads,
//  and MIME decisions are all real.
//

import WebKit
import XCTest

/// Captures the scheme handler's responses. WKWebView never renders here;
/// this is the protocol seam WebKit itself defines.
private final class RecordingSchemeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    private(set) var response: URLResponse?
    private(set) var body = Data()
    private(set) var finished = false
    private(set) var error: Error?

    init(url: String) {
        self.request = URLRequest(url: URL(string: url)!)
    }

    func didReceive(_ response: URLResponse) { self.response = response }
    func didReceive(_ data: Data) { body.append(data) }
    func didFinish() { finished = true }
    func didFailWithError(_ error: Error) { self.error = error }
}

final class DistSchemeHandlerServingTests: XCTestCase {
    private var webRoot: URL!
    private var handler: DistSchemeHandler!
    private let webView = WKWebView()

    override func setUpWithError() throws {
        webRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("remi-webroot-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: webRoot.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try Data("<html>remi</html>".utf8)
            .write(to: webRoot.appendingPathComponent("index.html"))
        try Data("console.log('app')".utf8)
            .write(to: webRoot.appendingPathComponent("assets/app.js"))
        handler = DistSchemeHandler(webRoot: webRoot)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: webRoot)
    }

    func testServesRealFileWithMimeAndBody() {
        let task = RecordingSchemeTask(url: "remi-app://localhost/assets/app.js")
        handler.webView(webView, start: task)
        XCTAssertTrue(task.finished)
        XCTAssertNil(task.error)
        XCTAssertEqual(task.response?.mimeType, "text/javascript")
        XCTAssertEqual(String(data: task.body, encoding: .utf8), "console.log('app')")
    }

    func testSPARouteServesIndexHtmlWithTextEncoding() {
        let task = RecordingSchemeTask(url: "remi-app://localhost/sessions/abc123")
        handler.webView(webView, start: task)
        XCTAssertTrue(task.finished)
        XCTAssertEqual(task.response?.mimeType, "text/html")
        XCTAssertEqual(task.response?.textEncodingName, "utf-8")
        XCTAssertEqual(String(data: task.body, encoding: .utf8), "<html>remi</html>")
    }

    func testMissingFileFailsInsteadOfHanging() {
        let task = RecordingSchemeTask(url: "remi-app://localhost/assets/missing.js")
        handler.webView(webView, start: task)
        XCTAssertFalse(task.finished)
        XCTAssertNotNil(task.error)
    }

    func testReconnectPolicyHelpers() {
        // Pure backoff/hint helpers extracted per the same review pass.
        XCTAssertEqual(HubClient.nextReconnectDelay(after: 1), 2)
        XCTAssertEqual(HubClient.nextReconnectDelay(after: 16), 30)
        XCTAssertEqual(HubClient.nextReconnectDelay(after: 30), 30)
        XCTAssertTrue(HubClient.shouldUseHint(consecutiveFailures: 0))
        XCTAssertTrue(HubClient.shouldUseHint(consecutiveFailures: 2))
        XCTAssertFalse(HubClient.shouldUseHint(consecutiveFailures: 3))
    }
}
