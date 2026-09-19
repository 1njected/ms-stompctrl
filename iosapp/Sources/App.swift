// MS StompCtrl for iOS: the browser client, with an ExternalAccessory transport
// underneath it instead of Web Serial.

import SwiftUI

struct HostView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebHost { WebHost() }
    func updateUIViewController(_ controller: WebHost, context: Context) {}
}

@main
struct StompCtrlApp: App {
    var body: some Scene {
        WindowGroup { HostView().ignoresSafeArea(edges: .bottom) }
    }
}
