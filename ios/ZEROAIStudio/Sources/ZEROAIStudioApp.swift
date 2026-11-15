import SwiftUI
import WebKit
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
    var body: some View {
        ZEROWebView()
            .background(Color(red: 0.035, green: 0.035, blue: 0.045))
            .preferredColorScheme(.dark)
    }
}

struct ZEROWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
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

        let bridge = ZeroWKWebViewBridge(webView: webView)
        context.coordinator.bridge = bridge
        contentController.add(bridge, name: "zeroCoreML")

        var request = URLRequest(url: Self.appURL)
        request.cachePolicy = .useProtocolCachePolicy
        request.timeoutInterval = 45
        webView.load(request)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    private static let appURL = URL(string: "https://zero-ai-studio.onrender.com")!

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        // Retain the message handler for the lifetime of the WKWebView.
        var bridge: ZeroWKWebViewBridge?

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            if url.scheme == "https", url.host == "zero-ai-studio.onrender.com" {
                decisionHandler(.allow)
                return
            }

            if ["mailto", "tel"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }
}
