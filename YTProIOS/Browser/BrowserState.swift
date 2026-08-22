import Combine
import UIKit
import WebKit
import os

@MainActor
final class BrowserState: NSObject, ObservableObject {
    @Published private(set) var title = ""
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false

    let webView: WKWebView

    /// Entry points of the injected lifecycle bridge.
    private enum Bridge {
        static let messageHandlerName = "ytpro"
        static let prepareForBackground = "__ytproPrepareForBackground"
        static let didEnterBackground = "__ytproDidEnterBackground"
        static let holdPlayback = "__ytproHoldPlayback"
        static let prepareForForeground = "__ytproPrepareForForeground"
        static let recoverAfterForeground = "__ytproRecoverAfterForeground"
        static let cancelBackgroundPreparation = "__ytproCancelBackgroundPreparation"
    }

    /// The web content process is frozen shortly after the app is suspended
    /// unless it is producing audio, so the bridge is nudged a few times while a
    /// background task keeps the app running.
    // The pings must outlast the window in which WebKit freezes the media
    // process; stopping too early let a late suspension kill playback.
    private static let backgroundHoldPingDelays: [TimeInterval] = [
        0.1, 0.35, 0.7, 1.2, 2, 2.8, 3.6, 4.5, 5.5, 6.5, 8, 10, 12, 14,
    ]
    private static let backgroundHoldDuration: TimeInterval = 15

    private static let log = Logger(subsystem: "com.ytpro.app", category: "browser")

    private var lifecycleObservers: [NSObjectProtocol] = []
    private var backgroundHoldWorkItems: [DispatchWorkItem] = []
    private var backgroundTaskIdentifier = UIBackgroundTaskIdentifier.invalid
    private var isPreparedForBackground = false
    private var hasEnteredBackground = false
    private var isPlaybackActive = false

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        configuration.websiteDataStore = .default()

        // The stock web view user agent omits the Version/Safari tokens, which
        // makes YouTube fall back to a player whose fullscreen and Picture in
        // Picture support differs between visits. Completing the agent pins the
        // app to the same player Safari gets.
        configuration.applicationNameForUserAgent = Self.safariUserAgentSuffix()

        if let script = Self.loadUserScript() {
            configuration.userContentController.addUserScript(script)
        }

        webView = WKWebView(frame: .zero, configuration: configuration)

        super.init()

        webView.configuration.userContentController.add(
            WeakScriptMessageHandler(wrapping: self),
            name: Bridge.messageHandlerName
        )
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

        // These are delivered synchronously on the main thread. Handing the
        // notification to a queue instead would postpone the Picture in Picture
        // request past the point where WebKit still accepts it.
        lifecycleObservers = [
            center.addObserver(
                forName: UIApplication.willResignActiveNotification,
                object: nil,
                queue: nil
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.applicationWillResignActive()
                }
            },
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: nil
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.applicationDidEnterBackground()
                }
            },
            center.addObserver(
                forName: UIApplication.willEnterForegroundNotification,
                object: nil,
                queue: nil
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.applicationWillEnterForeground()
                }
            },
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: nil
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.applicationDidBecomeActive()
                }
            }
        ]
    }

    private func applicationWillResignActive() {
        Self.log.info(
            "willResignActive, playbackActive: \(self.isPlaybackActive), \(AudioSessionController.shared.stateDescription, privacy: .public)"
        )
        isPreparedForBackground = true
        hasEnteredBackground = false

        // Only the category, never activation. WebKit plays in its own process
        // and holds its own client of the shared session; claiming it from here
        // arrives there as an interruption and pauses the video.
        AudioSessionController.shared.ensurePlaybackCategory()

        callBridge(Bridge.prepareForBackground)
    }

    private func applicationDidEnterBackground() {
        guard isPreparedForBackground else {
            return
        }

        Self.log.info(
            "didEnterBackground, playbackActive: \(self.isPlaybackActive), \(AudioSessionController.shared.stateDescription, privacy: .public)"
        )
        hasEnteredBackground = true
        callBridge(Bridge.didEnterBackground)

        // No `isPlaybackActive` gate here. That flag is a round trip behind the
        // web content, and skipping the hold because it had not caught up yet
        // let WebKit freeze the media process. The bridge decides for itself
        // whether there is anything to hold, from state it reads synchronously.
        beginBackgroundHold()
    }

    private func applicationWillEnterForeground() {
        Self.log.info("willEnterForeground")
        endBackgroundHold()
        callBridge(Bridge.prepareForForeground)
    }

    private func applicationDidBecomeActive() {
        endBackgroundHold()

        guard isPreparedForBackground else {
            return
        }

        isPreparedForBackground = false

        guard hasEnteredBackground else {
            // A banner, Control Center or the app switcher can deactivate the
            // app without ever backgrounding it.
            Self.log.info("didBecomeActive without backgrounding, cancelling preparation")
            callBridge(Bridge.cancelBackgroundPreparation)
            return
        }

        hasEnteredBackground = false

        // Exactly one restore per background trip: WebKit drops its media layer
        // and stops honouring fullscreen requests when presentation changes
        // overlap.
        Self.log.info(
            "recovering after foreground, playbackActive: \(self.isPlaybackActive), \(AudioSessionController.shared.stateDescription, privacy: .public)"
        )

        callBridge(Bridge.recoverAfterForeground)
    }

    private func beginBackgroundHold() {
        if backgroundTaskIdentifier == .invalid {
            backgroundTaskIdentifier = UIApplication.shared.beginBackgroundTask(
                withName: "ytpro.background-playback"
            ) { [weak self] in
                Task { @MainActor in
                    Self.log.info("background hold expired by the system")
                    self?.endBackgroundHold()
                }
            }
        }

        // The audio background mode reports an unbounded budget, which prints as
        // a 300-digit number and buries the line it belongs to.
        let timeRemaining = UIApplication.shared.backgroundTimeRemaining
        let budget = timeRemaining > 86_400 ? "unlimited" : String(format: "%.1fs", timeRemaining)

        Self.log.info("background hold started, timeRemaining: \(budget, privacy: .public)")

        for delay in Self.backgroundHoldPingDelays {
            scheduleBackgroundHoldWorkItem(after: delay) { state in
                state.callBridge(Bridge.holdPlayback)
            }
        }

        scheduleBackgroundHoldWorkItem(after: Self.backgroundHoldDuration) { state in
            state.endBackgroundHold()
        }
    }

    private func scheduleBackgroundHoldWorkItem(
        after delay: TimeInterval,
        work: @escaping (BrowserState) -> Void
    ) {
        let workItem = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else {
                    return
                }

                work(self)
            }
        }

        backgroundHoldWorkItems.append(workItem)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func endBackgroundHold() {
        backgroundHoldWorkItems.forEach { $0.cancel() }
        backgroundHoldWorkItems.removeAll()

        guard backgroundTaskIdentifier != .invalid else {
            return
        }

        UIApplication.shared.endBackgroundTask(backgroundTaskIdentifier)
        backgroundTaskIdentifier = .invalid
        Self.log.info("background hold ended")
    }

    private func callBridge(_ functionName: String) {
        Self.log.debug("bridge → \(functionName, privacy: .public)")
        webView.evaluateJavaScript("window.\(functionName) && window.\(functionName)();") { result, error in
            if let error {
                Self.log.error("bridge \(functionName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            }
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

    /// The tokens Safari appends to the shared WebKit user agent.
    private static func safariUserAgentSuffix() -> String {
        let components = UIDevice.current.systemVersion.split(separator: ".")
        let major = components.first.map(String.init) ?? "17"
        let minor = components.dropFirst().first.map(String.init) ?? "0"

        return "Version/\(major).\(minor) Safari/604.1"
    }
}

extension BrowserState: WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard
            message.name == Bridge.messageHandlerName,
            let payload = message.body as? [String: Any]
        else {
            return
        }

        switch payload["type"] as? String {
        case "playback":
            handlePlaybackReport(payload)
        case "log":
            Self.log.info("web: \(payload["message"] as? String ?? "", privacy: .public)")
        default:
            break
        }
    }

    private func handlePlaybackReport(_ payload: [String: Any]) {
        let isPlaying = payload["playing"] as? Bool ?? false

        guard isPlaying != isPlaybackActive else {
            return
        }

        isPlaybackActive = isPlaying
        Self.log.info("playback report from web, playing: \(isPlaying)")

        // No audio session work here. WebKit activates the session from its own
        // process when playback starts; a claim from this process interrupts
        // it, and the pause that follows produces another report, which used to
        // claim it again — a loop that only ended when the page was reloaded.
    }
}

extension BrowserState: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        refreshState()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // A new document drops the injected bridge along with everything it
        // knew about the previous player.
        isPlaybackActive = false
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

/// `WKUserContentController` retains its message handlers, which would otherwise
/// keep the state that owns the web view alive forever.
@MainActor
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(wrapping target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
