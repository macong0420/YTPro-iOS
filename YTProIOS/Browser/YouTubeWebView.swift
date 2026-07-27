import SwiftUI
import WebKit

struct YouTubeWebView: UIViewRepresentable {
    let browser: BrowserState

    func makeUIView(context: Context) -> WKWebView {
        browser.webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
    }
}
