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

    /// Tasks WebKit has stopped. Calling didReceive/didFinish on a stopped
    /// task throws an NSException, and reads complete off-main (#745
    /// review), so completion must check membership on the main thread.
    private var stoppedTasks = Set<ObjectIdentifier>()

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
        // Boundary-aware comparison (#745 review): a raw hasPrefix check let
        // "/../web-evil/x" pass against a root ending in ".../web", because
        // "web-evil" shares the "web" prefix. Require the root itself or a
        // path-separator boundary.
        let normalized = candidate.standardizedFileURL.path
        let rootPath = webRoot.standardizedFileURL.path
        guard normalized == rootPath || normalized.hasPrefix(rootPath + "/") else {
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
        // Read off-main (#745 review): scheme-handler callbacks arrive on
        // the main thread, and a full-bundle reload would otherwise stack
        // synchronous disk reads into UI hitches. Deliver back on main,
        // skipping tasks WebKit stopped mid-read.
        let taskId = ObjectIdentifier(urlSchemeTask)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let data = try? Data(contentsOf: fileURL)
            DispatchQueue.main.async {
                guard let self else { return }
                guard !self.stoppedTasks.contains(taskId) else {
                    self.stoppedTasks.remove(taskId)
                    return
                }
                guard let data else {
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
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stoppedTasks.insert(ObjectIdentifier(urlSchemeTask))
    }
}
