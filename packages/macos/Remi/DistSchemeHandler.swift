//
//  DistSchemeHandler.swift
//  Remi
//
//  Serves the bundled web UI (packages/web dist, staged into the app's
//  Resources/web by scripts/stage-macos-web.sh) over the custom scheme
//  `remi-app://localhost` (#649). A stable custom-scheme origin gives the
//  web app persistent localStorage (the Capacitor-proven pattern) and avoids
//  file:// origin restrictions. The UI is deliberately NOT served from the
//  hub's HTTP server: that would couple UI version to the daemon binary.
//

import Foundation
import WebKit

final class DistSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "remi-app"

    /// Root of the staged web bundle inside the app bundle.
    private let webRoot: URL

    init(webRoot: URL? = nil) {
        self.webRoot =
            webRoot
            ?? Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
    }

    /// Map a request path to a file inside the web root. SPA fallback: any
    /// path without a file extension (a client-side route) serves index.html.
    /// Exported logic kept pure for unit testing.
    nonisolated static func resolve(path: String, webRoot: URL) -> URL {
        var relative = path
        while relative.hasPrefix("/") { relative.removeFirst() }
        if relative.isEmpty { relative = "index.html" }

        let candidate = webRoot.appendingPathComponent(relative)
        // Path traversal guard: the resolved file must stay inside webRoot.
        let normalized = candidate.standardizedFileURL.path
        guard normalized.hasPrefix(webRoot.standardizedFileURL.path) else {
            return webRoot.appendingPathComponent("index.html")
        }
        if (relative as NSString).pathExtension.isEmpty {
            return webRoot.appendingPathComponent("index.html")
        }
        return candidate
    }

    nonisolated static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json", "map": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        case "txt": return "text/plain"
        default: return "application/octet-stream"
        }
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let fileURL = Self.resolve(path: url.path, webRoot: webRoot)
        guard let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let mime = Self.mimeType(forExtension: fileURL.pathExtension)
        let response = URLResponse(
            url: url, mimeType: mime, expectedContentLength: data.count,
            textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil)
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Reads are synchronous and small; nothing to cancel.
    }
}
