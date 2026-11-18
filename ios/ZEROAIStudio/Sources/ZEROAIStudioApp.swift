import SwiftUI
import WebKit
import UIKit
import ZeroCoreML

@main
struct ZEROAIStudioApp: App {
    var body: some Scene {
        WindowGroup {
            ZEROHomeView()
                .ignoresSafeArea()
        }
    }
}

struct ZEROHomeView: View {
    @State private var loadError: String?
    @State private var reloadToken = 0

    var body: some View {
        ZStack {
            Color(red: 0.035, green: 0.035, blue: 0.045).ignoresSafeArea()

            ZEROWebView(
                reloadToken: reloadToken,
                onLoadError: { message in loadError = message },
                onLoadSuccess: { loadError = nil }
            )
            .ignoresSafeArea()

            if let loadError {
                VStack(spacing: 14) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 34, weight: .medium))
                    Text("ZERO konnte nicht geladen werden")
                        .font(.headline)
                    Text(loadError)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Button {
                        self.loadError = nil
                        reloadToken += 1
                    } label: {
                        Label("Erneut versuchen", systemImage: "arrow.clockwise")
                            .font(.headline)
                            .padding(.horizontal, 22)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding(28)
                .frame(maxWidth: 360)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22))
                .padding(24)
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct ZEROWebView: UIViewRepresentable {
    let reloadToken: Int
    let onLoadError: (String) -> Void
    let onLoadSuccess: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onLoadError: onLoadError, onLoadSuccess: onLoadSuccess)
    }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.035, green: 0.035, blue: 0.045, alpha: 1)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator

        let bridge = ZeroWKWebViewBridge(
            webView: webView,
            trustedHost: Coordinator.appHost,
            trustedPort: Coordinator.appURL?.port ?? 443
        )
        context.coordinator.bridge = bridge
        contentController.add(bridge, name: "zeroCoreML")
        context.coordinator.load(webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.updateCallbacks(
            onLoadError: onLoadError,
            onLoadSuccess: onLoadSuccess
        )
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            context.coordinator.load(webView)
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var bridge: ZeroWKWebViewBridge?
        var lastReloadToken = 0
        private var onLoadError: (String) -> Void
        private var onLoadSuccess: () -> Void

        init(onLoadError: @escaping (String) -> Void, onLoadSuccess: @escaping () -> Void) {
            self.onLoadError = onLoadError
            self.onLoadSuccess = onLoadSuccess
        }

        func updateCallbacks(
            onLoadError: @escaping (String) -> Void,
            onLoadSuccess: @escaping () -> Void
        ) {
            self.onLoadError = onLoadError
            self.onLoadSuccess = onLoadSuccess
        }

        static var appURL: URL? {
            guard let value = Bundle.main.object(forInfoDictionaryKey: "ZERO_APP_URL") as? String,
                  let url = URL(string: value),
                  url.scheme == "https",
                  let host = url.host, !host.isEmpty,
                  url.user == nil, url.password == nil
            else { return nil }
            return url
        }

        static var appHost: String { appURL?.host ?? "" }

        func load(_ webView: WKWebView) {
            guard let appURL = Self.appURL else {
                onLoadError("Die ZERO-Serveradresse ist ungültig. Prüfe ZERO_APP_URL in der iOS-Build-Konfiguration.")
                return
            }
            var request = URLRequest(url: appURL)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 45
            webView.load(request)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onLoadSuccess()
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            onLoadError(Self.userFacingMessage(for: error))
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            onLoadError(Self.userFacingMessage(for: error))
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            load(webView)
        }

        private static func userFacingMessage(for error: Error) -> String {
            let nsError = error as NSError
            if nsError.code == NSURLErrorNotConnectedToInternet ||
                nsError.code == NSURLErrorNetworkConnectionLost ||
                nsError.code == NSURLErrorTimedOut {
                return "Keine stabile Internetverbindung. Prüfe WLAN oder mobile Daten und versuche es erneut."
            }
            return "Verbindung zum ZERO-Server fehlgeschlagen (\(nsError.localizedDescription))."
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            if let appURL = Self.appURL,
               url.scheme == "https",
               url.host == appURL.host,
               (url.port ?? 443) == (appURL.port ?? 443) {
                decisionHandler(.allow)
                return
            }

            if ["mailto", "tel"].contains(url.scheme ?? "") || url.scheme == "https" {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
        ) {
            guard let appURL = Self.appURL,
                  origin.protocol == appURL.scheme,
                  origin.host == appURL.host,
                  origin.port == (appURL.port ?? 443) else {
                decisionHandler(.deny)
                return
            }

            decisionHandler(.prompt)
        }
    }
}
