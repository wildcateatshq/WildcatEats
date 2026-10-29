import Foundation
import Combine
import SwiftUI
import MapKit
import CoreLocation
import UserNotifications
import AuthenticationServices

extension Notification.Name {
    static let novaDashSelectTab = Notification.Name("NovaDashSelectTab")
}

// Replace these two values with the Supabase project's public URL and anon key.
// The anon key is safe to ship in an app; never ship the service-role key.
enum SupabaseConfig {
    static let projectURL = "https://kdtjyxcblcluuynvqmvh.supabase.co"
    static let anonKey = "sb_publishable_FCQ3PBykEfYE2hOSMNKBlw_yNLDmGrF"
}

// The NovaDash server holds the Stripe secret key, so card payments, payouts,
// and accepting or releasing a delivery go through it.
enum NovaDashServer {
    static let baseURL = "https://novadash.online"
}

struct UserSession: Codable {
    let accessToken: String
    let refreshToken: String?
    let userID: UUID
    let email: String?
}

private actor SessionRefreshCoordinator {
    private var inFlight: Task<UserSession, Error>?

    func refresh(_ operation: @escaping () async throws -> UserSession) async throws -> UserSession {
        if let inFlight { return try await inFlight.value }
        let task = Task { try await operation() }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }
}

struct Profile: Codable, Identifiable {
    let id: UUID
    let name: String
    let email: String
    let phone: String?
}

struct NativeTestBalance: Decodable {
    let balanceCents: Int64
}

struct PaymentStatus: Decodable {
    struct Card: Decodable {
        let brand: String
        let last4: String
    }
    struct Payouts: Decodable {
        let connected: Bool
        let ready: Bool
    }
    let enabled: Bool
    let card: Card?
    let payouts: Payouts
    let balanceCents: Int64?
}

private struct HostedPageLink: Decodable {
    let url: String
    let kind: String?
}

extension Order {
    // The runner keeps 75% of the delivery fee; the server's PLATFORM_CUT
    // (payments.js) keeps the rest. Rounded the same way the server does.
    var runnerPayout: Double {
        let cents = (tip * 100).rounded()
        return (cents - (cents * 0.25).rounded()) / 100
    }
}

struct Order: Codable, Identifiable {
    let id: UUID
    let ordererID: UUID
    let runnerID: UUID?
    let store: String
    let orderNumber: String?
    let hall: String
    let dropoffDetails: String
    let items: String
    let tip: Double
    let status: String
    let claimedAt: Date?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case ordererID = "ordererId"
        case runnerID = "runnerId"
        case store, orderNumber, hall, dropoffDetails, items, tip, status, claimedAt, createdAt
    }
}

struct RunnerLocation: Codable, Identifiable {
    let id: UUID
    let displayName: String
    let latitude: Double
    let longitude: Double
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id = "userId"
        case displayName, latitude, longitude, updatedAt
    }

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}

struct DeliveryNotification: Codable, Identifiable {
    let id: UUID
    let orderID: UUID
    let title: String
    let body: String
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case orderID = "orderId"
        case title, body, createdAt
    }

    var isDashboardTestOffer: Bool { title == "Test delivery request" }
}

enum DeliveryNotificationPayload {
    static func orderID(from userInfo: [AnyHashable: Any]) -> UUID? {
        let data = userInfo["data"] as? [String: Any]
        let raw = (userInfo["order_id"] as? String)
            ?? (userInfo["orderId"] as? String)
            ?? (data?["order_id"] as? String)
            ?? (data?["orderId"] as? String)
        return raw.flatMap(UUID.init(uuidString:))
    }
}

@MainActor
final class DeliveryNotificationRouter: ObservableObject {
    static let shared = DeliveryNotificationRouter()
    @Published var pendingOrderID: UUID?
    private var lastOrderID: UUID?
    private var lastOpenTime = Date.distantPast
    private init() {}

    func open(_ orderID: UUID) {
        if lastOrderID == orderID && Date().timeIntervalSince(lastOpenTime) < 2 { return }
        lastOrderID = orderID
        lastOpenTime = Date()
        pendingOrderID = orderID
    }
}

@MainActor
final class DeliveryOfferNotifier {
    static let shared = DeliveryOfferNotifier()
    private init() {}

    func present(_ offers: [DeliveryNotification], userID: UUID) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
        let key = "native.delivery.shown.\(userID.uuidString)"
        var shown = Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
        for offer in offers where !shown.contains(offer.id.uuidString) {
            let content = UNMutableNotificationContent()
            content.title = offer.title
            content.body = offer.body
            content.sound = .default
            content.userInfo = ["order_id": offer.orderID.uuidString]
            let request = UNNotificationRequest(identifier: "native-offer-\(offer.id.uuidString)", content: content, trigger: nil)
            do {
                try await center.add(request)
                shown.insert(offer.id.uuidString)
            } catch {
                print("Could not present delivery offer: \(error.localizedDescription)")
            }
        }
        UserDefaults.standard.set(Array(shown.suffix(100)), forKey: key)
    }
}

struct MapPin: Identifiable {
    let id: String
    let coordinate: CLLocationCoordinate2D
    let isStore: Bool
}

enum StoreLocations {
    static let coordinates: [String: CLLocationCoordinate2D] = [
        "COVA": CLLocationCoordinate2D(latitude: 40.03538279831171, longitude: -75.34114479601725),
        "Cascia": CLLocationCoordinate2D(latitude: 40.0365, longitude: -75.3520),
        "Connelly Center": CLLocationCoordinate2D(latitude: 40.035895224812755, longitude: -75.34028222907769),
        "St. Mary's": CLLocationCoordinate2D(latitude: 40.04028393357511, longitude: -75.34165260914898),
        "Wawa": CLLocationCoordinate2D(latitude: 40.035895224812755, longitude: -75.34028222907769),
        "Holy Grounds (Bartley)": CLLocationCoordinate2D(latitude: 40.03481273056283, longitude: -75.3383313736512)
    ]

    static func coordinate(for store: String) -> CLLocationCoordinate2D {
        coordinates[store] ?? CLLocationCoordinate2D(latitude: 40.0357, longitude: -75.3412)
    }
}

private struct DiningCalendarResponse: Decodable {
    let items: [DiningCalendarEvent]
}

private struct DiningCalendarEvent: Decodable {
    struct Boundary: Decodable {
        let dateTime: String?
    }

    let summary: String?
    let status: String?
    let start: Boundary
    let end: Boundary
}

private struct DiningHoursOverride: Decodable {
    let store: String
    let forceOpen: Bool

    enum CodingKeys: String, CodingKey {
        case store
        case forceOpen = "force_open"
    }
}

@MainActor
private final class DiningHoursStore: ObservableObject {
    @Published private var now = Date()
    @Published private var officialIntervals: [String: [DateInterval]] = [:]
    @Published private var forcedOpenStores: Set<String> = []

    private static let eastern = TimeZone(identifier: "America/New_York")!
    private static let apiKey = "AIzaSyA3YlCh0bt_3lZV5-D5ElbkVQkUAaCf6Ns"
    private static let refreshInterval: TimeInterval = 15 * 60
    private static let overrideRefreshInterval: TimeInterval = 30

    // Calendar identifiers published by Villanova Dining's location pages.
    private static let calendars: [String: [String]] = [
        "COVA": ["aqhuvmluuelqpt6v2fmmv14h5o@group.calendar.google.com"],
        "Cascia": [
            "cb3a575e86fb52d56a61e43c6f745cac072897a082510d7bbf73000e68c6d65c@group.calendar.google.com",
            "u52v2is7p1fv5r6llpvdgktiak@group.calendar.google.com"
        ],
        "Connelly Center": [
            "921737glfilku8man2unra3q6c@group.calendar.google.com",
            "fnlgi68mvdgioft345pav3qsv4@group.calendar.google.com"
        ],
        "St. Mary's": ["l6pa6m32m61nsaj4uk6t0mnacg@group.calendar.google.com"],
        "Holy Grounds (Bartley)": ["t0pb4sov6v676snr837u5un950@group.calendar.google.com"]
    ]

    private struct WeeklyWindow {
        let weekdays: Set<Int>
        let startMinute: Int
        let endMinute: Int
    }

    // Used immediately and whenever Villanova's live calendar is unavailable.
    // Weekday values use Calendar's Sunday=1 convention. An end above 1440
    // crosses midnight into the following day.
    private static let fallbackHours: [String: [WeeklyWindow]] = [
        "COVA": [
            WeeklyWindow(weekdays: [2, 3, 4, 5], startMinute: 10 * 60 + 45, endMinute: 19 * 60),
            WeeklyWindow(weekdays: [6], startMinute: 10 * 60 + 45, endMinute: 15 * 60 + 30)
        ],
        "Cascia": [
            WeeklyWindow(weekdays: [1], startMinute: 17 * 60, endMinute: 23 * 60),
            WeeklyWindow(weekdays: [2, 3, 4, 5], startMinute: 8 * 60, endMinute: 23 * 60),
            WeeklyWindow(weekdays: [6], startMinute: 8 * 60, endMinute: 19 * 60)
        ],
        "Connelly Center": [
            WeeklyWindow(weekdays: [2, 3, 4, 5, 6, 7], startMinute: 11 * 60, endMinute: 19 * 60)
        ],
        "St. Mary's": [
            WeeklyWindow(weekdays: [2, 3, 4, 5, 6], startMinute: 7 * 60 + 30, endMinute: 10 * 60 + 30),
            WeeklyWindow(weekdays: [2, 3, 4, 5, 6, 7, 1], startMinute: 11 * 60, endMinute: 15 * 60),
            WeeklyWindow(weekdays: [2, 3, 4, 5, 6, 7, 1], startMinute: 16 * 60 + 15, endMinute: 20 * 60)
        ],
        // Villanova lists the Connelly Center as open daily from 7 a.m. to
        // 2 a.m.; the campus Wawa is inside its lower level.
        "Wawa": [
            WeeklyWindow(weekdays: [1, 2, 3, 4, 5, 6, 7], startMinute: 7 * 60, endMinute: 26 * 60)
        ],
        "Holy Grounds (Bartley)": [
            WeeklyWindow(weekdays: [2, 3, 4, 5], startMinute: 8 * 60, endMinute: 20 * 60),
            WeeklyWindow(weekdays: [6], startMinute: 8 * 60, endMinute: 14 * 60 + 30)
        ]
    ]

    func isClosed(_ store: String) -> Bool {
        if forcedOpenStores.contains(store) { return false }
        if let intervals = officialIntervals[store] {
            return !intervals.contains(where: { $0.contains(now) })
        }
        return !Self.isWithinFallbackHours(store: store, at: now)
    }

    func monitor() async {
        var lastCalendarRefresh = Date.distantPast
        var lastOverrideRefresh = Date.distantPast
        while !Task.isCancelled {
            now = Date()
            if now.timeIntervalSince(lastOverrideRefresh) >= Self.overrideRefreshInterval {
                await refreshOverrides()
                lastOverrideRefresh = now
            }
            if now.timeIntervalSince(lastCalendarRefresh) >= Self.refreshInterval {
                await refreshOfficialHours(near: now)
                lastCalendarRefresh = now
            }
            try? await Task.sleep(nanoseconds: 30_000_000_000)
        }
    }

    private func refreshOverrides() async {
        guard var components = URLComponents(string: SupabaseConfig.projectURL + "/rest/v1/native_store_hours_overrides") else { return }
        components.queryItems = [
            URLQueryItem(name: "select", value: "store,force_open"),
            URLQueryItem(name: "force_open", value: "eq.true")
        ]
        guard let url = components.url else { return }
        var request = URLRequest(url: url)
        request.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
            let rows = try JSONDecoder().decode([DiningHoursOverride].self, from: data)
            forcedOpenStores = Set(rows.filter(\.forceOpen).map(\.store))
        } catch {
            // Preserve the last known override on a transient connection failure.
        }
    }

    private func refreshOfficialHours(near date: Date) async {
        let queryStart = date.addingTimeInterval(-12 * 60 * 60)
        let queryEnd = date.addingTimeInterval(36 * 60 * 60)

        for (store, calendarIDs) in Self.calendars {
            var intervals: [DateInterval] = []
            var receivedOfficialResponse = false

            for calendarID in calendarIDs {
                do {
                    intervals.append(contentsOf: try await fetchIntervals(
                        calendarID: calendarID,
                        from: queryStart,
                        through: queryEnd
                    ))
                    receivedOfficialResponse = true
                } catch {
                    // Keep the last official result or the published fallback.
                }
            }

            if receivedOfficialResponse {
                officialIntervals[store] = intervals
            }
        }
    }

    private func fetchIntervals(calendarID: String, from start: Date, through end: Date) async throws -> [DateInterval] {
        let encodedID = calendarID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? calendarID
        guard var components = URLComponents(string: "https://www.googleapis.com/calendar/v3/calendars/\(encodedID)/events") else {
            return []
        }
        components.queryItems = [
            URLQueryItem(name: "showDeleted", value: "false"),
            URLQueryItem(name: "singleEvents", value: "true"),
            URLQueryItem(name: "orderBy", value: "startTime"),
            URLQueryItem(name: "timeMin", value: Self.rfc3339.string(from: start)),
            URLQueryItem(name: "timeMax", value: Self.rfc3339.string(from: end)),
            URLQueryItem(name: "fields", value: "items(end,start,status,summary)"),
            URLQueryItem(name: "key", value: Self.apiKey)
        ]
        guard let url = components.url else { return [] }

        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let events = try JSONDecoder().decode(DiningCalendarResponse.self, from: data).items
        return events.compactMap { event in
            guard event.status != "cancelled",
                  !(event.summary ?? "").localizedCaseInsensitiveContains("closed"),
                  let startText = event.start.dateTime,
                  let endText = event.end.dateTime,
                  let startDate = Self.parseRFC3339(startText),
                  let endDate = Self.parseRFC3339(endText),
                  endDate > startDate else { return nil }
            return DateInterval(start: startDate, end: endDate)
        }
    }

    private static func isWithinFallbackHours(store: String, at date: Date) -> Bool {
        guard let windows = fallbackHours[store] else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = eastern
        let weekday = calendar.component(.weekday, from: date)
        let minute = calendar.component(.hour, from: date) * 60 + calendar.component(.minute, from: date)
        let previousWeekday = weekday == 1 ? 7 : weekday - 1

        return windows.contains { window in
            if window.endMinute <= 24 * 60 {
                return window.weekdays.contains(weekday)
                    && minute >= window.startMinute
                    && minute < window.endMinute
            }
            return (window.weekdays.contains(weekday) && minute >= window.startMinute)
                || (window.weekdays.contains(previousWeekday) && minute < window.endMinute - 24 * 60)
        }
    }

    private static let rfc3339: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = eastern
        return formatter
    }()

    private static let fractionalRFC3339: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func parseRFC3339(_ value: String) -> Date? {
        fractionalRFC3339.date(from: value) ?? rfc3339.date(from: value)
    }
}

enum SupabaseError: LocalizedError {
    case notConfigured
    case server(String)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Add your Supabase project URL and anon key in NativeApp.swift."
        case .server(let message): return message
        case .invalidResponse(let detail): return detail
        }
    }
}

final class SupabaseClient {
    private let defaults = UserDefaults.standard
    private let sessionKey = "wildcat.eats.supabase.session"
    private let refreshCoordinator = SessionRefreshCoordinator()

    var session: UserSession? {
        guard let data = defaults.data(forKey: sessionKey) else { return nil }
        return try? JSONDecoder().decode(UserSession.self, from: data)
    }

    func signIn(email: String, password: String) async throws -> UserSession {
        let body: [String: AnyEncodable] = ["email": AnyEncodable(email), "password": AnyEncodable(password)]
        let auth: AuthResponse = try await send(
            "/auth/v1/token?grant_type=password", method: "POST", body: body, authenticated: false
        )
        guard let token = auth.accessToken, let user = auth.user, let id = UUID(uuidString: user.id) else {
            throw SupabaseError.invalidResponse("Supabase login succeeded but did not return a usable user session. Check the Auth response and try again.")
        }
        let session = UserSession(accessToken: token, refreshToken: auth.refreshToken, userID: id, email: user.email)
        save(session)
        return session
    }

    func signUp(name: String, email: String, phone: String, password: String) async throws -> UserSession? {
        let body: [String: AnyEncodable] = [
            "email": AnyEncodable(email),
            "password": AnyEncodable(password),
            "data": AnyEncodable(["name": name, "phone": phone])
        ]
        let auth: AuthResponse = try await send("/auth/v1/signup", method: "POST", body: body, authenticated: false)
        guard let token = auth.accessToken, let user = auth.user, let id = UUID(uuidString: user.id) else { return nil }
        let session = UserSession(accessToken: token, refreshToken: auth.refreshToken, userID: id, email: user.email)
        save(session)
        return session
    }

    func signOut() {
        defaults.removeObject(forKey: sessionKey)
    }

    func profile() async throws -> Profile {
        let rows: [Profile] = try await send("/rest/v1/native_profiles?select=id,name,email,phone&limit=1", authenticated: true)
        guard let profile = rows.first else { throw SupabaseError.server("Your profile is not set up yet.") }
        return profile
    }

    func testBalanceCents() async throws -> Int64 {
        let rows: [NativeTestBalance] = try await send(
            "/rest/v1/native_test_balances?select=balance_cents&limit=1",
            authenticated: true
        )
        return rows.first?.balanceCents ?? 0
    }

    func authenticatedUserName() async throws -> String? {
        let user: AuthUser = try await send("/auth/v1/user", authenticated: true)
        return user.displayName
    }

    func updateProfile(name: String, phone: String) async throws -> Profile {
        guard let session, let email = session.email else { throw SupabaseError.server("Please sign in again.") }
        let body: [String: AnyEncodable] = [
            "id": AnyEncodable(session.userID.uuidString),
            "name": AnyEncodable(name),
            "email": AnyEncodable(email),
            "phone": AnyEncodable(phone)
        ]
        let rows: [Profile] = try await send(
            "/rest/v1/native_profiles?on_conflict=id&select=id,name,email,phone",
            method: "POST", body: body, authenticated: true, preferReturn: true, upsert: true
        )
        guard let profile = rows.first else { throw SupabaseError.server("Your account information could not be updated.") }
        return profile
    }

    func openOrders() async throws -> [Order] {
        try await send("/rest/v1/native_orders?select=*&status=eq.open&order=created_at.desc", authenticated: true)
    }

    func myAssignedOrders() async throws -> [Order] {
        guard let session else { throw SupabaseError.server("Please sign in again.") }
        return try await send(
            "/rest/v1/native_orders?select=*&runner_id=eq.\(session.userID.uuidString)&status=in.(claimed,picked_up,arrived)&order=created_at.desc",
            authenticated: true
        )
    }

    func nearbyRunnerLocations() async throws -> [RunnerLocation] {
        let rows: [RunnerLocation] = try await send("/rest/v1/native_runner_locations?select=user_id,display_name,latitude,longitude,updated_at&order=updated_at.desc", authenticated: true)
        return rows.filter { $0.id != session?.userID && Date().timeIntervalSince($0.updatedAt) < 600 }
    }

    func upsertRunnerLocation(latitude: Double, longitude: Double) async throws {
        guard let session else { throw SupabaseError.server("Please sign in again.") }
        let body: [String: AnyEncodable] = [
            "user_id": AnyEncodable(session.userID.uuidString),
            "display_name": AnyEncodable(session.email ?? "Runner"),
            "latitude": AnyEncodable(latitude),
            "longitude": AnyEncodable(longitude),
            "updated_at": AnyEncodable(ISO8601DateFormatter().string(from: Date()))
        ]
        let _: [RunnerLocation] = try await send("/rest/v1/native_runner_locations?on_conflict=user_id", method: "POST", body: body, authenticated: true, preferReturn: true, upsert: true)
    }

    func myOrders() async throws -> [Order] {
        guard let session else { throw SupabaseError.server("Please sign in again.") }
        return try await send("/rest/v1/native_orders?select=*&orderer_id=eq.\(session.userID.uuidString)&order=created_at.desc", authenticated: true)
    }

    func createOrder(store: String, orderNumber: String, hall: String, details: String, items: String, tip: Double) async throws -> Order {
        guard let session else { throw SupabaseError.server("Please sign in again.") }
        let pickup = StoreLocations.coordinate(for: store)
        let body: [String: AnyEncodable] = [
            "orderer_id": AnyEncodable(session.userID.uuidString),
            "store": AnyEncodable(store),
            "order_number": AnyEncodable(orderNumber),
            "pickup_latitude": AnyEncodable(pickup.latitude),
            "pickup_longitude": AnyEncodable(pickup.longitude),
            "hall": AnyEncodable(hall),
            "dropoff_details": AnyEncodable(details),
            "items": AnyEncodable(items),
            "tip": AnyEncodable(tip),
            "status": AnyEncodable("open")
        ]
        let rows: [Order] = try await send("/rest/v1/native_orders", method: "POST", body: body, authenticated: true, preferReturn: true)
        guard let order = rows.first else { throw SupabaseError.server("The order could not be created.") }
        return order
    }

    func cancelOrder(_ orderID: UUID) async throws {
        let body = ["p_order_id": AnyEncodable(orderID.uuidString)]
        let cancelled: Bool = try await send(
            "/rest/v1/rpc/cancel_native_order",
            method: "POST",
            body: body,
            authenticated: true
        )
        guard cancelled else { throw SupabaseError.server("The order could not be cancelled.") }
    }

    func claim(_ order: Order, with notification: DeliveryNotification?) async throws {
        guard let session else { throw SupabaseError.server("Please sign in again.") }
        let selfTestOffer = notification?.orderID == order.id && notification?.isDashboardTestOffer == true
        guard order.ordererID != session.userID || selfTestOffer else { throw SupabaseError.server("You can't accept your own order.") }
        // The server charges the orderer's card in the same step.
        let _: EmptyResponse = try await serverSend("/api/native/orders/\(order.id.uuidString.lowercased())/claim", method: "POST")
    }

    func releaseDelivery(_ orderID: UUID) async throws {
        // The server refunds the orderer in the same step.
        let _: EmptyResponse = try await serverSend("/api/native/orders/\(orderID.uuidString.lowercased())/release", method: "POST")
    }

    func paymentStatus() async throws -> PaymentStatus {
        try await serverSend("/api/native/payments")
    }

    fileprivate func cardSetupLink() async throws -> HostedPageLink {
        try await serverSend("/api/native/payments/card", method: "POST")
    }

    func confirmCard(sessionID: String) async throws {
        let _: EmptyResponse = try await serverSend(
            "/api/native/payments/card/confirm",
            method: "POST",
            body: ["sessionId": AnyEncodable(sessionID)]
        )
    }

    fileprivate func payoutsLink() async throws -> HostedPageLink {
        try await serverSend("/api/native/payments/payouts", method: "POST")
    }

    func startHandoff(for orderID: UUID) async throws -> String {
        let body = ["p_order_id": AnyEncodable(orderID.uuidString)]
        return try await send("/rest/v1/rpc/start_native_delivery_handoff", method: "POST", body: body, authenticated: true)
    }

    func completeHandoff(for orderID: UUID, token: String, method: String) async throws {
        let body: [String: AnyEncodable] = [
            "p_order_id": AnyEncodable(orderID.uuidString),
            "p_token": AnyEncodable(token),
            "p_method": AnyEncodable(method)
        ]
        let completed: Bool = try await send("/rest/v1/rpc/complete_native_delivery_handoff", method: "POST", body: body, authenticated: true)
        guard completed else { throw SupabaseError.server("The delivery could not be completed.") }
    }

    func pendingDeliveryNotifications() async throws -> [DeliveryNotification] {
        guard let session else { throw SupabaseError.server("Please sign in again.") }
        return try await send(
            "/rest/v1/native_delivery_notifications?select=id,order_id,title,body,created_at&recipient_id=eq.\(session.userID.uuidString)&status=eq.pending&order=created_at.desc",
            authenticated: true
        )
    }

    func respondToDeliveryNotification(_ notification: DeliveryNotification, accepted: Bool) async throws {
        let body: [String: AnyEncodable] = [
            "status": AnyEncodable(accepted ? "accepted" : "dismissed"),
            "responded_at": AnyEncodable(ISO8601DateFormatter().string(from: Date()))
        ]
        let _: [DeliveryNotification] = try await send(
            "/rest/v1/native_delivery_notifications?id=eq.\(notification.id.uuidString)",
            method: "PATCH",
            body: body,
            authenticated: true,
            preferReturn: true
        )
    }

    func registerPushToken(_ deviceToken: String) async throws {
        guard let session else { return }
        let body: [String: AnyEncodable] = [
            "user_id": AnyEncodable(session.userID.uuidString),
            "device_token": AnyEncodable(deviceToken),
            "platform": AnyEncodable("ios")
        ]
        let _: EmptyResponse = try await send(
            "/rest/v1/native_push_tokens?on_conflict=device_token",
            method: "POST",
            body: body,
            authenticated: true,
            preferReturn: true,
            upsert: true
        )
    }

    private func save(_ session: UserSession) {
        if let data = try? JSONEncoder().encode(session) { defaults.set(data, forKey: sessionKey) }
    }

    private func renewedSession(after expiredToken: String) async throws -> UserSession {
        guard let current = session else { throw SupabaseError.server("Please sign in again.") }
        if current.accessToken != expiredToken { return current }

        return try await refreshCoordinator.refresh { [self] in
            guard let latest = self.session, latest.userID == current.userID else {
                throw SupabaseError.server("Your sign-in changed. Please try again.")
            }
            if latest.accessToken != expiredToken { return latest }
            guard let refreshToken = latest.refreshToken, !refreshToken.isEmpty else {
                throw SupabaseError.server("Your sign-in has expired. Please sign out and sign in again.")
            }

            let body: [String: AnyEncodable] = ["refresh_token": AnyEncodable(refreshToken)]
            let auth: AuthResponse
            do {
                auth = try await self.send(
                    "/auth/v1/token?grant_type=refresh_token",
                    method: "POST",
                    body: body,
                    authenticated: false
                )
            } catch SupabaseError.server(let message)
                where message.lowercased().contains("refresh token") || message.lowercased().contains("invalid grant") {
                throw SupabaseError.server("Your sign-in has expired. Please sign out and sign in again.")
            }
            guard let accessToken = auth.accessToken,
                  let nextRefreshToken = auth.refreshToken,
                  !nextRefreshToken.isEmpty else {
                throw SupabaseError.invalidResponse("Supabase did not return a complete renewed session. Please sign in again.")
            }
            if let returnedID = auth.user?.id, UUID(uuidString: returnedID) != latest.userID {
                throw SupabaseError.invalidResponse("Supabase renewed a different account. Please sign in again.")
            }
            guard let saved = self.session, saved.userID == latest.userID else {
                throw SupabaseError.server("Your sign-in changed. Please try again.")
            }
            if saved.accessToken != expiredToken { return saved }

            let renewed = UserSession(
                accessToken: accessToken,
                refreshToken: nextRefreshToken,
                userID: latest.userID,
                email: auth.user?.email ?? latest.email
            )
            self.save(renewed)
            return renewed
        }
    }

    // Calls the NovaDash server with this Supabase sign-in, renewing it once if expired.
    private func serverSend<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: [String: AnyEncodable]? = nil
    ) async throws -> T {
        guard let url = URL(string: NovaDashServer.baseURL + path) else { throw SupabaseError.invalidResponse("The NovaDash server URL is invalid.") }
        guard let token = session?.accessToken else { throw SupabaseError.server("Please sign in again.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body ?? [:])
        }
        var (data, response) = try await URLSession.shared.data(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 401 {
            let renewed = try await renewedSession(after: token)
            request.setValue("Bearer \(renewed.accessToken)", forHTTPHeaderField: "Authorization")
            (data, response) = try await URLSession.shared.data(for: request)
        }
        guard let http = response as? HTTPURLResponse else { throw SupabaseError.invalidResponse("The NovaDash server did not return an HTTP response.") }
        guard (200..<300).contains(http.statusCode) else {
            let details = try? JSONDecoder().decode(SupabaseMessage.self, from: data)
            throw SupabaseError.server(details?.bestMessage ?? "The NovaDash server could not complete that request.")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw SupabaseError.invalidResponse("The NovaDash server returned an unreadable response.")
        }
    }

    private func send<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: [String: AnyEncodable]? = nil,
        authenticated: Bool,
        preferReturn: Bool = false,
        upsert: Bool = false
    ) async throws -> T {
        guard SupabaseConfig.projectURL.hasPrefix("https://"), !SupabaseConfig.projectURL.contains("YOUR_PROJECT"),
              SupabaseConfig.anonKey.count > 20, !SupabaseConfig.anonKey.contains("YOUR_") else { throw SupabaseError.notConfigured }
        guard let url = URL(string: SupabaseConfig.projectURL + path) else { throw SupabaseError.invalidResponse("The Supabase project URL is invalid.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        let accessToken: String?
        if authenticated {
            guard let token = session?.accessToken else { throw SupabaseError.server("Please sign in again.") }
            accessToken = token
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        } else {
            accessToken = nil
        }
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if preferReturn { request.setValue(upsert ? "return=representation,resolution=merge-duplicates" : "return=representation", forHTTPHeaderField: "Prefer") }
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        let initial = try await URLSession.shared.data(for: request)
        var data = initial.0
        var response = initial.1
        if let token = accessToken,
           let initialHTTP = response as? HTTPURLResponse,
           (initialHTTP.statusCode == 401 || String(data: data, encoding: .utf8)?.lowercased().contains("jwt expired") == true) {
            let renewed = try await renewedSession(after: token)
            request.setValue("Bearer \(renewed.accessToken)", forHTTPHeaderField: "Authorization")
            let retried = try await URLSession.shared.data(for: request)
            data = retried.0
            response = retried.1
        }
        guard let http = response as? HTTPURLResponse else { throw SupabaseError.invalidResponse("Supabase did not return an HTTP response.") }
        guard (200..<300).contains(http.statusCode) else {
            let details = try? JSONDecoder().decode(SupabaseMessage.self, from: data)
            let message = details?.bestMessage ?? String(data: data, encoding: .utf8) ?? "Supabase request failed."
            throw SupabaseError.server(message)
        }
        if T.self == EmptyResponse.self { return EmptyResponse() as! T }
        do {
            return try JSONDecoder.supabase.decode(T.self, from: data)
        } catch {
            throw SupabaseError.invalidResponse("Supabase returned an unreadable response: \(error.localizedDescription)")
        }
    }
}

private struct AuthResponse: Decodable {
    let accessToken: String?
    let refreshToken: String?
    let user: AuthUser?
    // JSONDecoder.supabase converts snake_case keys automatically.
    enum CodingKeys: String, CodingKey { case accessToken, refreshToken, user }
}
private struct AuthUser: Decodable {
    let id: String
    let email: String?
    let userMetadata: AuthUserMetadata?

    var displayName: String? { userMetadata?.displayName }
}

private struct AuthUserMetadata: Decodable {
    let name: String?
    let fullName: String?
    let firstName: String?
    let lastName: String?

    var displayName: String? {
        let full = [name, fullName].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        if let full { return full }
        let parts = [firstName, lastName].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}
private struct SupabaseMessage: Decodable {
    let message: String?
    let error: String?
    let errorDescription: String?
    let msg: String?

    var bestMessage: String? { message ?? errorDescription ?? error ?? msg }

    enum CodingKeys: String, CodingKey {
        case message, error, errorDescription = "error_description", msg
    }
}
private struct EmptyResponse: Decodable {}

struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) { encodeValue = value.encode }
    func encode(to encoder: Encoder) throws { try encodeValue(encoder) }
}

private extension JSONDecoder {
    static let supabase: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) { return date }
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = standard.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid Supabase timestamp: \(value)")
        }
        return decoder
    }()
}

// Shows a Stripe-hosted page (card entry, payout setup) in a secure browser
// sheet. The server sends Stripe's return links on to novadash://, which
// closes the sheet and hands that address back here.
final class StripeHostedPage: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    /// The novadash:// address the page finished on, or nil if it was closed.
    @MainActor static func open(_ url: URL) async throws -> URL? {
        let page = StripeHostedPage()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "novadash") { callback, error in
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(returning: nil)
                } else if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: callback)
                }
                page.session = nil
            }
            session.presentationContextProvider = page
            session.prefersEphemeralWebBrowserSession = true
            page.session = session
            if !session.start() {
                page.session = nil
                continuation.resume(throwing: SupabaseError.server("The secure Stripe page couldn't be opened."))
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.compactMap(\.keyWindow).first ?? scenes.first?.windows.first ?? ASPresentationAnchor()
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var session: UserSession?
    @Published var profile: Profile?
    @Published var authDisplayName: String?
    @Published var testBalanceCents: Int64?
    @Published var paymentStatus: PaymentStatus?
    @Published var errorMessage: String?
    @Published var isWorking = false
    let client = SupabaseClient()
    private var pushTokenCancellable: AnyCancellable?

    init() {
        session = client.session
        pushTokenCancellable = NotificationCenter.default.publisher(for: .didRegisterForRemoteNotifications)
            .compactMap { $0.userInfo?["deviceToken"] as? String }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] deviceToken in
                Task { @MainActor in
                    try? await self?.client.registerPushToken(deviceToken)
                }
            }
        if session != nil {
            AppDelegate.requestNotificationAuthorization()
        }
    }

    func signIn(email: String, password: String) async {
        await perform { self.session = try await self.client.signIn(email: email, password: password) }
        if session != nil { AppDelegate.requestNotificationAuthorization() }
    }

    func signUp(name: String, email: String, phone: String, password: String) async {
        await perform {
            let newSession = try await self.client.signUp(name: name, email: email, phone: phone, password: password)
            self.session = newSession
            if newSession == nil { throw SupabaseError.server("Check your email to confirm your account, then sign in.") }
        }
        if session != nil { AppDelegate.requestNotificationAuthorization() }
    }

    func signOut() { client.signOut(); session = nil; profile = nil; authDisplayName = nil; testBalanceCents = nil; paymentStatus = nil }

    func loadPaymentStatus() async {
        if let status = try? await client.paymentStatus() { paymentStatus = status }
    }

    /// Opens Stripe's card page. Returns true once a card is saved, false if
    /// the person closed the page.
    func addCard() async throws -> Bool {
        let link = try await client.cardSetupLink()
        guard let url = URL(string: link.url) else { throw SupabaseError.invalidResponse("Stripe returned an invalid card page.") }
        guard let callback = try await StripeHostedPage.open(url) else { return false }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "kind" })?.value == "card",
              let sessionID = items.first(where: { $0.name == "session_id" })?.value else { return false }
        try await client.confirmCard(sessionID: sessionID)
        await loadPaymentStatus()
        return true
    }

    /// Payout setup on Stripe's page, or the runner's Stripe dashboard once set up.
    func openPayouts() async throws {
        let link = try await client.payoutsLink()
        guard let url = URL(string: link.url) else { throw SupabaseError.invalidResponse("Stripe returned an invalid payouts page.") }
        if link.kind == "dashboard" {
            await UIApplication.shared.open(url)
        } else {
            _ = try await StripeHostedPage.open(url)
            await loadPaymentStatus()
        }
    }

    func loadTestBalance() async {
        do { testBalanceCents = try await client.testBalanceCents() }
        catch { testBalanceCents = nil }
    }

    func loadProfile() async {
        do { profile = try await client.profile() } catch { profile = nil }
        let savedName = profile?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if savedName.isEmpty {
            authDisplayName = try? await client.authenticatedUserName()
        } else {
            authDisplayName = nil
        }
    }

    var accountName: String {
        let name = profile?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty { return name }
        let authName = authDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return authName.isEmpty ? "Add your name" : authName
    }

    private func perform(_ operation: @escaping () async throws -> Void) async {
        isWorking = true; errorMessage = nil
        do { try await operation() } catch { errorMessage = error.localizedDescription }
        isWorking = false
    }
}

struct NativeRootView: View {
    @StateObject private var model = AppModel()
    var body: some View {
        Group {
            if model.session == nil { AuthenticationFlowView() } else { MainTabView() }
        }
        .environmentObject(model)
        .font(.custom("Inter-Regular", size: 17))
        .tint(.novaDashNavy)
        .modifier(KeyboardAvoidance())
    }
}

/// App-wide keyboard avoidance. Screens are laid out on a fixed canvas, so instead
/// of SwiftUI's per-view avoidance the whole app shifts up just enough to keep the
/// focused text box a comfortable distance above the keyboard.
private struct KeyboardAvoidance: ViewModifier {
    @StateObject private var keyboard = KeyboardShift()

    func body(content: Content) -> some View {
        content
            .offset(y: -keyboard.shift)
            .ignoresSafeArea(.keyboard)
    }
}

@MainActor private final class KeyboardShift: ObservableObject {
    @Published private(set) var shift: CGFloat = 0
    private var keyboardTop: CGFloat?
    private var observers: [NSObjectProtocol] = []
    /// Space kept between the bottom of the focused box and the top of the keyboard.
    private let margin: CGFloat = 24

    init() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated { self?.keyboardChanged(note) }
            },
            center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated { self?.keyboardHidden(note) }
            },
            // Moving focus between boxes while the keyboard stays up.
            center.addObserver(forName: UITextField.textDidBeginEditingNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.update(animation: .easeOut(duration: 0.25)) }
            },
            center.addObserver(forName: UITextView.textDidBeginEditingNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.update(animation: .easeOut(duration: 0.25)) }
            }
        ]
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    private func keyboardChanged(_ note: Notification) {
        guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let screenHeight = UIScreen.main.bounds.height
        keyboardTop = frame.minY < screenHeight ? frame.minY : nil
        update(animation: Self.animation(from: note))
    }

    private func keyboardHidden(_ note: Notification) {
        keyboardTop = nil
        update(animation: Self.animation(from: note))
    }

    private func update(animation: Animation) {
        var target: CGFloat = 0
        if let keyboardTop, let field = Self.focusedTextView(), let window = field.window {
            // Measured on screen with the current shift applied; undo it to get the resting position.
            let frame = field.convert(field.bounds, to: nil)
            let restingTop = frame.minY + shift
            let restingBottom = frame.maxY + shift
            target = max(0, restingBottom + margin - keyboardTop)
            // Never push the top of the box under the status bar (matters for tall boxes).
            let topLimit = restingTop - window.safeAreaInsets.top - 8
            target = max(0, min(target, topLimit))
        }
        guard abs(target - shift) > 0.5 else { return }
        withAnimation(animation) { shift = target }
    }

    private static func animation(from note: Notification) -> Animation {
        let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        return .easeOut(duration: max(duration, 0.1))
    }

    private static func focusedTextView() -> UIView? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        for window in windows where window.isKeyWindow {
            if let found = firstResponder(in: window) { return found }
        }
        return nil
    }

    private static func firstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder, view is UITextField || view is UITextView { return view }
        for subview in view.subviews {
            if let found = firstResponder(in: subview) { return found }
        }
        return nil
    }
}

private extension Color {
    static let novaDashNavy = Color("NovaDashNavy")
    static let novaDashIvory = Color("NovaDashIvory")
}

// Shared motion: side-by-side changes slide horizontally, stacked changes vertically.
extension Animation {
    static let novaDashSlide = Animation.spring(response: 0.42, dampingFraction: 0.88)
}

extension AnyTransition {
    /// Enters from and leaves toward `edge`, travelling a full screen so nothing peeks.
    static func novaDashSlide(_ edge: Edge) -> AnyTransition {
        let size = UIScreen.main.bounds.size
        switch edge {
        case .leading: return .offset(x: -size.width)
        case .trailing: return .offset(x: size.width)
        case .top: return .offset(y: -size.height)
        case .bottom: return .offset(y: size.height)
        }
    }

    /// Enters from `edge` and leaves toward the opposite edge, like a push.
    static func novaDashPush(from edge: Edge) -> AnyTransition {
        let opposite: Edge
        switch edge {
        case .leading: opposite = .trailing
        case .trailing: opposite = .leading
        case .top: opposite = .bottom
        case .bottom: opposite = .top
        }
        return .asymmetric(insertion: .novaDashSlide(edge), removal: .novaDashSlide(opposite))
    }
}

/// Drag a page from its left edge to the right to go back. The page follows the
/// finger; past a third of the screen (or on a flick) it continues off to the
/// right as `onBack` removes it, otherwise it springs back.
private struct EdgeSwipeBack: ViewModifier {
    let onBack: () -> Void
    @State private var dragX: CGFloat = 0
    @State private var isTracking = false

    func body(content: Content) -> some View {
        content
            .offset(x: dragX)
            .simultaneousGesture(
                // Global space: the page moves with the drag, so local translation would feed back.
                DragGesture(minimumDistance: 10, coordinateSpace: .global)
                    .onChanged { value in
                        if !isTracking {
                            guard value.startLocation.x < 28,
                                  value.translation.width > abs(value.translation.height) else { return }
                            isTracking = true
                        }
                        dragX = max(0, value.translation.width)
                    }
                    .onEnded { value in
                        guard isTracking else { return }
                        isTracking = false
                        let width = UIScreen.main.bounds.width
                        if value.translation.width > width / 3 || value.predictedEndTranslation.width > width / 2 {
                            withAnimation(.novaDashSlide) { onBack() }
                            // If the page is still here (e.g. back was refused), settle it.
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { dragX = 0 }
                        } else {
                            withAnimation(.novaDashSlide) { dragX = 0 }
                        }
                    }
            )
    }
}

extension View {
    func novaDashEdgeSwipeBack(_ onBack: @escaping () -> Void) -> some View {
        modifier(EdgeSwipeBack(onBack: onBack))
    }
}

// Screens pushed with a hidden navigation bar lose UIKit's edge-swipe back.
// Re-enable it whenever there is a screen to go back to.
extension UINavigationController: UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}

private extension Font {
    static func novaDashItalic(size: CGFloat) -> Font {
        let base = UIFont(name: "Inter-Regular", size: size) ?? UIFont.systemFont(ofSize: size)
        guard let descriptor = base.fontDescriptor.withSymbolicTraits(.traitItalic) else {
            return .custom("Inter-Regular", size: size)
        }
        return Font(UIFont(descriptor: descriptor, size: size))
    }
}

private struct NovaDashCanvas<Content: View>: View {
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

private struct TrailingRoundedRectangle: InsettableShape {
    let radius: CGFloat
    private var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let insetRect = rect.insetBy(dx: insetAmount, dy: insetAmount)
        let insetRadius = max(0, min(radius - insetAmount, insetRect.height / 2))
        return Path(UIBezierPath(
            roundedRect: insetRect,
            byRoundingCorners: [.topRight, .bottomRight],
            cornerRadii: CGSize(width: insetRadius, height: insetRadius)
        ).cgPath)
    }

    func inset(by amount: CGFloat) -> TrailingRoundedRectangle {
        var copy = self
        copy.insetAmount += amount
        return copy
    }
}

private struct OutlinedText: View {
    let text: String
    let fontName: String
    let size: CGFloat
    let fill: Color
    let stroke: Color
    let strokeWidth: CGFloat

    private let directions: [CGSize] = [
        CGSize(width: -1, height: 0), CGSize(width: 1, height: 0),
        CGSize(width: 0, height: -1), CGSize(width: 0, height: 1),
        CGSize(width: -0.7, height: -0.7), CGSize(width: 0.7, height: -0.7),
        CGSize(width: -0.7, height: 0.7), CGSize(width: 0.7, height: 0.7)
    ]

    var body: some View {
        ZStack {
            ForEach(directions.indices, id: \.self) { index in
                Text(text)
                    .offset(
                        x: directions[index].width * strokeWidth,
                        y: directions[index].height * strokeWidth
                    )
                    .foregroundColor(stroke)
            }
            Text(text).foregroundColor(fill)
        }
        .font(.custom(fontName, size: size))
    }
}

private enum AuthenticationDestination {
    case start
    case signIn
    case signUp
}

private struct AuthenticationFlowView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var destination: AuthenticationDestination = .start
    @State private var isCreateAccountFlooding = false
    @State private var createAccountFloodScale: CGFloat = 1
    @State private var createAccountFloodOpacity: Double = 1
    @State private var signupPageBackgroundVisible = true

    var body: some View {
        ZStack {
            Color.novaDashNavy.ignoresSafeArea()

            switch destination {
            case .start:
                StartView(
                    onLogin: { go(.signIn) },
                    onCreateAccount: startCreateAccountTransition
                )
                .transition(.novaDashSlide(.leading))
                .zIndex(0)
            case .signIn:
                LoginView(isSignup: false, onBack: { go(.start) })
                    .transition(.novaDashSlide(.trailing))
                    .zIndex(10)
            case .signUp:
                LoginView(
                    isSignup: true,
                    showsPageBackground: signupPageBackgroundVisible,
                    onBack: { go(.start) }
                )
                    .transition(.novaDashSlide(.trailing))
                    .zIndex(10)
            }

            if isCreateAccountFlooding {
                NovaDashCanvas {
                    Capsule()
                        .fill(Color.novaDashIvory)
                        .frame(width: 357, height: 70)
                        .scaleEffect(createAccountFloodScale)
                        .position(x: 258.5, y: 684)
                }
                .opacity(createAccountFloodOpacity)
                .allowsHitTesting(true)
                .zIndex(5)
                .accessibilityHidden(true)
            }
        }
    }

    private func go(_ next: AuthenticationDestination) {
        signupPageBackgroundVisible = true
        withAnimation(.novaDashSlide) { destination = next }
    }

    private func startCreateAccountTransition() {
        guard !isCreateAccountFlooding else { return }
        if reduceMotion {
            signupPageBackgroundVisible = true
            destination = .signUp
            return
        }

        signupPageBackgroundVisible = false
        createAccountFloodScale = 1
        createAccountFloodOpacity = 1
        isCreateAccountFlooding = true

        Task { @MainActor in
            // Render once at the button's exact size, then slide the signup
            // page from the right while the ivory pill floods the space behind it.
            await Task.yield()
            withAnimation(.timingCurve(0.42, 0, 0.2, 1, duration: 0.8)) {
                createAccountFloodScale = 22
                destination = .signUp
            }
            try? await Task.sleep(nanoseconds: 800_000_000)

            // The flood now covers every edge, so the page can take over the
            // same ivory background without exposing a rectangular boundary.
            signupPageBackgroundVisible = true
            withAnimation(.easeOut(duration: 0.16)) {
                createAccountFloodOpacity = 0
            }
            try? await Task.sleep(nanoseconds: 160_000_000)
            isCreateAccountFlooding = false
            createAccountFloodScale = 1
            createAccountFloodOpacity = 1
        }
    }
}

private struct StartView: View {
    let onLogin: () -> Void
    let onCreateAccount: () -> Void

    var body: some View {
        ZStack {
            Color.novaDashNavy.ignoresSafeArea()
            NovaDashCanvas {
                ZStack(alignment: .topLeading) {
                    Button("log in", action: onLogin)
                        .font(.custom("Inter-Medium", size: 18.754))
                        .foregroundColor(.novaDashIvory)
                        .frame(width: 68.8, height: 43.2)
                        .contentShape(Rectangle().inset(by: -8))
                        .position(x: 330, y: 92)

                    OutlinedText(
                        text: "NOVA",
                        fontName: "Georgia-BoldItalic",
                        size: 82,
                        fill: .novaDashNavy,
                        stroke: .novaDashIvory,
                        strokeWidth: 2
                    )
                    .frame(width: 270, height: 124, alignment: .leading)
                    .position(x: 165, y: 311)

                    Image("NovaDashMascot")
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 188.868, height: 172.601)
                        .clipped()
                        .position(x: 192.925, y: 402.835)

                    Text("DASH")
                        .font(.custom("Inter-Bold", size: 92))
                        .foregroundColor(.novaDashIvory)
                        .scaleEffect(x: 1.1, y: 1, anchor: .leading)
                        .transformEffect(CGAffineTransform(a: 1, b: 0, c: -0.1, d: 1, tx: 7, ty: 0))
                        .frame(width: 280.44, height: 121, alignment: .leading)
                        .position(x: 257.025, y: 505.235)

                    Button(action: onCreateAccount) {
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(Color.novaDashIvory)
                            Capsule()
                                .stroke(Color.novaDashNavy, lineWidth: 1.875)
                                .padding(3)
                            Text("create account")
                                .font(.custom("Inter-Medium", size: 23.442))
                                .foregroundColor(.novaDashNavy)
                                .padding(.leading, 37)
                            Image("NovaDashArrow")
                                .resizable()
                                .frame(width: 61, height: 61)
                                .offset(x: 226)
                        }
                        .frame(width: 357, height: 70)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .position(x: 258.5, y: 684)
                    .accessibilityLabel("Create account")
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

@MainActor final class LoginForm: ObservableObject {
    @Published var isSignup = false
    @Published var name = ""
    @Published var phone = ""
    @Published var email = ""
    @Published var password = ""
}

@MainActor final class OrderForm: ObservableObject {
    @Published var store = ""
    @Published var orderNumber = ""
    @Published var hall = ""
    @Published var details = ""
    @Published var items = ""
    @Published var tip = "5"
    @Published var notice: String?
    @Published var isPosting = false
    @Published var showPaymentUnavailable = false

    init(store: String = "") { self.store = store }
}

@MainActor final class DeliveryState: ObservableObject {
    @Published var orders: [Order] = []
    @Published var activeOrders: [Order] = []
    @Published var notifications: [DeliveryNotification] = []
    @Published var selectedOrder: Order?
    @Published var unavailableNotification = false
    @Published var error: String?
}

/// Set by a tab's content when its current screen has no room for the bottom menu.
private struct HidesTabBarKey: PreferenceKey {
    static var defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

@MainActor final class MainTabState: ObservableObject {
    @Published var hidesTabBar = false
    @Published private(set) var selectedTab = 0
    @Published private(set) var slideEdge: Edge = .trailing

    func select(_ tab: Int) {
        guard tab != selectedTab else { return }
        // Set the direction one update before switching, so the outgoing tab
        // already carries the matching removal transition.
        slideEdge = tab > selectedTab ? .trailing : .leading
        DispatchQueue.main.async {
            withAnimation(.novaDashSlide) { self.selectedTab = tab }
        }
    }
}

@MainActor
final class OrderMapModel: ObservableObject {
    @Published var region: MKCoordinateRegion
    @Published var pins: [MapPin]
    @Published var nearbyCount = 0
    let store: String

    init(store: String) {
        self.store = store
        let coordinate = StoreLocations.coordinate(for: store)
        region = MKCoordinateRegion(center: coordinate, span: MKCoordinateSpan(latitudeDelta: 0.0018, longitudeDelta: 0.0018))
        pins = [MapPin(id: "store-\(store)", coordinate: coordinate, isStore: true)]
    }

    func load(using client: SupabaseClient) async {
        do {
            let runners = try await client.nearbyRunnerLocations()
            nearbyCount = runners.count
            pins = [pins[0]] + runners.map { MapPin(id: $0.id.uuidString, coordinate: $0.coordinate, isStore: false) }
        } catch {
            nearbyCount = 0
        }
    }
}

@MainActor
final class DeliveryLocation: NSObject, ObservableObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    @Published var coordinate: CLLocationCoordinate2D?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func start() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        coordinate = locations.last?.coordinate
    }
}

private struct LoginView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var form = LoginForm()
    @State private var signupRevealStage = 0
    let isSignup: Bool
    var showsPageBackground = true
    let onBack: () -> Void

    var body: some View {
        ZStack {
            Group {
                if showsPageBackground {
                    Color.novaDashIvory
                } else {
                    Color.clear
                }
            }
            .ignoresSafeArea()
            NovaDashCanvas {
                ZStack(alignment: .topLeading) {
                    compactWordmark
                        .position(x: 201, y: isSignup ? 197 : 292)
                        .opacity(!isSignup || signupRevealStage >= 1 ? 1 : 0)
                        .offset(y: isSignup && signupRevealStage < 1 ? 10 : 0)

                    if isSignup {
                        signupFields
                    } else {
                        signInFields
                    }

                    Button(action: onBack) {
                        Image("NovaDashArrow")
                            .resizable()
                            .frame(width: 43.2, height: 43.2)
                            .rotationEffect(.degrees(180))
                            .contentShape(Rectangle())
                    }
                    .frame(width: 68.8, height: 43.2)
                    .buttonStyle(.plain)
                    .position(x: 34.4, y: 92)
                    .opacity(!isSignup || signupRevealStage >= 1 ? 1 : 0)
                    .offset(x: isSignup && signupRevealStage < 1 ? -8 : 0)
                    .accessibilityLabel("Back")

                    if let error = model.errorMessage {
                        Text(error)
                            .font(.custom("Inter-Regular", size: 13))
                            .foregroundColor(.red)
                            .multilineTextAlignment(.center)
                            .frame(width: 305)
                            .position(x: 201.5, y: isSignup ? 747 : 696)
                    }
                }
            }
        }
        .onAppear { form.isSignup = isSignup }
        .task { await revealSignupContent() }
        .novaDashEdgeSwipeBack(onBack)
        .preferredColorScheme(.light)
    }

    private var compactWordmark: some View {
        Image("NovaDashLogo")
            .resizable()
            .scaledToFit()
            .frame(width: 230, height: 53)
            .accessibilityLabel("NovaDash")
    }

    private var signInFields: some View {
        Group {
            NovaDashTextField(
                placeholder: "villanova email",
                text: $form.email,
                contentType: .emailAddress,
                keyboardType: .emailAddress,
                height: 68.2,
                placeholderOpacity: 0.55,
                placeholderFontSize: 20
            )
            .position(x: 201, y: 401.6)

            NovaDashTextField(
                placeholder: "password",
                text: $form.password,
                isSecure: true,
                contentType: .password,
                height: 68.2,
                placeholderOpacity: 0.55,
                placeholderFontSize: 20
            )
            .position(x: 201, y: 488)

            authButton(title: "sign in", fontSize: 20, height: 68.2)
                .position(x: 201, y: 574.4)
        }
    }

    private var signupFields: some View {
        Group {
            NovaDashTextField(placeholder: "name", text: $form.name, contentType: .name, height: 68.2, placeholderOpacity: 0.55, placeholderFontSize: 20)
                .position(x: 201.5, y: 321.2)
                .opacity(signupRevealStage >= 2 ? 1 : 0)
                .offset(y: signupRevealStage >= 2 ? 0 : 12)
            NovaDashTextField(placeholder: "phone", text: $form.phone, contentType: .telephoneNumber, keyboardType: .phonePad, height: 68.2, placeholderOpacity: 0.55, placeholderFontSize: 20)
                .position(x: 201.5, y: 407.6)
                .opacity(signupRevealStage >= 3 ? 1 : 0)
                .offset(y: signupRevealStage >= 3 ? 0 : 12)
            NovaDashTextField(placeholder: "villanova email", text: $form.email, contentType: .emailAddress, keyboardType: .emailAddress, height: 68.2, placeholderOpacity: 0.55, placeholderFontSize: 20)
                .position(x: 201.5, y: 494)
                .opacity(signupRevealStage >= 4 ? 1 : 0)
                .offset(y: signupRevealStage >= 4 ? 0 : 12)
            NovaDashTextField(placeholder: "password", text: $form.password, isSecure: true, contentType: .newPassword, height: 68.2, placeholderOpacity: 0.55, placeholderFontSize: 20)
                .position(x: 201.5, y: 580.4)
                .opacity(signupRevealStage >= 5 ? 1 : 0)
                .offset(y: signupRevealStage >= 5 ? 0 : 12)
            authButton(title: "create account", fontSize: 20, height: 68.2)
                .position(x: 201.5, y: 666.8)
                .opacity(signupRevealStage >= 6 ? 1 : 0)
                .offset(y: signupRevealStage >= 6 ? 0 : 12)
        }
    }

    @MainActor private func revealSignupContent() async {
        guard isSignup else {
            signupRevealStage = 6
            return
        }
        signupRevealStage = reduceMotion ? 6 : 0
        guard !reduceMotion else { return }

        try? await Task.sleep(nanoseconds: 40_000_000)
        for stage in 1...6 {
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.32)) {
                signupRevealStage = stage
            }
            try? await Task.sleep(nanoseconds: 80_000_000)
        }
    }

    private func authButton(title: String, fontSize: CGFloat = 23.442, height: CGFloat = 77) -> some View {
        Button {
            Task {
                if isSignup {
                    await model.signUp(name: form.name, email: form.email, phone: form.phone, password: form.password)
                } else {
                    await model.signIn(email: form.email, password: form.password)
                }
            }
        } label: {
            Group {
                if model.isWorking {
                    ProgressView().tint(.novaDashIvory)
                } else {
                    Text(title)
                        .font(.custom("Inter-Medium", size: fontSize))
                        .foregroundColor(.novaDashIvory)
                }
            }
            .frame(width: 305, height: height)
            .background(Color.novaDashNavy)
            .clipShape(Capsule())
        }
        .buttonStyle(PlainButtonStyle())
        .disabled(model.isWorking)
    }
}

private struct NovaDashTextField: View {
    let placeholder: String
    @Binding var text: String
    var isSecure = false
    var contentType: UITextContentType?
    var keyboardType: UIKeyboardType = .default
    var height: CGFloat = 77
    var placeholderOpacity = 1.0
    var placeholderFontSize: CGFloat = 23.442

    var body: some View {
        Group {
            if isSecure {
                SecureField("", text: $text, prompt: prompt)
            } else {
                TextField("", text: $text, prompt: prompt)
            }
        }
        .textFieldStyle(PlainTextFieldStyle())
        .font(.novaDashItalic(size: 23.442))
        .foregroundColor(.novaDashNavy)
        .tint(.novaDashNavy)
        .textContentType(contentType)
        .keyboardType(keyboardType)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(.horizontal, 33)
        .frame(width: 305, height: height)
        .background(
            RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                .fill(Color.novaDashIvory)
        )
        .overlay(
            RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                .strokeBorder(Color.novaDashNavy, lineWidth: 2)
        )
        .clipShape(RoundedRectangle(cornerRadius: height / 2, style: .continuous))
    }

    private var prompt: Text {
        Text(placeholder)
            .font(.system(size: placeholderFontSize, weight: .regular, design: .default).italic())
            .foregroundColor(.novaDashNavy.opacity(placeholderOpacity))
    }
}

private struct ThickInputModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.custom("Inter-Medium", size: 17))
            .padding(.horizontal, 14)
            .frame(height: 54)
            .background(Color.white)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(red: 0, green: 0.125, blue: 0.357).opacity(0.34), lineWidth: 2))
    }
}

private struct OrderReferenceInputModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.custom("Inter-Regular", size: 17))
            .padding(.horizontal, 12)
            .frame(height: 60)
            .background(Color.white)
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.gray.opacity(0.75), lineWidth: 1))
    }
}

private extension View {
    func thickInput() -> some View { modifier(ThickInputModifier()) }
    func orderReferenceInput() -> some View { modifier(OrderReferenceInputModifier()) }
}

struct MainTabView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var notificationRouter = DeliveryNotificationRouter.shared
    @StateObject private var tabState = MainTabState()

    var body: some View {
        ZStack {
            Color.novaDashIvory.ignoresSafeArea()
            Group {
                switch tabState.selectedTab {
                case 1:
                    // Deliver animates its own pieces in (title from the right,
                    // requests from below), so the page itself doesn't slide in.
                    DeliverView(onBack: { tabState.select(0) })
                        .transition(.asymmetric(insertion: .identity, removal: .novaDashPush(from: tabState.slideEdge)))
                case 2:
                    AccountView()
                        .transition(.novaDashPush(from: tabState.slideEdge))
                default:
                    OrderFoodView()
                        .transition(.novaDashPush(from: tabState.slideEdge))
                }
            }
            // One menu for every tab: it stays put while pages slide beneath it,
            // and only glides down/up when a screen has no menu.
            if !tabState.hidesTabBar {
                NovaDashTabBar(selection: Binding(get: { tabState.selectedTab }, set: { tabState.select($0) }))
                    .transition(.move(edge: .bottom))
                    .zIndex(1)
            }
        }
        .onPreferenceChange(HidesTabBarKey.self) { hides in
            guard hides != tabState.hidesTabBar else { return }
            withAnimation(.novaDashSlide) { tabState.hidesTabBar = hides }
        }
        .onChange(of: notificationRouter.pendingOrderID) { orderID in
            if orderID != nil { tabState.select(1) }
        }
        .onAppear {
            if notificationRouter.pendingOrderID != nil { tabState.select(1) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .novaDashSelectTab)) { notification in
            if let tab = notification.object as? Int, (0...2).contains(tab) {
                tabState.select(tab)
            }
        }
        .task {
            while !Task.isCancelled {
                if let userID = model.session?.userID,
                   let offers = try? await model.client.pendingDeliveryNotifications() {
                    await DeliveryOfferNotifier.shared.present(offers, userID: userID)
                }
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
    }
}

private struct NovaDashTabBar: View {
    @Binding var selection: Int

    var body: some View {
        NovaDashCanvas {
            ZStack(alignment: .topLeading) {
                Capsule()
                    .fill(Color.novaDashNavy)
                    .frame(width: 305, height: 77)
                    .offset(x: 49, y: 772)

                Capsule()
                    .fill(Color.novaDashIvory)
                    .overlay(Capsule().stroke(Color.novaDashNavy, lineWidth: 2))
                    .frame(width: 107, height: 77)
                    .offset(x: 49 + CGFloat(selection) * 99, y: 772)

                tabButton(index: 0, accessibilityLabel: "Order")
                    .offset(x: 49, y: 772)
                tabButton(index: 1, accessibilityLabel: "Deliver")
                    .offset(x: 150.667, y: 772)
                tabButton(index: 2, accessibilityLabel: "Account")
                    .offset(x: 252.333, y: 772)

                Image(systemName: "cart")
                    .font(.system(size: 28, weight: .light))
                    .foregroundColor(selection == 0 ? .novaDashNavy : .novaDashIvory)
                    .frame(width: 30, height: 30)
                    .offset(x: 87, y: 796)
                    .allowsHitTesting(false)

                Image("NovaDashScooterInner")
                    .renderingMode(.template)
                    .resizable()
                    .foregroundColor(selection == 1 ? .novaDashNavy : .novaDashIvory)
                    .frame(width: 44.95, height: 35.187)
                    .offset(x: 179.7, y: 792.8)
                    .allowsHitTesting(false)

                if selection == 2 {
                    Image(systemName: "person")
                        .font(.system(size: 27, weight: .light))
                        .foregroundColor(.novaDashNavy)
                        .frame(width: 30, height: 30)
                        .offset(x: 286, y: 795)
                        .allowsHitTesting(false)
                } else {
                    Image("NovaDashAccount")
                        .resizable()
                        .frame(width: 23, height: 28)
                        .offset(x: 289, y: 797)
                        .allowsHitTesting(false)
                }
            }
        }
    }

    private func tabButton(index: Int, accessibilityLabel: String) -> some View {
        Button {
            selection = index
        } label: {
            Rectangle()
                .fill(Color.white.opacity(0.001))
                .frame(width: 101.667, height: 77)
                .contentShape(Rectangle())
        }
        .buttonStyle(PlainButtonStyle())
        .contentShape(Rectangle())
        .zIndex(10)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(selection == index ? .isSelected : [])
    }
}

struct OrderFoodView: View {
    @StateObject private var selection = StoreSelectionModel()
    @StateObject private var diningHours = DiningHoursStore()

    var body: some View {
        ZStack {
            Color.novaDashIvory.ignoresSafeArea()
            NovaDashCanvas {
                ZStack(alignment: .topLeading) {
                    TimelineView(.periodic(from: .now, by: 60)) { timeline in
                        Text(orderPrompt(at: timeline.date))
                            .font(.custom("Georgia-BoldItalic", size: 31.474))
                            .foregroundColor(.novaDashNavy)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .frame(width: 300, alignment: .leading)
                            .offset(x: 90, y: 105)
                    }

                    storeRow(title: "COVA", store: "COVA", y: 175)
                    storeRow(title: "CASCIA", store: "Cascia", y: 270)
                    storeRow(title: "CONNELLY CENTER", store: "Connelly Center", y: 365)
                    storeRow(title: "ST. MARY’S", store: "St. Mary's", y: 460)
                    storeRow(title: "WAWA", store: "Wawa", y: 555)
                    storeRow(title: "HOLY GROUNDS", store: "Holy Grounds (Bartley)", y: 650)
                }
            }

            // Arrow rows push their page in from the right, like a navigation push.
            if let selectedStore = selection.selectedStore {
                OrderDetailsView(store: selectedStore.id) {
                    withAnimation(.novaDashSlide) { selection.selectedStore = nil }
                }
                .id(selectedStore.id)
                .transition(.novaDashSlide(.trailing))
                .zIndex(1)
            }
        }
        .preference(key: HidesTabBarKey.self, value: selection.selectedStore != nil)
        .navigationBarHidden(true)
        .task { await diningHours.monitor() }
        .preferredColorScheme(.light)
    }

    private func orderPrompt(at date: Date) -> String {
        switch Calendar.autoupdatingCurrent.component(.hour, from: date) {
        case 5..<11: return "morning coffee?"
        case 11..<14: return "lunch break?"
        case 14..<17: return "afternoon snack?"
        case 17..<21: return "dinner plans?"
        default: return "late night snack?"
        }
    }

    private func storeRow(title: String, store: String, y: CGFloat) -> some View {
        let isClosed = diningHours.isClosed(store)
        return ZStack(alignment: .topLeading) {
            Button {
                if !isClosed {
                    withAnimation(.novaDashSlide) { selection.selectedStore = StoreSelection(id: store) }
                }
            } label: {
                EmptyView()
            }
            .buttonStyle(StoreRowButtonStyle(
                title: title,
                isClosed: isClosed,
                // Stays solid while its page is open, then eases back on return.
                isSelected: selection.selectedStore?.id == store
            ))
            .offset(x: isClosed ? -71 : -10, y: y)
            .accessibilityLabel(isClosed ? "\(title), currently closed" : "\(title), currently open")
            .accessibilityHint(isClosed ? "Ordering is unavailable until this location reopens" : "Opens order details")

            if isClosed {
                closedClock(y: y + 24)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isClosed)
    }

    private func closedClock(y: CGFloat) -> some View {
        ZStack {
            Image("NovaDashClockRing")
                .resizable()
                .frame(width: 22, height: 22)
            Image("NovaDashClock")
                .resizable()
                .frame(width: 18.417, height: 18.417)
        }
        .offset(x: 315, y: y)
    }
}

/// Location row. Open locations are outlined and flip to solid navy while pressed;
/// closed locations are always solid with no arrow.
private struct StoreRowButtonStyle: ButtonStyle {
    let title: String
    let isClosed: Bool
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        let solid = isClosed || isSelected || configuration.isPressed
        return ZStack(alignment: .leading) {
            TrailingRoundedRectangle(radius: 35)
                .fill(solid ? Color.novaDashNavy : Color.novaDashIvory)
                .overlay {
                    TrailingRoundedRectangle(radius: 35)
                        .strokeBorder(Color.novaDashNavy, lineWidth: 2)
                }
            Text(title)
                .font(.custom(isClosed ? "Inter-SemiBold" : "Inter-Medium", size: 23.442))
                .foregroundColor(solid ? .novaDashIvory : .novaDashNavy)
                .padding(.leading, isClosed ? 82 : 45)
            if !isClosed {
                Image("NovaDashDisclosure")
                    .renderingMode(.template)
                    .resizable()
                    .foregroundColor(solid ? .novaDashIvory : .novaDashNavy)
                    .frame(width: 17.7455, height: 15.1042)
                    .rotationEffect(.degrees(90))
                    .offset(x: 2.3015)
                    .frame(width: 21, height: 21.677)
                    .offset(x: 318)
            }
        }
        .frame(width: 361, height: 70)
        .contentShape(Rectangle())
        .animation(.easeOut(duration: 0.12), value: solid)
    }
}

private struct StoreSelection: Identifiable {
    let id: String
}

private final class StoreSelectionModel: ObservableObject {
    @Published var selectedStore: StoreSelection?
}

private struct DiningOptionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.gray.opacity(0.14) : Color.clear)
            .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
    }
}

struct OrderDetailsView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var form: OrderForm
    @State private var activeOrder: Order?
    let onBack: () -> Void

    init(store: String, onBack: @escaping () -> Void) {
        UITextView.appearance().backgroundColor = .clear
        _form = StateObject(wrappedValue: OrderForm(store: store))
        self.onBack = onBack
    }

    var body: some View {
        ZStack {
            Color.novaDashNavy.ignoresSafeArea()
            NovaDashCanvas {
                ZStack(alignment: .topLeading) {
                    OrderTicketPanelShape(radius: 35.893)
                        .fill(Color.novaDashIvory)
                        .frame(width: 402, height: 797)
                        .offset(y: 132)

                    Button("back", action: onBack)
                        .font(.custom("Inter-Medium", size: 18.754))
                        .foregroundColor(.novaDashIvory)
                        .frame(width: 70, height: 44, alignment: .leading)
                        .offset(x: 24, y: 70)
                        .buttonStyle(.plain)
                        .accessibilityLabel("Back to dining options")

                    orderTicket
                }
            }
        }
        .novaDashEdgeSwipeBack(onBack)
        .fullScreenCover(item: $activeOrder) { order in
            CustomerOrderFlowView(initialOrder: order) {
                activeOrder = nil
                onBack()
            }
        }
        .preferredColorScheme(.light)
    }

    private var orderTicket: some View {
        Group {
            ticketBox(width: 230, height: 146, x: 24, y: 156.72)
            ticketBox(width: 354, height: 70, x: 24, y: 232.72)
            ticketBox(width: 354, height: 70, x: 24, y: 300.72)
            ticketBox(width: 354, height: 165, x: 24, y: 368.72)
            ticketBox(width: 235, height: 49, x: 24, y: 531.72)
            ticketBox(width: 121, height: 49, x: 257, y: 531.72)
            ticketBox(width: 235, height: 50, x: 24, y: 578.72)
            ticketBox(width: 121, height: 50, x: 257, y: 578.72)

            Text(form.store)
                .font(.custom("Georgia", size: 34.61))
                .tracking(1.73)
                .foregroundColor(.novaDashNavy)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(width: 210, height: 76, alignment: .center)
                .offset(x: 34, y: 156.72)

            ticketLabel("ORDER NUMBER:")
                .frame(width: 230, height: 70, alignment: .center)
                .offset(x: 24, y: 232.72)
            TextField("", text: $form.orderNumber)
                .textFieldStyle(.plain)
                .font(.custom("Georgia", size: 19.997))
                .foregroundColor(.novaDashNavy)
                .multilineTextAlignment(.center)
                .frame(width: 124, height: 70)
                .offset(x: 254, y: 232.72)
                .accessibilityLabel("Order number")

            TextField("", text: $form.items, prompt: ticketPrompt("DESCRIBE YOUR ORDER"))
                .textFieldStyle(.plain)
                .font(.custom("Georgia-Italic", size: 19.997))
                .foregroundColor(.novaDashNavy)
                .multilineTextAlignment(.center)
                .frame(width: 330, height: 70, alignment: .center)
                .offset(x: 36, y: 300.72)
                .accessibilityLabel("Describe your order")

            Group {
                if #available(iOS 16.0, *) {
                    TextEditor(text: $form.details)
                        .scrollContentBackground(.hidden)
                } else {
                    TextEditor(text: $form.details)
                }
            }
                .font(.custom("Georgia-Italic", size: 19.997))
                .foregroundColor(.novaDashNavy)
                .multilineTextAlignment(.leading)
                .environment(\.layoutDirection, .leftToRight)
                .padding(.horizontal, 20)
                .padding(.vertical, 7)
                .frame(width: 354, height: 165)
                .background(Color.clear)
                .offset(x: 24, y: 368.72)
                .accessibilityLabel("Extra notes")

            if form.details.isEmpty {
                ticketPrompt("EXTRA NOTES\n(EG. WHERE TO MEET)")
                    .multilineTextAlignment(.leading)
                    .frame(width: 304, height: 135, alignment: .topLeading)
                    .offset(x: 50, y: 384.72)
                    .allowsHitTesting(false)
            }

            ticketLabel("DELIVERY FEE:")
                .frame(width: 235, height: 49, alignment: .center)
                .offset(x: 24, y: 531.72)
            ticketLabel("$5.00")
                .frame(width: 121, height: 49, alignment: .center)
                .offset(x: 257, y: 531.72)
            ticketLabel("ESTIMATED TIME")
                .frame(width: 235, height: 50, alignment: .center)
                .offset(x: 24, y: 578.72)
            ticketLabel("20 mins")
                .frame(width: 121, height: 50, alignment: .center)
                .offset(x: 257, y: 578.72)

            Text("*You will only be charged when a student accepts delivery. No fees for canceling anytime before.")
                .font(.custom("Inter-Regular", size: 14.095))
                .foregroundColor(Color(red: 0.632, green: 0.632, blue: 0.632))
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 332, alignment: .leading)
                .offset(x: 27, y: 637.72)

            if let notice = form.notice {
                Text(notice)
                    .font(.custom("Inter-Regular", size: 14))
                    .foregroundColor(notice == "Order posted" ? .green : .red)
                    .frame(width: 332, alignment: .leading)
                    .offset(x: 27, y: 685)
            }

            Button {
                Task { await placeOrder() }
            } label: {
                Group {
                    if form.isPosting {
                        ProgressView().tint(.novaDashIvory)
                    } else {
                        Text("place order")
                            .font(.custom("Inter-Medium", size: 23.442))
                            .foregroundColor(.novaDashIvory)
                    }
                }
                .frame(width: 305, height: 77)
                .background(Color.novaDashNavy)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(form.isPosting)
            .offset(x: 48.5, y: 742)
            .accessibilityLabel("Place order")
        }
    }

    private func placeOrder() async {
        let orderNumber = form.orderNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        let items = form.items.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !orderNumber.isEmpty, !items.isEmpty else {
            form.notice = "Add the order number and describe your order."
            return
        }

        form.isPosting = true
        form.notice = nil
        do {
            // With card payments on, an order needs a saved card to charge
            // when a student accepts it.
            let payments = try await model.client.paymentStatus()
            if payments.enabled && payments.card == nil {
                guard try await model.addCard() else {
                    form.notice = "Add a card to place your order."
                    form.isPosting = false
                    return
                }
            }
            let order = try await model.client.createOrder(
                store: form.store,
                orderNumber: orderNumber,
                hall: form.hall,
                details: form.details.trimmingCharacters(in: .whitespacesAndNewlines),
                items: items,
                tip: Double(form.tip) ?? 5
            )
            activeOrder = order
        } catch {
            form.notice = error.localizedDescription
        }
        form.isPosting = false
    }

    private func ticketBox(width: CGFloat, height: CGFloat, x: CGFloat, y: CGFloat) -> some View {
        Rectangle()
            .strokeBorder(Color.novaDashNavy, lineWidth: 2)
            .frame(width: width, height: height)
            .offset(x: x, y: y)
    }

    private func ticketLabel(_ value: String) -> some View {
        Text(value)
            .font(.custom("Georgia", size: 19.997))
            .tracking(1)
            .foregroundColor(.novaDashNavy)
    }

    private func ticketPrompt(_ value: String) -> Text {
        Text(value)
            .font(.custom("Georgia-Italic", size: 19.997))
            .foregroundColor(.novaDashNavy.opacity(0.4))
            .tracking(1)
    }
}

private struct OrderTicketPanelShape: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        Path(UIBezierPath(
            roundedRect: rect,
            byRoundingCorners: [.topLeft],
            cornerRadii: CGSize(width: radius, height: radius)
        ).cgPath)
    }
}

struct CustomerOrderFlowView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var order: Order
    @State private var isClosing = false
    let onClose: (() -> Void)?

    init(initialOrder: Order, onClose: (() -> Void)? = nil) {
        _order = State(initialValue: initialOrder)
        self.onClose = onClose
    }

    var body: some View {
        ZStack {
            switch order.status {
            case "open":
                OrderConfirmationView(order: order, onCancelled: close)
                    .transition(.novaDashSlide(.top))
            case "claimed", "picked_up", "arrived":
                HandoffRecipientView(order: order, onComplete: close)
                    .transition(.novaDashSlide(.bottom))
            default:
                Color.novaDashIvory.ignoresSafeArea()
            }
        }
        .animation(.novaDashSlide, value: order.status)
        .task {
            while !Task.isCancelled {
                if let orders = try? await model.client.myOrders(),
                   let latest = orders.first(where: { $0.id == order.id }) {
                    order = latest
                    if latest.status == "delivered" || latest.status == "cancelled" {
                        close()
                        break
                    }
                }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
        .navigationBarHidden(true)
        .preferredColorScheme(.light)
    }

    private func close() {
        guard !isClosing else { return }
        isClosing = true
        if let onClose { onClose() } else { dismiss() }
    }
}

private struct OrderConfirmationView: View {
    @EnvironmentObject private var model: AppModel
    @State private var isCancelling = false
    @State private var error: String?
    let order: Order
    let onCancelled: () -> Void

    var body: some View {
        ZStack {
            Color.novaDashIvory.ignoresSafeArea()
            NovaDashCanvas {
                ZStack(alignment: .topLeading) {
                    Text("Thanks for your order!")
                        .font(.custom("Georgia-BoldItalic", size: 27.892))
                        .tracking(1.3946)
                        .foregroundColor(.novaDashNavy)
                        .offset(x: 37, y: 277)

                    Text("We will notify you once a student accepts the delivery")
                        .font(.custom("Inter-SemiBold", size: 23.25))
                        .foregroundColor(.novaDashNavy)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: 239.063, alignment: .leading)
                        .offset(x: 37, y: 337.96)

                    Image("NovaDashHandoffMascot")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 104, height: 95.043)
                        .offset(x: 32, y: 454)

                    Capsule()
                        .stroke(Color.novaDashNavy, lineWidth: 2)
                        .frame(width: 333, height: 8)
                        .offset(x: 37, y: 565)

                    Image("NovaDashConfirmProgress")
                        .frame(width: 19, height: 4)
                        .offset(x: 39, y: 567)

                    Text("Notifying Students")
                        .font(.custom("Inter-Regular", size: 9.613))
                        .italic()
                        .foregroundColor(.black)
                        .offset(x: 37, y: 584)

                    Image("NovaDashLocation")
                        .frame(width: 16, height: 20)
                        .offset(x: 349, y: 527)

                    Button {
                        Task { await cancelOrder() }
                    } label: {
                        Group {
                            if isCancelling {
                                ProgressView().tint(.novaDashNavy)
                            } else {
                                Text("cancel order")
                                    .font(.custom("Inter-Regular", size: 20.282))
                                    .foregroundColor(.novaDashNavy)
                            }
                        }
                        .frame(width: 160, height: 48)
                    }
                    .buttonStyle(.plain)
                    .disabled(isCancelling)
                    .offset(x: 121, y: 664)

                    if let error {
                        Text(error)
                            .font(.custom("Inter-Regular", size: 12))
                            .foregroundColor(.red)
                            .multilineTextAlignment(.center)
                            .frame(width: 320)
                            .offset(x: 41, y: 724)
                    }
                }
            }
        }
    }

    private func cancelOrder() async {
        guard !isCancelling else { return }
        isCancelling = true
        error = nil
        do {
            try await model.client.cancelOrder(order.id)
            onCancelled()
        } catch {
            self.error = error.localizedDescription
        }
        isCancelling = false
    }
}

struct DeliverView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var notificationRouter = DeliveryNotificationRouter.shared
    @StateObject private var state = DeliveryState()
    @StateObject private var location = DeliveryLocation()
    @State private var entranceDone = false
    let onBack: () -> Void

    private var displayedOrder: Order? {
        if let selectedOrder = state.selectedOrder { return selectedOrder }
        return state.activeOrders.first
    }

    var body: some View {
        // A ZStack (not a Group) so both pages share one animated container.
        ZStack {
            if let order = displayedOrder {
                DeliveryRequestDetailsView(
                    order: order,
                    notification: state.notifications.first { $0.orderID == order.id },
                    onAccepted: { Task { await load() } },
                    onBack: goBack
                )
                .novaDashEdgeSwipeBack(goBack)
                .id(order.id)
                .transition(.novaDashSlide(.trailing))
                .zIndex(1)
            } else {
                DeliveryRequestsListView(
                    orders: state.orders,
                    error: state.error,
                    animatesEntrance: !entranceDone,
                    onRetry: { Task { await load() } },
                    onSelect: { order in
                        withAnimation(.novaDashSlide) { state.selectedOrder = order }
                    }
                )
                .transition(.novaDashSlide(.leading))
            }
        }
        .animation(.novaDashSlide, value: displayedOrder?.id)
        .onAppear {
            // Later returns to the list (e.g. back from a request) just slide in.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { entranceDone = true }
        }
        // Request details and handoff screens use the bottom of the screen themselves.
        .preference(key: HidesTabBarKey.self, value: displayedOrder != nil)
        .task {
            location.start()
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
        .onReceive(location.$coordinate.compactMap { $0 }) { coordinate in
            Task { try? await model.client.upsertRunnerLocation(latitude: coordinate.latitude, longitude: coordinate.longitude) }
        }
        .onChange(of: notificationRouter.pendingOrderID) { orderID in
            if orderID != nil { Task { await load() } }
        }
        .alert("Delivery unavailable", isPresented: $state.unavailableNotification) {
            Button("OK", role: .cancel) { }
        } message: {
            Text("This request has already been accepted or is no longer open.")
        }
    }

    private func goBack() {
        if state.selectedOrder != nil {
            withAnimation(.novaDashSlide) { state.selectedOrder = nil }
        } else {
            onBack()
        }
    }

    private func load() async {
        var loadedOpenOrders = false
        do {
            let orders = try await model.client.openOrders()
            state.activeOrders = try await model.client.myAssignedOrders()
            let notifications = (try? await model.client.pendingDeliveryNotifications()) ?? []
            state.notifications = notifications
            state.orders = orders.filter { order in
                order.ordererID != model.session?.userID || notifications.contains {
                    $0.orderID == order.id && $0.isDashboardTestOffer
                }
            }
            state.error = nil
            loadedOpenOrders = true
            if let selectedOrder = state.selectedOrder,
               let refreshedOrder = (state.orders + state.activeOrders).first(where: { $0.id == selectedOrder.id }) {
                state.selectedOrder = refreshedOrder
            }
        } catch {
            state.orders = []
            state.activeOrders = []
            state.error = error.localizedDescription
        }
        // Notifications are optional until migration 003 is installed. Keep
        // the normal delivery list usable if that migration is not present.
        if loadedOpenOrders, let orderID = notificationRouter.pendingOrderID {
            notificationRouter.pendingOrderID = nil
            if let order = (state.orders + state.activeOrders).first(where: { $0.id == orderID }) {
                state.selectedOrder = order
            } else {
                state.unavailableNotification = true
            }
        }
    }
}

private struct DeliveryRequestsListView: View {
    let orders: [Order]
    let error: String?
    let onRetry: () -> Void
    let onSelect: (Order) -> Void
    @State private var titleIn: Bool
    @State private var requestsIn: Bool

    init(orders: [Order], error: String?, animatesEntrance: Bool, onRetry: @escaping () -> Void, onSelect: @escaping (Order) -> Void) {
        self.orders = orders
        self.error = error
        self.onRetry = onRetry
        self.onSelect = onSelect
        _titleIn = State(initialValue: !animatesEntrance)
        _requestsIn = State(initialValue: !animatesEntrance)
    }

    var body: some View {
        // No background of its own: the tab's ivory shows through, so the
        // previous tab stays visible as it slides away during the entrance.
        ZStack {
            NovaDashCanvas {
                ZStack(alignment: .topLeading) {
                    Text("DELIVERY REQUESTS")
                        .font(.custom("Inter-SemiBold", size: 25.867))
                        .foregroundColor(.novaDashNavy)
                        .offset(x: 17 + (titleIn ? 0 : 402), y: 80)

                    ScrollView(showsIndicators: false) {
                        LazyVStack(spacing: 19) {
                            ForEach(Array(orders.enumerated()), id: \.element.id) { entry in
                                requestRow(entry.element, index: entry.offset)
                                    // Requests that load after the entrance rise in too, staggered.
                                    .transition(.novaDashSlide(.bottom).animation(.novaDashSlide.delay(Double(entry.offset) * 0.05)))
                            }

                            if orders.isEmpty {
                                VStack(spacing: 12) {
                                    Text(error == nil ? "No current requests" : "Couldn’t load requests")
                                        .font(.custom("Inter-SemiBold", size: 21.537))
                                    Text(error ?? "Check back soon.")
                                        .font(.custom("Inter-Regular", size: 14))
                                        .foregroundColor(.novaDashNavy.opacity(0.65))
                                        .multilineTextAlignment(.center)
                                    Button("Refresh", action: onRetry)
                                        .font(.custom("Inter-Medium", size: 16))
                                        .frame(width: 120, height: 44)
                                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.novaDashNavy, lineWidth: 2))
                                        .buttonStyle(.plain)
                                }
                                .foregroundColor(.novaDashNavy)
                                .frame(width: 368)
                                .padding(.top, 42)
                            }
                        }
                    }
                    .animation(.novaDashSlide, value: orders.map(\.id))
                    .frame(width: 402, height: 609)
                    .offset(y: 141 + (requestsIn ? 0 : 874))
                }
            }
        }
        .onAppear {
            guard !titleIn else { return }
            withAnimation(.novaDashSlide) { titleIn = true }
            withAnimation(.novaDashSlide.delay(0.06)) { requestsIn = true }
        }
        .preferredColorScheme(.light)
    }

    private func requestRow(_ order: Order, index: Int) -> some View {
        Button { onSelect(order) } label: {
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 25)
                    .fill(Color.novaDashNavy)
                    .overlay(RoundedRectangle(cornerRadius: 25).stroke(Color.novaDashNavy, lineWidth: 2))
                    .frame(width: index == 0 ? 438 : 420, height: 87)
                    .offset(x: index == 0 ? -53 : -35)

                HStack(alignment: .center, spacing: 15) {
                    Text(order.store.uppercased())
                        .font(.custom("Inter-Regular", size: 21.537))
                        .foregroundColor(.novaDashIvory)
                        .lineLimit(1)
                        .minimumScaleFactor(0.1)
                        .allowsTightening(true)

                    Image("NovaDashRequestRouteArrow")
                        .frame(width: 44.3783, height: 44.3783)
                        .fixedSize()
                }
                .frame(width: 116.3783, height: 44.3783, alignment: .leading)
                .offset(x: 43, y: 10)

                Text(destination(for: order))
                    .font(.custom("Inter-Regular", size: 21.537))
                    .foregroundColor(.novaDashIvory)
                    .lineLimit(1)
                    .minimumScaleFactor(0.1)
                    .allowsTightening(true)
                    .frame(width: 172, alignment: .leading)
                    .offset(x: 43, y: 45)

                Text(String(format: "$%.2f", order.runnerPayout))
                    .font(.custom("Inter-Regular", size: 30.311))
                    .foregroundColor(.novaDashIvory)
                    .frame(width: 88, alignment: .leading)
                    .offset(x: 233, y: 25)

                Image("NovaDashRequestDisclosure")
                    .rotationEffect(.degrees(90))
                    .frame(width: 21, height: 21.677)
                    .offset(x: 337, y: 33)
            }
            .frame(width: 402, height: 87, alignment: .topLeading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Delivery request from \(order.store) to \(order.hall)")
    }

    private func destination(for order: Order) -> String {
        let hall = order.hall.trimmingCharacters(in: .whitespacesAndNewlines)
        return hall.isEmpty ? "LOCATION PENDING" : hall.uppercased()
    }
}

@MainActor private final class DeliveryRequestDetailState: ObservableObject {
    @Published var isAccepting = false
    @Published var isAccepted: Bool
    @Published var error: String?

    init(isAccepted: Bool) { self.isAccepted = isAccepted }
}

private struct DeliveryRequestDetailsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var state: DeliveryRequestDetailState
    @State private var swipeOffset: CGFloat = 0
    @State private var swipeArmed = false
    @State private var chevronHint = false
    // Set as accepting starts (a render before the swap) so the outgoing
    // details already carry the upward transition.
    @State private var liftsIntoHandoff = false

    private static let swipeThreshold: CGFloat = 110
    // Far enough to carry the ticket (bottom edge at 675 + action) off the top.
    private static let offscreenOffset: CGFloat = 900

    let order: Order
    let notification: DeliveryNotification?
    let onAccepted: () -> Void
    let onBack: (() -> Void)?

    init(
        order: Order,
        notification: DeliveryNotification?,
        onAccepted: @escaping () -> Void,
        onBack: (() -> Void)? = nil
    ) {
        self.order = order
        self.notification = notification
        self.onAccepted = onAccepted
        self.onBack = onBack
        _state = StateObject(wrappedValue: DeliveryRequestDetailState(
            isAccepted: ["claimed", "picked_up", "arrived"].contains(order.status)
        ))
    }

    private var destination: String {
        let hall = order.hall.trimmingCharacters(in: .whitespacesAndNewlines)
        return hall.isEmpty ? "Location shared after acceptance" : hall
    }

    private var meetingNote: String {
        let notes = order.dropoffDetails.trimmingCharacters(in: .whitespacesAndNewlines)
        return notes.isEmpty ? "Meeting details available after acceptance" : notes
    }

    var body: some View {
        Group {
            if state.isAccepted {
                HandoffRunnerView(
                    order: order,
                    onCancelled: {
                        onAccepted()
                        if let onBack { onBack() } else { dismiss() }
                    },
                    onComplete: {
                        onAccepted()
                        if let onBack { onBack() } else { dismiss() }
                    }
                )
                // Rises only after a swipe-accept; otherwise it arrives with the page from the right.
                .transition(liftsIntoHandoff ? .novaDashSlide(.bottom) : .identity)
            } else {
                ZStack {
                    Color.novaDashNavy.ignoresSafeArea()
                    NovaDashCanvas {
                        ZStack(alignment: .topLeading) {
                            DeliveryDetailsBottomCorners(radius: 35)
                                .fill(Color.novaDashIvory)
                                .frame(width: 402, height: 797)
                                .offset(y: -122)

                            deliveryTicket
                            deliveryAction
                        }
                        // The whole ticket lifts with the finger while swiping.
                        .offset(y: -swipeOffset)
                    }

                    if state.isAccepting && swipeOffset >= Self.offscreenOffset {
                        VStack(spacing: 14) {
                            ProgressView()
                                .tint(.novaDashIvory)
                                .scaleEffect(1.25)
                            Text("Accepting order…")
                                .font(.custom("Inter-Regular", size: 20.282))
                                .foregroundColor(.novaDashIvory)
                        }
                        .transition(.opacity)
                    }
                }
                .transition(liftsIntoHandoff ? .novaDashSlide(.top) : .identity)
            }
        }
        .preferredColorScheme(.light)
    }

    private var deliveryTicket: some View {
        Group {
            Button("back") {
                if let onBack { onBack() } else { dismiss() }
            }
                .font(.custom("Inter-Medium", size: 18.754))
                .foregroundColor(.novaDashNavy)
                .frame(width: 70, height: 44, alignment: .leading)
                .offset(x: 34, y: 70)
                .buttonStyle(.plain)
                .accessibilityLabel("Back to delivery requests")

            deliveryBox(width: 354, height: 70, x: 24, y: 133)
            deliveryBox(width: 354, height: 70, x: 24, y: 201)
            deliveryBox(width: 354, height: 182, x: 24, y: 201)
            deliveryBox(width: 235, height: 50, x: 24, y: 381)
            deliveryBox(width: 121, height: 50, x: 257, y: 381)
            deliveryBox(width: 235, height: 50, x: 24, y: 429)
            deliveryBox(width: 121, height: 50, x: 257, y: 429)

            Image("NovaDashTicketDivider")
                .resizable()
                .frame(width: 138, height: 2)
                .rotationEffect(.degrees(90))
                .offset(x: 89, y: 201)

            deliveryLabel("PICKUP:")
                .frame(width: 135, height: 70, alignment: .center)
                .offset(x: 24, y: 133)
            deliveryLabel(order.store.uppercased())
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(width: 199, height: 70, alignment: .center)
                .offset(x: 169, y: 133)
            deliveryLabel("DELIVER:")
                .frame(width: 135, height: 70, alignment: .center)
                .offset(x: 24, y: 201)
            deliveryLabel(destination.uppercased())
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(width: 199, height: 70, alignment: .center)
                .offset(x: 169, y: 201)
            deliveryLabel(meetingNote.uppercased())
                .multilineTextAlignment(.center)
                .frame(width: 314, height: 112, alignment: .center)
                .offset(x: 44, y: 271)

            deliveryLabel("PAYOUT:")
                .frame(width: 235, height: 50, alignment: .center)
                .offset(x: 24, y: 381)
            deliveryLabel(String(format: "$%.2f", order.runnerPayout))
                .frame(width: 121, height: 50, alignment: .center)
                .offset(x: 257, y: 381)
            deliveryLabel("ESTIMATED TIME:")
                .frame(width: 235, height: 50, alignment: .center)
                .offset(x: 24, y: 429)
            deliveryLabel("20 mins")
                .frame(width: 121, height: 50, alignment: .center)
                .offset(x: 257, y: 429)

            if let error = state.error {
                Text(error)
                    .font(.custom("Inter-Regular", size: 13))
                    .foregroundColor(.red)
                    .frame(width: 354, alignment: .leading)
                    .offset(x: 24, y: 500)
            }
        }
    }

    private var swipeProgress: CGFloat { min(swipeOffset / Self.swipeThreshold, 1) }
    // VoiceOver's accept action has no swipe, so it sends the ticket up itself.
    private func acceptFromAccessibility() {
        withAnimation(.easeIn(duration: 0.35)) { swipeOffset = Self.offscreenOffset }
        accept()
    }

    private var swipeTitle: String {
        if state.isAccepting { return "Accepting order…" }
        return swipeProgress >= 1 ? "Release to Accept" : "Swipe to Accept Order"
    }

    private var deliveryAction: some View {
        VStack(spacing: 0) {
            Image(systemName: "chevron.up")
                .font(.system(size: 20, weight: .semibold))
                .frame(width: 40, height: 40)
                .offset(y: chevronHint ? -6 : 0)
                .scaleEffect(1 + 0.25 * swipeProgress)
            Text(swipeTitle)
                .font(.custom("Inter-Regular", size: 27.129))
                .padding(.top, -5)
            Text("Full details will show when order is accepted")
                .font(.custom("Inter-Regular", size: 11.395))
                .padding(.top, 4)
                .opacity(1 - swipeProgress)
        }
        .foregroundColor(.novaDashIvory)
        .frame(width: 402, height: 199, alignment: .top)
        .padding(.top, 14)
        .contentShape(Rectangle())
        .gesture(swipeGesture)
        .offset(y: 675)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { chevronHint = true }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Swipe up to accept delivery request")
        .accessibilityAction(.default, acceptFromAccessibility)
    }

    private var swipeGesture: some Gesture {
        // Global space: the view moves with the drag, so local translation would feed back.
        DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .onChanged { value in
                guard !state.isAccepting else { return }
                let pulled = max(0, -value.translation.height)
                // Track the finger 1:1, all the way up.
                swipeOffset = pulled
                let armed = pulled >= Self.swipeThreshold
                if armed != swipeArmed {
                    swipeArmed = armed
                    if armed { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
                }
            }
            .onEnded { value in
                guard !state.isAccepting else { return }
                let pulled = -value.translation.height
                // A quick upward flick counts even if it ends short of the threshold.
                let flung = pulled > 40 && -value.predictedEndTranslation.height >= Self.swipeThreshold * 1.5
                swipeArmed = false
                if pulled >= Self.swipeThreshold || flung {
                    // Carry on with the release velocity and send the ticket off the top.
                    let velocity = max(0, -value.velocity.height) / max(Self.offscreenOffset - swipeOffset, 1)
                    withAnimation(.interpolatingSpring(stiffness: 120, damping: 20, initialVelocity: velocity)) {
                        swipeOffset = Self.offscreenOffset
                    }
                    accept()
                } else {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.65)) { swipeOffset = 0 }
                }
            }
    }

    private func deliveryBox(width: CGFloat, height: CGFloat, x: CGFloat, y: CGFloat) -> some View {
        Rectangle()
            .strokeBorder(Color.novaDashNavy, lineWidth: 2)
            .frame(width: width, height: height)
            .offset(x: x, y: y)
    }

    private func deliveryLabel(_ value: String) -> some View {
        Text(value)
            .font(.custom("Georgia", size: 19.997))
            .tracking(1)
            .foregroundColor(.novaDashNavy)
    }

    private func accept() {
        guard !state.isAccepting else { return }
        state.isAccepting = true
        state.error = nil
        liftsIntoHandoff = true
        let haptics = UINotificationFeedbackGenerator()
        haptics.prepare()
        Task {
            do {
                try await model.client.claim(order, with: notification)
                if let notification {
                    try? await model.client.respondToDeliveryNotification(notification, accepted: true)
                }
                haptics.notificationOccurred(.success)
                onAccepted()
                withAnimation(.novaDashSlide) { state.isAccepted = true }
                // After the lift, leaving the handoff page should only slide sideways.
                try? await Task.sleep(nanoseconds: 600_000_000)
                liftsIntoHandoff = false
            } catch {
                haptics.notificationOccurred(.error)
                liftsIntoHandoff = false
                state.error = error.localizedDescription
                withAnimation(.spring(response: 0.4, dampingFraction: 0.65)) { swipeOffset = 0 }
            }
            state.isAccepting = false
        }
    }
}

private struct DeliveryDetailsBottomCorners: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        Path(UIBezierPath(
            roundedRect: rect,
            byRoundingCorners: [.bottomLeft, .bottomRight],
            cornerRadii: CGSize(width: radius, height: radius)
        ).cgPath)
    }
}

@MainActor private final class AccountScreenState: ObservableObject {
    @Published var showUnavailable = false
    @Published var alertTitle = "Not available yet"
    @Published var unavailableMessage = ""
    @Published var isWorking = false

    func show(_ title: String, _ message: String) {
        alertTitle = title
        unavailableMessage = message
        showUnavailable = true
    }
}

struct AccountView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var state = AccountScreenState()

    var body: some View {
        NavigationView {
            ZStack {
                Color.novaDashIvory.ignoresSafeArea()
                NovaDashCanvas {
                    ZStack(alignment: .topLeading) {
                        Text(model.accountName.uppercased())
                            .font(.custom("Inter-SemiBold", size: 25.867))
                            .foregroundColor(.novaDashNavy)
                            .frame(width: 350, alignment: .leading)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .offset(x: 32, y: 79)

                        Text(model.profile?.email ?? model.session?.email ?? "")
                            .font(.novaDashItalic(size: 20.466))
                            .foregroundColor(.novaDashNavy)
                            .frame(width: 350, alignment: .leading)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .offset(x: 32, y: 111)

                        LeadingRoundedRectangle(radius: 35)
                            .fill(Color.novaDashNavy)
                            .frame(width: 449, height: 134)
                            .offset(x: 68, y: 196)

                        Text(balanceText)
                            .font(.custom("Inter-SemiBold", size: 59.599))
                            .foregroundColor(.novaDashIvory)
                            .minimumScaleFactor(0.65)
                            .lineLimit(1)
                            .padding(.horizontal, 24)
                            .frame(width: 402 - 68, height: 134, alignment: .center)
                            .offset(x: 68, y: 196)

                        Text("Current Balance")
                            .font(.custom("Inter-SemiBold", size: 18.978))
                            .foregroundColor(.novaDashNavy)
                            .frame(width: 180, alignment: .leading)
                            .offset(x: 220, y: 337)

                        profileDivider(y: 442.7)
                        profileDivider(y: 506.34)
                        profileDivider(y: 570)
                        profileDivider(y: 634)
                        profileDivider(y: 699)

                        NavigationLink(destination: AccountOrdersView()) {
                            AccountMenuRow(title: "Orders", height: 64)
                        }
                        .offset(y: 379)

                        Button {
                            Task { await addCard() }
                        } label: {
                            AccountMenuRow(title: paymentMethodTitle, height: 64)
                        }
                        .disabled(state.isWorking)
                        .offset(y: 443)

                        NavigationLink(destination: AccountInfoView()) {
                            AccountMenuRow(title: "Edit Account Info", height: 64)
                        }
                        .offset(y: 507)

                        Button {
                            Task { await openPayouts() }
                        } label: {
                            AccountMenuRow(title: model.paymentStatus?.payouts.ready == true ? "Withdraw" : "Set Up Payouts", height: 64)
                        }
                        .disabled(state.isWorking)
                        .offset(y: 571)

                        Button {
                            model.signOut()
                        } label: {
                            AccountMenuRow(title: "Logout", height: 64)
                        }
                        .offset(y: 635)
                    }
                }
            }
            .navigationBarHidden(true)
            .task {
                await model.loadProfile()
                await model.loadTestBalance()
                await model.loadPaymentStatus()
            }
            .refreshable {
                await model.loadTestBalance()
                await model.loadPaymentStatus()
            }
            .alert(state.alertTitle, isPresented: $state.showUnavailable) {
                Button("OK", role: .cancel) { }
            } message: {
                Text(state.unavailableMessage)
            }
        }
        .navigationViewStyle(.stack)
        .preferredColorScheme(.light)
    }

    // Real earnings once payouts are connected; test credits until then.
    private var balanceText: String {
        let cents = model.paymentStatus?.balanceCents ?? model.testBalanceCents
        return cents.map { String(format: "$%.2f", Double($0) / 100) } ?? "$0.00"
    }

    private var paymentMethodTitle: String {
        guard let card = model.paymentStatus?.card else { return "Add/Edit Payment Method" }
        return "\(card.brand.capitalized) •••• \(card.last4)"
    }

    private func addCard() async {
        if model.paymentStatus == nil { await model.loadPaymentStatus() }
        guard model.paymentStatus?.enabled == true else {
            state.show("Not available yet", "Card payments aren't turned on yet.")
            return
        }
        state.isWorking = true
        do {
            if try await model.addCard() { state.show("Card saved", "You'll be charged the delivery fee when a student accepts your order.") }
        } catch {
            state.show("Card not saved", error.localizedDescription)
        }
        state.isWorking = false
    }

    private func openPayouts() async {
        if model.paymentStatus == nil { await model.loadPaymentStatus() }
        guard model.paymentStatus?.enabled == true else {
            state.show("Not available yet", "Test credits can't be withdrawn, and payouts aren't turned on yet.")
            return
        }
        state.isWorking = true
        do {
            try await model.openPayouts()
        } catch {
            state.show("Payouts", error.localizedDescription)
        }
        state.isWorking = false
    }

    private func profileDivider(y: CGFloat) -> some View {
        Rectangle()
            .fill(Color.novaDashNavy)
            .frame(width: 402, height: 1)
            .offset(y: y)
    }
}

private struct AccountMenuRow: View {
    let title: String
    let height: CGFloat

    var body: some View {
        ZStack(alignment: .leading) {
            Rectangle()
                .fill(Color.novaDashIvory.opacity(0.001))
            Text(title)
                .font(.custom("Inter-Regular", size: 18.754))
                .foregroundColor(.novaDashNavy)
                .padding(.leading, 32)
        }
        .frame(width: 402, height: height, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct LeadingRoundedRectangle: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        Path(UIBezierPath(
            roundedRect: rect,
            byRoundingCorners: [.topLeft, .bottomLeft],
            cornerRadii: CGSize(width: radius, height: radius)
        ).cgPath)
    }
}

@MainActor private final class AccountOrdersState: ObservableObject {
    @Published var orders: [Order] = []
    @Published var error: String?

    func load(client: SupabaseClient) async {
        do { orders = try await client.myOrders(); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

private struct AccountOrdersView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var state = AccountOrdersState()

    var body: some View {
        List(state.orders) { order in
            Group {
                if ["open", "claimed", "picked_up", "arrived"].contains(order.status) {
                    NavigationLink(destination: CustomerOrderFlowView(initialOrder: order)) {
                        orderSummary(order)
                    }
                } else {
                    orderSummary(order)
                }
            }
        }
        .overlay {
            if state.orders.isEmpty {
                Text(state.error ?? "No orders yet")
                    .font(.custom("Inter-Regular", size: 16))
                    .foregroundColor(.secondary)
            }
        }
        .navigationTitle("Orders")
        .task { await state.load(client: model.client) }
        .refreshable { await state.load(client: model.client) }
    }

    private func orderSummary(_ order: Order) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(order.store).font(.custom("Inter-SemiBold", size: 17))
            Text(order.items).font(.custom("Inter-Regular", size: 15))
            Text(order.status == "open" ? "Waiting for a student" : (["claimed", "picked_up", "arrived"].contains(order.status) ? "Show handoff code" : order.status.capitalized))
                .font(.custom("Inter-Regular", size: 13))
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 5)
    }
}

@MainActor private final class AccountInfoForm: ObservableObject {
    @Published var name = ""
    @Published var phone = ""
    @Published var notice: String?
    @Published var isSaving = false

    func load(_ profile: Profile?, fallbackName: String?) {
        let savedName = profile?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        name = savedName.isEmpty ? (fallbackName ?? "") : savedName
        phone = profile?.phone ?? ""
    }
}

private struct AccountInfoView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var form = AccountInfoForm()

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $form.name)
                Text(model.profile?.email ?? model.session?.email ?? "")
                    .foregroundColor(.secondary)
                TextField("Phone", text: $form.phone)
                    .keyboardType(.phonePad)
            } header: {
                Text("Account").font(.custom("Inter-Medium", size: 13))
            }
            Section {
                Button(form.isSaving ? "Saving…" : "Save changes", action: save)
                    .disabled(form.isSaving || form.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let notice = form.notice { Text(notice).font(.custom("Inter-Regular", size: 13)) }
            }
            Section {
                Button("Sign out", role: .destructive) { model.signOut() }
            }
        }
        .font(.custom("Inter-Regular", size: 17))
        .navigationTitle("Account Info")
        .task {
            if model.profile == nil { await model.loadProfile() }
            form.load(model.profile, fallbackName: model.authDisplayName)
        }
    }

    private func save() {
        form.isSaving = true
        Task {
            do {
                model.profile = try await model.client.updateProfile(
                    name: form.name.trimmingCharacters(in: .whitespacesAndNewlines),
                    phone: form.phone.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                form.notice = "Saved"
            } catch { form.notice = error.localizedDescription }
            form.isSaving = false
        }
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label.font(.custom("Inter-Bold", size: 16)).frame(maxWidth: .infinity).padding(.vertical, 16).foregroundColor(.white).background(Color(red: 0, green: 0.125, blue: 0.357)).cornerRadius(9).opacity(configuration.isPressed ? 0.8 : 1) }
}
