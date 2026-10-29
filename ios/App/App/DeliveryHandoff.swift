import AVFoundation
import CoreImage.CIFilterBuiltins
import MultipeerConnectivity
import NearbyInteraction
import SwiftUI

private enum HandoffCode {
    static func make(orderID: UUID, token: String) -> String {
        "WILDCATEATS:\(orderID.uuidString):\(token)"
    }

    static func token(from value: String, for orderID: UUID) -> String? {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "WILDCATEATS",
              UUID(uuidString: String(parts[1])) == orderID,
              parts[2].count == 64,
              parts[2].allSatisfy({ $0.isHexDigit }) else { return nil }
        return String(parts[2])
    }
}

private struct HandoffQRCode: View {
    let value: String

    var body: some View {
        Group {
            if let image = makeImage() {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel("One-time delivery handoff QR code")
            } else {
                Text("QR code unavailable")
            }
        }
    }

    private func makeImage() -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

struct HandoffRecipientView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var nearby = HandoffNearbySession()
    @State private var mode: HandoffRunnerMode = .tap
    @State private var token: String?
    @State private var error: String?
    @State private var isLoading = false
    @State private var isCompleted = false
    let order: Order
    let onComplete: (() -> Void)?

    init(order: Order, onComplete: (() -> Void)? = nil) {
        self.order = order
        self.onComplete = onComplete
    }

    var body: some View {
        ZStack {
            Color("NovaDashIvory").ignoresSafeArea()
            HandoffCanvas {
                ZStack(alignment: .topLeading) {
                    handoffModePicker

                    if mode == .tap {
                        Image("NovaDashHandoffWaves")
                            .resizable()
                            .frame(width: 95, height: 95)
                            .offset(x: 153, y: 161)
                            .transition(.novaDashSlide(.leading))
                    } else {
                        qrCode.offset(x: 125, y: 171)
                            .transition(.novaDashSlide(.trailing))
                    }

                    handoffCopy
                    handoffProgress

                    if mode == .qr {
                        recipientTabBar
                            .transition(.novaDashSlide(.bottom))
                    }
                }
                .animation(.novaDashSlide, value: mode)
            }
        }
        .navigationBarBackButtonHidden(true)
        .navigationBarHidden(true)
        .task { await load() }
        .task(id: token) {
            guard token != nil else { return }
            while !Task.isCancelled && !isCompleted {
                if let orders = try? await model.client.myOrders(),
                   orders.first(where: { $0.id == order.id })?.status == "delivered" {
                    isCompleted = true
                    nearby.stop()
                    finish()
                    break
                }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
        .onDisappear { nearby.stop() }
        .preferredColorScheme(.light)
    }

    private var handoffModePicker: some View {
        ZStack(alignment: .topLeading) {
            Capsule()
                .fill(Color("NovaDashNavy"))
                .frame(width: 291, height: 54)

            Capsule()
                .fill(Color("NovaDashIvory"))
                .frame(width: 139, height: 42)
                .offset(x: mode == .tap ? 7 : 146, y: 6)

            handoffModeButton(title: "Tap", value: .tap)
                .offset(x: 7)
            handoffModeButton(title: "QR Code", value: .qr)
                .offset(x: 146)
        }
        .frame(width: 291, height: 54)
        .offset(x: 55, y: 81)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Customer handoff method")
    }

    private func handoffModeButton(title: String, value: HandoffRunnerMode) -> some View {
        Button {
            mode = value
        } label: {
            Text(title)
                .font(.custom("Inter-Regular", size: 20.828))
                .foregroundColor(mode == value ? Color("NovaDashNavy") : Color("NovaDashIvory"))
                .frame(width: 139, height: 54)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var qrCode: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 9)
                .stroke(Color("NovaDashNavy"), lineWidth: 2)
            if let token {
                HandoffQRCode(value: HandoffCode.make(orderID: order.id, token: token))
                    .padding(10)
            } else if isLoading {
                ProgressView().tint(Color("NovaDashNavy"))
            }
        }
        .frame(width: 152, height: 152)
        .accessibilityLabel("One-time delivery handoff QR code")
    }

    private var handoffCopy: some View {
        let verticalShift: CGFloat = mode == .tap ? 0 : 62
        return Group {
            Text("Your Order has been\naccepted!")
                .font(.custom("Georgia-BoldItalic", size: 27.892))
                .tracking(1.3946)
                .foregroundColor(Color("NovaDashNavy"))
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 330, alignment: .leading)
                .offset(x: 37, y: 283 + verticalShift)

            Text("Tap your phone to the dasher’s when you receive the order")
                .font(.custom("Inter-SemiBold", size: 23.25))
                .foregroundColor(Color("NovaDashNavy"))
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 239.063, alignment: .leading)
                .offset(x: 37, y: 365.96 + verticalShift)

            Text("Or use qr code")
                .font(.custom("Inter-SemiBold", size: 23.25))
                .foregroundColor(Color("NovaDashNavy"))
                .offset(x: 37, y: 469 + verticalShift)

            Image("NovaDashHandoffMascot")
                .resizable()
                .scaledToFit()
                .frame(width: 104, height: 95.043)
                .offset(x: 32, y: 524 + verticalShift)
        }
    }

    private var handoffProgress: some View {
        let verticalShift: CGFloat = mode == .tap ? 0 : 62
        return Group {
            Capsule()
                .stroke(Color("NovaDashNavy"), lineWidth: 2)
                .frame(width: 333, height: 8)
                .offset(x: 37, y: 635 + verticalShift)

            Image("NovaDashHandoffProgress")
                .resizable()
                .frame(width: 131, height: 4)
                .offset(x: 39, y: 637 + verticalShift)

            Text("Your food is on the way!")
                .font(.custom("Inter-Regular", size: 9.613))
                .italic()
                .foregroundColor(.black)
                .offset(x: 37, y: 654 + verticalShift)

            Image("NovaDashLocation")
                .frame(width: 16, height: 20)
                .offset(x: 349, y: 597 + verticalShift)

            if let error {
                VStack(alignment: .leading, spacing: 4) {
                    Text(error)
                        .font(.custom("Inter-Regular", size: 11))
                        .foregroundColor(.red)
                    Button("Try again") { Task { await load() } }
                        .font(.custom("Inter-Medium", size: 12))
                        .foregroundColor(Color("NovaDashNavy"))
                }
                .frame(width: 300, alignment: .leading)
                .offset(x: 37, y: 680 + verticalShift)
            }
        }
    }

    private var recipientTabBar: some View {
        ZStack(alignment: .topLeading) {
            Capsule()
                .fill(Color("NovaDashNavy"))
                .frame(width: 305, height: 77)

            Capsule()
                .fill(Color("NovaDashIvory"))
                .overlay(Capsule().stroke(Color("NovaDashNavy"), lineWidth: 2))
                .frame(width: 107, height: 77)

            recipientTabButton(index: 0, label: "Order")
                .offset(x: 0)
            recipientTabButton(index: 1, label: "Deliver")
                .offset(x: 101.667)
            recipientTabButton(index: 2, label: "Account")
                .offset(x: 203.333)

            Image(systemName: "cart")
                .font(.system(size: 28, weight: .light))
                .foregroundColor(Color("NovaDashNavy"))
                .frame(width: 30, height: 30)
                .offset(x: 38, y: 24)
                .allowsHitTesting(false)

            Image("NovaDashScooterInner")
                .renderingMode(.template)
                .resizable()
                .foregroundColor(Color("NovaDashIvory"))
                .frame(width: 44.95, height: 35.187)
                .offset(x: 130.7, y: 20.8)
                .allowsHitTesting(false)

            Image("NovaDashAccount")
                .resizable()
                .frame(width: 23, height: 28)
                .offset(x: 241, y: 25)
                .allowsHitTesting(false)
        }
        .frame(width: 305, height: 77)
        // Same spot as the app's main bottom menu, so it lines up exactly.
        .offset(x: 49, y: 772)
    }

    private func recipientTabButton(index: Int, label: String) -> some View {
        Button {
            NotificationCenter.default.post(name: .novaDashSelectTab, object: index)
            finish()
        } label: {
            Rectangle()
                .fill(Color.white.opacity(0.001))
                .frame(width: 101.667, height: 77)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .zIndex(10)
    }

    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        error = nil
        isCompleted = false
        nearby.stop()
        do {
            let nextToken = try await model.client.startHandoff(for: order.id)
            token = nextToken
            nearby.startRecipient(orderID: order.id, token: nextToken)
        } catch {
            token = nil
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func finish() {
        if let onComplete { onComplete() } else { dismiss() }
    }
}

enum HandoffRunnerMode {
    case tap
    case qr
}

struct HandoffRunnerView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var nearby = HandoffNearbySession()
    @State private var mode: HandoffRunnerMode
    @State private var isCompleting = false
    @State private var isCancelling = false
    @State private var isConfirmed = false
    @State private var showPayout = false
    @State private var error: String?
    let order: Order
    let onCancelled: () -> Void
    let onComplete: () -> Void

    private static let confirmedGreen = Color(red: 0.18, green: 0.62, blue: 0.36)
    private static let cancellationGracePeriod: TimeInterval = 30

    init(
        order: Order,
        initialMode: HandoffRunnerMode = .tap,
        onCancelled: @escaping () -> Void,
        onComplete: @escaping () -> Void
    ) {
        self.order = order
        self.onCancelled = onCancelled
        self.onComplete = onComplete
        _mode = State(initialValue: initialMode)
    }

    var body: some View {
        ZStack {
            Color("NovaDashIvory").ignoresSafeArea()
            HandoffCanvas {
                ZStack(alignment: .topLeading) {
                    handoffModePicker

                    if mode == .tap {
                        Image("NovaDashHandoffWaves")
                            .resizable()
                            .frame(width: 95, height: 95)
                            .offset(x: 153, y: 155)
                            .transition(.novaDashSlide(.leading))
                    } else {
                        qrScanner
                            .offset(x: 125, y: 207)
                            .transition(.novaDashSlide(.trailing))
                    }

                    delivererPanel
                        .animation(.novaDashSlide, value: mode)

                    cancellationGraceControl

                    if isCompleting {
                        ZStack {
                            Color("NovaDashIvory").opacity(0.88)
                            ProgressView()
                                .tint(Color("NovaDashNavy"))
                                .scaleEffect(1.25)
                        }
                        .frame(width: 402, height: 874)
                    }
                }
            }

            if showPayout {
                HandoffPayoutView(amount: order.runnerPayout, onDone: onComplete)
                    .transition(.novaDashSlide(.bottom))
            }
        }
        .onReceive(nearby.$receivedTapToken.compactMap { $0 }) { token in
            guard mode == .tap else { return }
            complete(token: token, method: "tap")
        }
        .onAppear { startTapIfNeeded() }
        .onChange(of: mode) { _ in startTapIfNeeded() }
        .onDisappear { nearby.stop() }
        .preferredColorScheme(.light)
    }

    @ViewBuilder private var cancellationGraceControl: some View {
        if let claimedAt = order.claimedAt {
            let deadline = claimedAt.addingTimeInterval(Self.cancellationGracePeriod)
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                let remaining = max(0, deadline.timeIntervalSince(timeline.date))
                let progress = CGFloat(remaining / Self.cancellationGracePeriod)

                if remaining > 0 {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle()
                                .stroke(Color("NovaDashIvory").opacity(0.28), lineWidth: 5)
                            Circle()
                                .trim(from: 0, to: progress)
                                .stroke(
                                    Color("NovaDashIvory"),
                                    style: StrokeStyle(lineWidth: 5, lineCap: .round)
                                )
                                .rotationEffect(.degrees(-90))
                            Text("\(max(1, Int(ceil(remaining))))")
                                .font(.custom("Inter-SemiBold", size: 17))
                                .foregroundColor(Color("NovaDashIvory"))
                                .monospacedDigit()
                        }
                        .frame(width: 54, height: 54)
                        .accessibilityLabel("\(max(1, Int(ceil(remaining)))) seconds remaining to cancel")

                        Button {
                            Task { await cancelDuringGracePeriod() }
                        } label: {
                            Group {
                                if isCancelling {
                                    ProgressView().tint(Color("NovaDashNavy"))
                                } else {
                                    Text("Cancel Order")
                                        .font(.custom("Inter-SemiBold", size: 19))
                                        .foregroundColor(Color("NovaDashNavy"))
                                }
                            }
                            .frame(width: 220, height: 54)
                            .background(Color("NovaDashIvory"))
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(isCancelling)
                    }
                    .frame(width: 288, height: 54, alignment: .leading)
                    .offset(x: 57, y: 780)
                    .transition(.opacity)
                }
            }
        }
    }

    private var handoffModePicker: some View {
        ZStack(alignment: .topLeading) {
            Capsule()
                .fill(Color("NovaDashNavy"))
                .frame(width: 291, height: 54)

            Capsule()
                .fill(Color("NovaDashIvory"))
                .frame(width: 139, height: 42)
                .offset(x: mode == .tap ? 7 : 146, y: 6)

            Button {
                error = nil
                mode = .tap
            } label: {
                Text("Tap")
                    .font(.custom("Inter-Medium", size: 20.828))
                    .foregroundColor(mode == .tap ? Color("NovaDashNavy") : Color("NovaDashIvory"))
                    .frame(width: 139, height: 54)
            }
            .buttonStyle(.plain)
            .offset(x: 7)

            Button {
                error = nil
                mode = .qr
            } label: {
                Text("QR Code")
                    .font(.custom("Inter-Medium", size: 20.828))
                    .foregroundColor(mode == .qr ? Color("NovaDashNavy") : Color("NovaDashIvory"))
                    .frame(width: 139, height: 54)
            }
            .buttonStyle(.plain)
            .offset(x: 146)
        }
        .frame(width: 291, height: 54)
        .offset(x: 55, y: 81)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Delivery handoff method")
    }

    private var qrScanner: some View {
        HandoffQRScanner { value in
            guard !isCompleting, !isConfirmed else { return }
            guard let token = HandoffCode.token(from: value, for: order.id) else {
                error = "This QR code is not for this delivery."
                return
            }
            complete(token: token, method: "qr")
        }
        .frame(width: 152, height: 152)
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay {
            RoundedRectangle(cornerRadius: 9)
                .stroke(isConfirmed ? Self.confirmedGreen : Color("NovaDashNavy"), lineWidth: isConfirmed ? 6 : 2)
        }
        .accessibilityLabel(isConfirmed ? "QR code confirmed" : "Camera scanning the recipient QR code")
    }

    private var delivererPanel: some View {
        let panelTop: CGFloat = mode == .tap ? 270 : 437
        let headingTop: CGFloat = mode == .tap ? 310 : 477
        let firstInstructionTop: CGFloat = mode == .tap ? 393 : 560
        let secondInstructionTop: CGFloat = mode == .tap ? 507 : 674
        let errorTop: CGFloat = mode == .tap ? 610 : 748

        return Group {
            HandoffTopCorners(radius: 35)
                .fill(Color("NovaDashNavy"))
                .frame(width: 402, height: 637)
                .offset(y: panelTop)

            Text("Thanks for accepting\nthe order!")
                .font(.custom("Georgia-BoldItalic", size: 27.892))
                .tracking(1.3946)
                .foregroundColor(Color("NovaDashIvory"))
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 330, alignment: .leading)
                .offset(x: 37, y: headingTop)

            Text("Tap your phone to\nthe customer’s\nphone when you\ndeliver the order,")
                .font(.custom("Inter-SemiBold", size: 23.25))
                .foregroundColor(Color("NovaDashIvory"))
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 239, alignment: .leading)
                .offset(x: 37, y: firstInstructionTop)

            Text("or scan the\ncustomer’s qr code\nto confirm delivery.")
                .font(.custom("Inter-SemiBold", size: 23.25))
                .foregroundColor(Color("NovaDashIvory"))
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 239, alignment: .leading)
                .offset(x: 37, y: secondInstructionTop)

            if let error {
                Text(error)
                    .font(.custom("Inter-Regular", size: 11))
                    .foregroundColor(.red)
                    .lineLimit(2)
                    .frame(width: 328, alignment: .leading)
                    .offset(x: 37, y: errorTop)
            }
        }
    }

    private func startTapIfNeeded() {
        nearby.stop()
        if mode == .tap && !isCompleting {
            nearby.startRunner(orderID: order.id)
        }
    }

    private func cancelDuringGracePeriod() async {
        guard !isCancelling else { return }
        isCancelling = true
        error = nil
        do {
            try await model.client.releaseDelivery(order.id)
            nearby.stop()
            onCancelled()
        } catch {
            self.error = error.localizedDescription
        }
        isCancelling = false
    }

    private func complete(token: String, method: String) {
        guard !isCompleting, !isConfirmed else { return }
        isCompleting = true
        error = nil
        let haptics = UINotificationFeedbackGenerator()
        haptics.prepare()
        Task {
            do {
                try await model.client.completeHandoff(for: order.id, token: token, method: method)
                nearby.stop()
                isCompleting = false
                haptics.notificationOccurred(.success)
                withAnimation(.easeOut(duration: 0.25)) { isConfirmed = true }
                // The server credits the payout on delivery; pick it up while the
                // green confirmation registers.
                async let balance: Void = model.loadTestBalance()
                async let earnings: Void = model.loadPaymentStatus()
                try? await Task.sleep(nanoseconds: 900_000_000)
                await balance
                await earnings
                withAnimation(.novaDashSlide) { showPayout = true }
            } catch {
                self.error = error.localizedDescription
                if method == "tap" { nearby.receivedTapToken = nil }
                isCompleting = false
                haptics.notificationOccurred(.error)
            }
        }
    }
}

private struct HandoffCanvas<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        GeometryReader { geometry in
            let scale = geometry.size.width / 402
            content
                .frame(width: 402, height: 874, alignment: .topLeading)
                .scaleEffect(scale, anchor: .topLeading)
        }
        .ignoresSafeArea()
    }
}

private struct HandoffTopCorners: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        Path(UIBezierPath(
            roundedRect: rect,
            byRoundingCorners: [.topLeft, .topRight],
            cornerRadii: CGSize(width: radius, height: radius)
        ).cgPath)
    }
}

private struct HandoffPayoutView: View {
    let amount: Double
    let onDone: () -> Void
    @State private var progress: CGFloat = 0

    private var amountText: String { String(format: "$%.2f", amount) }

    var body: some View {
        ZStack {
            Color("NovaDashIvory").ignoresSafeArea()
            HandoffCanvas {
                ZStack(alignment: .topLeading) {
                    Text("Delivery complete!")
                        .font(.custom("Georgia-BoldItalic", size: 27.892))
                        .tracking(1.3946)
                        .foregroundColor(Color("NovaDashNavy"))
                        .offset(x: 37, y: 277)

                    Text("Sending you \(amountText) payout now")
                        .font(.custom("Inter-SemiBold", size: 23.25))
                        .foregroundColor(Color("NovaDashNavy"))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: 260, alignment: .leading)
                        .offset(x: 37, y: 337.96)

                    Image("NovaDashHandoffMascot")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 104, height: 95.043)
                        .offset(x: 32, y: 454)

                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 23, weight: .medium))
                        .foregroundColor(Color(red: 0.18, green: 0.62, blue: 0.36))
                        .frame(width: 24, height: 24)
                        .offset(x: 345, y: 525)

                    Capsule()
                        .stroke(Color("NovaDashNavy"), lineWidth: 2)
                        .frame(width: 333, height: 8)
                        .offset(x: 37, y: 565)

                    Capsule()
                        .fill(Color("NovaDashNavy"))
                        .frame(width: 329 * progress, height: 4)
                        .offset(x: 39, y: 567)

                    Text("Your payout is on its way")
                        .font(.custom("Inter-Regular", size: 9.613))
                        .italic()
                        .foregroundColor(.black)
                        .offset(x: 37, y: 584)

                    Button(action: onDone) {
                        Text("done")
                            .font(.custom("Inter-Medium", size: 20.282))
                            .foregroundColor(Color("NovaDashIvory"))
                            .frame(width: 160, height: 48)
                            .background(Capsule().fill(Color("NovaDashNavy")))
                    }
                    .buttonStyle(.plain)
                    .offset(x: 121, y: 664)
                }
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.6)) { progress = 1 }
        }
    }
}

private struct HandoffQRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
}

private final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let capture = AVCaptureSession()
    private let captureQueue = DispatchQueue(label: "com.wildcateats.handoff.camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var permissionLabel: UILabel?
    private var didScan = false
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(named: "NovaDashIvory")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else {
            captureQueue.async {
                if !self.capture.isRunning { self.capture.startRunning() }
            }
            return
        }
        started = true
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
                DispatchQueue.main.async { if allowed { self?.configure() } else { self?.showPermissionMessage() } }
            }
        default: showPermissionMessage()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureQueue.async { self.capture.stopRunning() }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              capture.canAddInput(input) else {
            showPermissionMessage()
            return
        }
        capture.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard capture.canAddOutput(output) else { showPermissionMessage(); return }
        capture.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
        let layer = AVCaptureVideoPreviewLayer(session: capture)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        captureQueue.async { self.capture.startRunning() }
    }

    private func showPermissionMessage() {
        permissionLabel?.removeFromSuperview()
        let label = UILabel(frame: view.bounds.insetBy(dx: 12, dy: 12))
        label.text = "Camera access is needed. Enable it in Settings, or use Tap."
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = UIFont(name: "Inter-Medium", size: 12) ?? .systemFont(ofSize: 12, weight: .medium)
        label.textColor = UIColor(named: "NovaDashNavy")
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
        permissionLabel = label
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !didScan, let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        didScan = true
        onCode?(code)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.didScan = false
        }
    }
}

private struct NearbyMessage: Codable {
    let kind: String
    let data: Data?
    let token: String?
}

final class HandoffNearbySession: NSObject, ObservableObject {
    @Published var status = "Looking for the other iPhone…"
    @Published var receivedTapToken: String?

    private enum Role { case recipient, runner }
    private let serviceType = "wce-handoff"
    private var role: Role?
    private var orderID: UUID?
    private var token: String?
    private var peer: MCPeerID?
    private var connection: MCSession?
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    private var ranging: NISession?
    private var closeSamples = 0
    private var closeAt: Date?
    private var pendingToken: String?
    private var sentToken = false

    private var supportsTap: Bool {
        if #available(iOS 16, *) { return NISession.deviceCapabilities.supportsPreciseDistanceMeasurement }
        return NISession.isSupported
    }

    func startRecipient(orderID: UUID, token: String) {
        start(orderID: orderID, role: .recipient, token: token)
    }

    func startRunner(orderID: UUID) {
        start(orderID: orderID, role: .runner, token: nil)
    }

    private func start(orderID: UUID, role: Role, token: String?) {
        stop()
        self.orderID = orderID
        self.role = role
        self.token = token
        guard supportsTap else {
            status = "Tap is unavailable on this iPhone. Use the QR code instead."
            return
        }
        let peer = MCPeerID(displayName: "Wildcat Eats")
        self.peer = peer
        let connection = MCSession(peer: peer, securityIdentity: nil, encryptionPreference: .required)
        connection.delegate = self
        self.connection = connection
        let ranging = NISession()
        ranging.delegate = self
        ranging.delegateQueue = .main
        self.ranging = ranging
        if role == .recipient {
            let advertiser = MCNearbyServiceAdvertiser(
                peer: peer, discoveryInfo: ["order": orderID.uuidString], serviceType: serviceType
            )
            advertiser.delegate = self
            self.advertiser = advertiser
            advertiser.startAdvertisingPeer()
            status = "Ready to tap phones. QR is also available below."
        } else {
            let browser = MCNearbyServiceBrowser(peer: peer, serviceType: serviceType)
            browser.delegate = self
            self.browser = browser
            browser.startBrowsingForPeers()
            status = "Looking for the recipient's iPhone…"
        }
    }

    func stop() {
        browser?.stopBrowsingForPeers()
        advertiser?.stopAdvertisingPeer()
        connection?.disconnect()
        ranging?.delegate = nil
        ranging?.invalidate()
        browser = nil
        advertiser = nil
        connection = nil
        ranging = nil
        peer = nil
        role = nil
        token = nil
        orderID = nil
        pendingToken = nil
        receivedTapToken = nil
        closeAt = nil
        closeSamples = 0
        sentToken = false
    }

    private func send(_ message: NearbyMessage) {
        guard let connection, !connection.connectedPeers.isEmpty,
              let data = try? JSONEncoder().encode(message) else { return }
        try? connection.send(data, toPeers: [connection.connectedPeers[0]], with: .reliable)
    }

    private func shareDiscoveryToken() {
        guard let discoveryToken = ranging?.discoveryToken,
              let data = try? NSKeyedArchiver.archivedData(withRootObject: discoveryToken, requiringSecureCoding: true) else { return }
        send(NearbyMessage(kind: "discovery", data: data, token: nil))
    }

    private func checkTap() {
        guard let closeAt, Date().timeIntervalSince(closeAt) < 4 else { return }
        if role == .recipient, !sentToken, let token {
            sentToken = true
            send(NearbyMessage(kind: "handoff", data: nil, token: token))
            status = "Phones touched. Waiting for delivery confirmation…"
        } else if role == .runner, let pendingToken {
            receivedTapToken = pendingToken
            self.pendingToken = nil
            status = "Tap verified. Completing delivery…"
        }
    }
}

extension HandoffNearbySession: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        DispatchQueue.main.async {
            guard self.role == .runner, info?["order"] == self.orderID?.uuidString,
                  let connection = self.connection, connection.connectedPeers.isEmpty else { return }
            browser.invitePeer(peerID, to: connection, withContext: Data((self.orderID?.uuidString ?? "").utf8), timeout: 20)
            self.status = "Connecting to recipient…"
        }
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {}
    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        DispatchQueue.main.async { self.status = "Nearby connection failed. Use the QR code instead." }
    }
}

extension HandoffNearbySession: MCNearbyServiceAdvertiserDelegate {
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID,
                    withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        DispatchQueue.main.async {
            let matches = String(data: context ?? Data(), encoding: .utf8) == self.orderID?.uuidString
            let available = self.role == .recipient && self.connection?.connectedPeers.isEmpty == true
            invitationHandler(matches && available, matches && available ? self.connection : nil)
        }
    }

    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        DispatchQueue.main.async { self.status = "Nearby connection failed. Show the QR code instead." }
    }
}

extension HandoffNearbySession: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        DispatchQueue.main.async {
            if state == .connected {
                self.browser?.stopBrowsingForPeers()
                self.advertiser?.stopAdvertisingPeer()
                self.status = "Connected. Hold the phones together…"
                self.shareDiscoveryToken()
            } else if state == .notConnected && self.role != nil {
                self.status = "Connection lost. Bring phones together or use QR."
                self.closeAt = nil
                self.closeSamples = 0
            }
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        DispatchQueue.main.async {
            guard self.connection === session,
                  let message = try? JSONDecoder().decode(NearbyMessage.self, from: data) else { return }
            if message.kind == "discovery", let data = message.data,
               let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self, from: data) {
                self.ranging?.run(NINearbyPeerConfiguration(peerToken: token))
            } else if message.kind == "handoff", self.role == .runner,
                      let token = message.token, token.count == 64,
                      token.allSatisfy({ $0.isHexDigit }) {
                self.pendingToken = token
                self.checkTap()
            }
        }
    }

    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

extension HandoffNearbySession: NISessionDelegate {
    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard ranging === session, let distance = nearbyObjects.first?.distance else { return }
        if distance <= 0.30 {
            closeSamples += 1
            if closeSamples >= 2 {
                closeAt = Date()
                checkTap()
            }
        } else {
            closeSamples = 0
        }
    }

    func session(_ session: NISession, didInvalidateWith error: Error) {
        status = "Tap could not start. Use the QR code instead."
    }
}
