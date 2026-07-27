import SwiftUI

struct ContentView: View {
    @StateObject private var browser = BrowserState()

    var body: some View {
        NavigationStack {
            YouTubeWebView(browser: browser)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(browser.title.isEmpty ? "YTPro" : browser.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItemGroup(placement: .topBarLeading) {
                        Button {
                            browser.goBack()
                        } label: {
                            Image(systemName: "chevron.left")
                        }
                        .disabled(!browser.canGoBack)
                        .accessibilityLabel("Back")

                        Button {
                            browser.goForward()
                        } label: {
                            Image(systemName: "chevron.right")
                        }
                        .disabled(!browser.canGoForward)
                        .accessibilityLabel("Forward")
                    }

                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button {
                            browser.loadHome()
                        } label: {
                            Image(systemName: "house")
                        }
                        .accessibilityLabel("Home")

                        Button {
                            browser.reload()
                        } label: {
                            Image(systemName: browser.isLoading ? "xmark" : "arrow.clockwise")
                        }
                        .accessibilityLabel(browser.isLoading ? "Stop" : "Reload")
                    }
                }
        }
    }
}

#Preview {
    ContentView()
}
