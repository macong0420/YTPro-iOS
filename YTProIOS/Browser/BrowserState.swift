import Combine
import UIKit
import WebKit

@MainActor
final class BrowserState: NSObject, ObservableObject {
    @Published private(set) var title = ""
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false

    let webView: WKWebView
    private var lifecycleObservers: [NSObjectProtocol] = []

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.websiteDataStore = .default()

        if let script = Self.loadUserScript() {
            configuration.userContentController.addUserScript(script)
        }

        webView = WKWebView(frame: .zero, configuration: configuration)

        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        installLifecycleObservers()

        loadHome()
    }

    deinit {
        lifecycleObservers.forEach(NotificationCenter.default.removeObserver)
    }

    func loadHome() {
        guard let url = URL(string: "https://m.youtube.com/") else {
            return
        }

        webView.load(URLRequest(url: url))
    }

    func goBack() {
        guard webView.canGoBack else {
            return
        }

        webView.goBack()
    }

    func goForward() {
        guard webView.canGoForward else {
            return
        }

        webView.goForward()
    }

    func reload() {
        if webView.isLoading {
            webView.stopLoading()
        } else {
            webView.reload()
        }

        refreshState()
    }

    private func installLifecycleObservers() {
        let center = NotificationCenter.default

        lifecycleObservers = [
            center.addObserver(
                // PiP must be requested before the application enters the
                // background. Waiting for didEnterBackground is too late for
                // WebKit to present the native floating video window reliably.
                forName: UIApplication.willResignActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.notifyWebViewLifecycle("__ytproPrepareForBackground")
                }
            },
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.notifyWebViewLifecycle("__ytproDidEnterBackground")
                }
            },
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.restoreWebViewAfterForeground()
                }
            }
        ]
    }

    private func notifyWebViewLifecycle(_ functionName: String) {
        webView.evaluateJavaScript("window.\(functionName) && window.\(functionName)();")
    }

    private func notifyWebViewAppActive(_ isActive: Bool) {
        let value = isActive ? "true" : "false"
        webView.evaluateJavaScript("window.__ytproSetAppActive && window.__ytproSetAppActive(\(value));")

        guard isActive else {
            return
        }

        // The web content process may still be reconnecting its media layer
        // when didBecomeActive fires. Retry the idempotent bridge after layout
        // has settled so a missed first evaluation cannot leave audio-only
        // playback behind.
        for delay in [0.15, 0.6] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.webView.evaluateJavaScript(
                    "window.__ytproSetAppActive && window.__ytproSetAppActive(true);"
                )
            }
        }
    }

    private func restoreWebViewAfterForeground() {
        webView.isHidden = false
        webView.alpha = 1
        webView.setNeedsLayout()
        webView.layoutIfNeeded()
        webView.scrollView.setNeedsLayout()
        webView.scrollView.layoutIfNeeded()

        // A WebKit PiP/fullscreen transition can outlive the scene transition
        // and leave its out-of-window media layer attached to a stale surface.
        // Close that presentation first; the JS bridge then restores inline
        // playback and resumes only when playback was active before background.
        notifyWebViewLifecycle("__ytproPrepareForForeground")
        webView.closeAllMediaPresentations { [weak self] in
            self?.notifyWebViewAppActive(true)
        }
    }

    private func refreshState() {
        title = webView.title ?? ""
        canGoBack = webView.canGoBack
        canGoForward = webView.canGoForward
        isLoading = webView.isLoading
    }

    private static func loadUserScript() -> WKUserScript? {
        guard
            let url = Bundle.main.url(forResource: "ytpro-adblock", withExtension: "js"),
            let source = try? String(contentsOf: url, encoding: .utf8)
        else {
            return nil
        }

        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }
}

extension BrowserState: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        refreshState()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        refreshState()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        refreshState()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        refreshState()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        refreshState()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let scheme = navigationAction.request.url?.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }

        decisionHandler(["http", "https", "about"].contains(scheme) ? .allow : .cancel)
    }
}

extension BrowserState: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
        }

        return nil
    }
}
