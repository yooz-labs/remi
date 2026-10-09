// Loads the page bundle into a real WKWebView (the system WebKit) and prints its report as one JSON line.
//
//   swift webkit-host.swift <page.js>
//
// The bundle must set `globalThis.__run` (see entry-page.ts). run-webkit.ts builds the bundle,
// calls this file and prints the summary. The document origin is http://localhost/, a secure
// context, so `crypto.subtle` exists.
import Cocoa
import WebKit

let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    print(String(data: data, encoding: .utf8)!)
}

final class Runner: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    override init() {
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: config)
        super.init()
        webView.navigationDelegate = self
    }
    func start() {
        webView.loadHTMLString(
            "<!doctype html><html><body>relay v2 engine check</body></html>",
            baseURL: URL(string: "http://localhost/")!)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.callAsyncJavaScript(
            "return JSON.stringify({ secure: globalThis.isSecureContext, subtle: typeof crypto.subtle, report: JSON.parse(await globalThis.__run()) })",
            arguments: [:], in: nil, in: .page
        ) { result in
            switch result {
            case .success(let value):
                let info = Bundle(for: WKWebView.self).infoDictionary ?? [:]
                let page = try! JSONSerialization.jsonObject(with: (value as! String).data(using: .utf8)!)
                emit([
                    "meta": [
                        "os": ProcessInfo.processInfo.operatingSystemVersionString,
                        "webkit": "\(info["CFBundleVersion"] ?? "?")",
                    ],
                    "page": page,
                ])
            case .failure(let error):
                emit(["error": "\(error)"])
            }
            NSApp.terminate(nil)
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        emit(["error": "navigation failed: \(error)"])
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let runner = Runner()
DispatchQueue.main.async { runner.start() }
// Never hang: a silent page would otherwise block forever.
DispatchQueue.main.asyncAfter(deadline: .now() + 120) {
    emit(["error": "timeout after 120 s"])
    NSApp.terminate(nil)
}
app.run()
