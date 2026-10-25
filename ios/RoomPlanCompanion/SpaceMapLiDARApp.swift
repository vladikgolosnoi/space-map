import SwiftUI
import WebKit
import UIKit
import Combine

@main
struct SpaceMapLiDARApp: App {
    var body: some Scene {
        WindowGroup {
            TabView {
                SpaceMapWebScreen()
                    .tabItem { Label("Карта", systemImage: "map") }
                RoomPlanScannerView()
                    .tabItem { Label("LiDAR", systemImage: "viewfinder") }
            }
            .tint(Color(red: 0.90, green: 0.15, blue: 0.07))
        }
    }
}

private struct SharedExport: Identifiable {
    let id = UUID()
    let url: URL
}

private struct SpaceMapWebScreen: View {
    @StateObject private var session = SpaceMapWebSession()
    @State private var confirmReload = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if session.loading { ProgressView().padding(5) }
                if let error = session.errorMessage {
                    ContentUnavailableView {
                        Label("Не удалось открыть карту", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Повторить") { session.loadHome() }
                    }
                } else {
                    SpaceMapWebView(session: session)
                }
            }
            .navigationTitle("Карта пространства")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { session.webView.goBack() } label: { Image(systemName: "chevron.left") }
                        .disabled(!session.canGoBack)
                        .accessibilityLabel("Назад")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { confirmReload = true } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Обновить карту")
                }
            }
            .confirmationDialog("Обновить карту? Несохранённые изменения редактора будут потеряны.", isPresented: $confirmReload, titleVisibility: .visible) {
                Button("Обновить", role: .destructive) { session.loadHome() }
            }
            .sheet(item: $session.sharedExport) { file in
                NativeExportSheet(url: file.url)
            }
        }
    }
}

private struct SpaceMapWebView: UIViewRepresentable {
    let session: SpaceMapWebSession
    func makeUIView(context: Context) -> WKWebView { session.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

private struct NativeExportSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private final class SpaceMapWebSession: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    @Published var loading = true
    @Published var canGoBack = false
    @Published var errorMessage: String?
    @Published var sharedExport: SharedExport?
    let webView: WKWebView
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]
    private let home = URL(string: "https://vladikgolosnoi.ru/map/demo")!

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "SpaceMapNative/iOS"
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        loadHome()
    }

    func loadHome() {
        errorMessage = nil
        loading = true
        webView.load(URLRequest(url: home))
    }

    private func isOwnURL(_ url: URL) -> Bool {
        (url.scheme == "https" && url.host == home.host && (url.port == nil || url.port == 443)) ||
        url.absoluteString.hasPrefix("blob:https://vladikgolosnoi.ru/")
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, isOwnURL(url) else {
            if action.targetFrame?.isMainFrame != false, let url = action.request.url, url.scheme == "https" {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(action.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, isOwnURL(url) { webView.load(action.request) }
        return nil
    }

    private func showJavaScriptDialog(_ message: String, confirm: Bool, completion: @escaping (Bool) -> Void) {
        guard var presenter = webView.window?.rootViewController else { completion(false); return }
        while let presented = presenter.presentedViewController { presenter = presented }
        let alert = UIAlertController(title: "Карта пространства", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: confirm ? "Продолжить" : "Понятно", style: .default) { _ in completion(true) })
        if confirm { alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completion(false) }) }
        presenter.present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        showJavaScriptDialog(message, confirm: true, completion: completionHandler)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        showJavaScriptDialog(message, confirm: false) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loading = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false
        errorMessage = nil
        canGoBack = webView.canGoBack
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        loading = false
        errorMessage = "Проверьте интернет и повторите загрузку. \(error.localizedDescription)"
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self; loading = false }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self; loading = false }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let destination = directory.appendingPathComponent((suggestedFilename as NSString).lastPathComponent)
            downloadDestinations[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        } catch { completionHandler(nil); failed(error) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) {
            sharedExport = SharedExport(url: url)
        }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        failed(error)
    }
}
