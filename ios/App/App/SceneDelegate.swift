import SwiftUI
import UIKit
import UserNotifications

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIHostingController(rootView: NativeRootView())
        // Tapping anywhere closes the keyboard. Touches still reach whatever was tapped.
        let dismissKeyboard = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        dismissKeyboard.cancelsTouchesInView = false
        dismissKeyboard.delegate = self
        window.addGestureRecognizer(dismissKeyboard)
        self.window = window
        window.makeKeyAndVisible()
        if let response = connectionOptions.notificationResponse,
           let orderID = DeliveryNotificationPayload.orderID(from: response.notification.request.content.userInfo) {
            Task { @MainActor in
                DeliveryNotificationRouter.shared.open(orderID)
            }
        }
    }
}

extension SceneDelegate: UIGestureRecognizerDelegate {
    @objc private func dismissKeyboard() {
        window?.endEditing(true)
    }

    // Taps on a text field (or inside one) move focus instead of closing the keyboard.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let current = view {
            if current is UITextField || current is UITextView { return false }
            view = current.superview
        }
        return true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }
}
