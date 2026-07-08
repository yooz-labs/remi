//
//  WebViewWindow.swift
//  Remi
//
//  WKWebView host for the bundled web UI (#649). The view is a thin shell:
//  the web app has the full protocol/identity stack; the native side only
//  points it at the discovered hub via an injected global.
//

import SwiftUI
import WebKit

struct WebViewWindow: NSViewRepresentable {
    @ObservedObject var hubClient: HubClient

    /// The injected native handoff. Re-built per page load so a moved hub
    /// port never leaves stale state behind; the web side merges this URL
    /// into its stored connections on mount.
    nonisolated static func nativeBootstrapScript(hubUrl: String?) -> String {
        let urlLiteral: String
        if let hubUrl {
            // hubUrl is machine-built (ws://127.0.0.1:<port>), never
            // user-controlled; JSON-encode defensively anyway.
            // .withoutEscapingSlashes: default JSON escapes / as \/ which is
            // valid JS but gratuitously unreadable in the injected script.
            let data = try? JSONSerialization.data(
                withJSONObject: [hubUrl], options: [.withoutEscapingSlashes])
            let encoded = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
            urlLiteral = "\(encoded)[0]"
        } else {
            urlLiteral = "null"
        }
        return """
            window.__REMI_NATIVE__ = { platform: 'macos-menubar', hubUrl: \(urlLiteral) };
            """
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            DistSchemeHandler(), forURLScheme: DistSchemeHandler.scheme)

        let script = WKUserScript(
            source: Self.nativeBootstrapScript(hubUrl: hubClient.hubURL),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        configuration.userContentController.addUserScript(script)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.load(URLRequest(url: URL(string: "\(DistSchemeHandler.scheme)://localhost/index.html")!))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // The web app manages its own connection lifecycle after mount; a
        // late hub discovery is handled by reloading once when the hub URL
        // first becomes known and the page loaded without one.
        guard let hubUrl = hubClient.hubURL else { return }
        if context.coordinator.lastInjectedHubUrl == nil {
            context.coordinator.lastInjectedHubUrl = hubUrl
            let configuration = webView.configuration
            configuration.userContentController.removeAllUserScripts()
            configuration.userContentController.addUserScript(
                WKUserScript(
                    source: Self.nativeBootstrapScript(hubUrl: hubUrl),
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true))
            webView.reload()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(lastInjectedHubUrl: hubClient.hubURL)
    }

    final class Coordinator {
        var lastInjectedHubUrl: String?
        init(lastInjectedHubUrl: String?) {
            self.lastInjectedHubUrl = lastInjectedHubUrl
        }
    }
}
