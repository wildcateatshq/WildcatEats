# Wildcat Eats mobile app

This repository includes a native SwiftUI iOS client under `ios/` and a public
landing/admin website. The iOS client talks directly to Supabase and does not
load `novadash.online` or a remote webview. Legacy web ordering pages and APIs
are no longer available from the website.

## Native iOS Supabase setup

1. Run `supabase/migrations/001_native_app.sql` and then
   `supabase/migrations/002_order_map.sql` and
   `supabase/migrations/003_delivery_notifications.sql` in the Supabase SQL Editor. If you
   already tried the second file and got a schema/type error, just run the
   updated `002_order_map.sql` again; it is self-contained and keeps the
   native app's UUID profiles in `public.native_profiles`, separate from any
   legacy integer-based `public.profiles` table.
   Then run `supabase/migrations/005_native_delivery_handoff.sql` to enable
   one-time, server-verified delivery completion. This migration revokes direct
   native-order updates and replaces claiming with a checked RPC, so install it
   before running the updated iOS app. Apply the remaining migrations in number
   order through `009_store_hours_overrides.sql`; migration 009 enables the
   admin dashboard's persistent **Force open** control for dining locations.
2. Put your project URL and public anon key in `ios/App/App/NativeApp.swift`.
3. Open `ios/App/App.xcodeproj` in Xcode and run the `App` scheme.

The native client includes email/password auth, order creation, open delivery
orders, nearby delivery offers, claiming, live runner location updates, and
local session persistence. The order screen shows the order number, items, and
estimated delivery fee. The Deliver screen lists open requests, marks nearby
offers, and opens a delivery preview with pickup, destination, fee, a
placeholder 20-minute ETA, and a swipe-up accept control. Full order details
appear after acceptance. Tapping an iOS notification opens this preview when
its payload includes the order UUID as `order_id` (or `data.order_id`).
Background lock-screen push notifications still require a server-side APNs
sender; the current Supabase migration records nearby offers but does not send
APNs pushes itself.

To complete a claimed delivery, the recipient opens Account → Orders → the
claimed order. The deliverer opens Deliver → Your deliveries → Complete Delivery.
On two UWB-capable iPhones with both app screens open, bringing the phones
together confirms the handoff using Nearby Interaction and an encrypted local
connection. If tap is unavailable, the deliverer scans the recipient's one-time
QR code. Both paths use the same 10-minute, single-use server token. This is
proximity-based tap, not NFC card emulation, and needs two physical iPhones for
tap testing. QR scanning needs a physical device with a camera. The dashboard's
explicit test-fulfill action remains an admin-only bypass and does not exercise
the handoff flow.

## Open the native projects

```sh
npm run mobile:ios       # opens ios/App/App.xcodeproj in Xcode
npm run mobile:android   # opens android/ in Android Studio
```

The iOS project is dependency-free native SwiftUI and needs an Apple Developer signing team. Set the
bundle identifier and signing team in Xcode before archiving for App Store Connect.
The existing Android Capacitor shell uses the retired web ordering flow, so it
will need a separate native/Supabase implementation before it can place orders.

The iOS project targets iOS 15+, which matches current Xcode simulator SDKs.

## Store readiness

Before submission, add the production privacy-policy URL, App Store screenshots,
support contact, and finalized app icons in App Store Connect. The app requests
location only for a runner's delivery tracking flow; the native projects
include the corresponding location permission declarations.
