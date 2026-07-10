//
//  WebViewWindow.swift
//  Remi
//
//  WKWebView host for the bundled web UI (#649). The view is a thin shell:
//  the web app has the full protocol/identity stack; the native side only
//  points it at the discovered hub via an injected global.
//

import AppKit
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
            // hubUrl is machine-built (ws://127.0.0.1:<port>/ws), never
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
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.load(URLRequest(url: URL(string: "\(DistSchemeHandler.scheme)://localhost/index.html")!))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Re-inject + reload on EVERY hub URL change (#745 review; design
        // doc: "a moved hub port never leaves stale state behind") — late
        // first discovery, hub restart on a new port, or session-daemon ->
        // hub promotion. The inequality guard keeps the frequent SwiftUI
        // update passes from looping reloads.
        guard let hubUrl = hubClient.hubURL, hubUrl != context.coordinator.lastInjectedHubUrl
        else { return }
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

    func makeCoordinator() -> Coordinator {
        Coordinator(lastInjectedHubUrl: hubClient.hubURL)
    }

    /// Tracks the last-injected hub URL and enforces the navigation policy
    /// for the WKWebView (#766 review, finding 2): rendered chat/transcript
    /// Markdown can carry target=_blank links, and with no delegate WebKit's
    /// default policy lets that content navigate the app's only window off
    /// the bundled `remi-app://` origin — into which the bootstrap script
    /// re-injects the hub URL on every load.
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var lastInjectedHubUrl: String?
        init(lastInjectedHubUrl: String?) {
            self.lastInjectedHubUrl = lastInjectedHubUrl
        }

        /// Allow only same-origin (`remi-app://`) navigations plus the
        /// `about:blank` placeholder WebKit uses en route to
        /// `createWebViewWith` for target=_blank/window.open. Everything
        /// else is cancelled and handed to the system browser instead.
        func webView(
            _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if url.scheme == DistSchemeHandler.scheme || url.absoluteString == "about:blank" {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
        }

        /// target=_blank / window.open(): never create a second
        /// WebKit-hosted window inside the sandboxed app; open externally.
        func webView(
            _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
    }
}
