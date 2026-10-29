const crypto = require("node:crypto");
const express = require("express");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@%_,()]+@[^\s@%_,()]+\.[^\s@%_,()]+$/;
const TEST_MARKER_TITLE = "Admin dashboard test order";
const TEST_OFFER_TITLE = "Test delivery request";
const STORES = {
  COVA: [40.03538279831171, -75.34114479601725],
  Cascia: [40.0365, -75.3520],
  "Connelly Center": [40.035895224812755, -75.34028222907769],
  "St. Mary's": [40.04028393357511, -75.34165260914898],
  Wawa: [40.035895224812755, -75.34028222907769],
  "Holy Grounds (Bartley)": [40.03481273056283, -75.3383313736512]
};

function dollars(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(value)) return null;
  const cents = Math.round(Number(value) * 100);
  return cents <= 100000 ? cents / 100 : null;
}

function validEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL.test(value);
}

async function nativeRequest(table, params = {}, { method = "GET", body, upsert = false } = {}) {
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!/^https:\/\/[^/]+$/.test(base) || !key) {
    const error = new Error("Native orders are not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY on the server.");
    error.status = 503;
    throw error;
  }
  const headers = { apikey: key, Accept: "application/json" };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  if (body) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers.Prefer = upsert ? "return=representation,resolution=merge-duplicates" : "return=representation";
  const response = await fetch(`${base}/rest/v1/${table}?${new URLSearchParams(params)}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.code === "PGRST205" || payload?.code === "42P01"
        ? "Native app tables are missing. Apply the native-app Supabase migrations first."
        : (payload?.message || "Supabase native-order request failed.")
    );
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

async function accountByEmail(email) {
  const profiles = await nativeRequest("native_profiles", { select: "id,name,email", email: `eq.${email.toLowerCase()}`, limit: "1" });
  return profiles[0] || null;
}

async function isDashboardTestOrder(orderID) {
  const markers = await nativeRequest("native_delivery_notifications", {
    select: "id", order_id: `eq.${orderID}`, title: `eq.${TEST_MARKER_TITLE}`,
    status: "eq.expired", limit: "1"
  });
  return markers.length > 0;
}

async function markDashboardTestOrder(order) {
  await nativeRequest("native_delivery_notifications", {}, { method: "POST", body: {
    order_id: order.id,
    recipient_id: order.orderer_id,
    title: TEST_MARKER_TITLE,
    body: "",
    status: "expired"
  } });
}

async function sendTestOffer(order, recipient) {
  try {
    await nativeRequest("native_delivery_notifications", {}, { method: "POST", body: {
      order_id: order.id,
      recipient_id: recipient.id,
      title: TEST_OFFER_TITLE,
      body: `${order.store} needs a delivery runner.`,
      status: "pending"
    } });
    return false;
  } catch (error) {
    // The nearby trigger may already have sent the same offer.
    if (error.code === "23505") return true;
    throw error;
  }
}

function createNativeOrdersRouter(requireAdmin) {
  const router = express.Router();
  router.use(requireAdmin);
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  router.get("/", async (_req, res) => {
    try {
      const orders = await nativeRequest("native_orders", { select: "*", order: "created_at.desc", limit: "50" });
      const ids = [...new Set(orders.flatMap((order) => [order.orderer_id, order.runner_id]).filter((id) => UUID.test(id)))];
      const profiles = ids.length
        ? await nativeRequest("native_profiles", { select: "id,name,email", id: `in.(${ids.join(",")})` })
        : [];
      const byID = new Map(profiles.map((profile) => [profile.id, profile]));
      const orderIDs = orders.map((order) => order.id).filter((id) => UUID.test(id));
      const markers = orderIDs.length
        ? await nativeRequest("native_delivery_notifications", {
          select: "order_id", order_id: `in.(${orderIDs.join(",")})`,
          title: `eq.${TEST_MARKER_TITLE}`, status: "eq.expired"
        })
        : [];
      const dashboardTestIDs = new Set(markers.map((marker) => marker.order_id));
      res.json({ orders: orders.map((order) => ({
        ...order,
        dashboardTest: dashboardTestIDs.has(order.id),
        orderer: byID.get(order.orderer_id) || null,
        runner: byID.get(order.runner_id) || null
      })) });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  // Last known location of each app user, saved while they have the Deliver tab open.
  router.get("/locations", async (_req, res) => {
    try {
      const rows = await nativeRequest("native_runner_locations", {
        select: "user_id,latitude,longitude,updated_at", order: "updated_at.desc", limit: "500"
      });
      const ids = [...new Set(rows.map((row) => row.user_id).filter((id) => UUID.test(id)))];
      const profiles = ids.length
        ? await nativeRequest("native_profiles", { select: "id,name,email", id: `in.(${ids.join(",")})` })
        : [];
      const byID = new Map(profiles.map((profile) => [profile.id, profile]));
      res.json({ locations: rows
        .filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude))
        .map((row) => ({
          userID: row.user_id,
          name: byID.get(row.user_id)?.name || null,
          email: byID.get(row.user_id)?.email || null,
          latitude: row.latitude,
          longitude: row.longitude,
          updatedAt: row.updated_at
        })) });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  router.get("/store-overrides", async (_req, res) => {
    try {
      const rows = await nativeRequest("native_store_hours_overrides", {
        select: "store,force_open,updated_at"
      });
      const byStore = new Map(rows.map((row) => [row.store, row]));
      res.json({ stores: Object.keys(STORES).map((store) => ({
        store,
        forceOpen: byStore.get(store)?.force_open === true,
        updatedAt: byStore.get(store)?.updated_at || null
      })) });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  router.put("/store-overrides/:store", async (req, res) => {
    if (req.get("Origin") !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: "This request must come from the admin dashboard." });
    }
    const store = req.params.store;
    if (!Object.hasOwn(STORES, store)) return res.status(400).json({ error: "Choose a listed pickup location." });
    if (typeof req.body?.forceOpen !== "boolean") return res.status(400).json({ error: "Choose whether to force this store open." });
    try {
      const rows = await nativeRequest("native_store_hours_overrides", { on_conflict: "store" }, {
        method: "POST",
        upsert: true,
        body: { store, force_open: req.body.forceOpen, updated_at: new Date().toISOString() }
      });
      res.json({
        store,
        forceOpen: rows[0]?.force_open === true,
        updatedAt: rows[0]?.updated_at || null
      });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  router.post("/", async (req, res) => {
    if (req.get("Origin") !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: "This request must come from the admin dashboard." });
    }
    const { ordererEmail, recipientEmail, store, orderNumber, hall, items, details = "", payout, requestId } = req.body || {};
    if (!validEmail(ordererEmail)) return res.status(400).json({ error: "Enter a valid orderer email." });
    if (!validEmail(recipientEmail)) return res.status(400).json({ error: "Enter a valid test recipient email." });
    if (!Object.hasOwn(STORES, store)) return res.status(400).json({ error: "Choose a listed pickup location." });
    if (typeof orderNumber !== "string" || !orderNumber.trim() || orderNumber.trim().length > 100 ||
        typeof hall !== "string" || !hall.trim() || hall.trim().length > 120 ||
        typeof items !== "string" || !items.trim() || items.trim().length > 500 ||
        typeof details !== "string" || details.trim().length > 500) {
      return res.status(400).json({ error: "Enter an order number, description, and delivery destination within the limits." });
    }
    const tip = dollars(payout);
    if (tip === null) return res.status(400).json({ error: "Enter a test payout from $0.00 to $1,000.00." });
    if (!UUID.test(requestId || "")) return res.status(400).json({ error: "Invalid request ID. Refresh and try again." });
    try {
      const orderer = await accountByEmail(ordererEmail);
      if (!orderer) return res.status(404).json({ error: "No native app account has that orderer email." });
      const recipient = await accountByEmail(recipientEmail);
      if (!recipient) return res.status(404).json({ error: "No native app account has that test recipient email." });
      const [pickupLatitude, pickupLongitude] = STORES[store];
      const created = await nativeRequest("native_orders", {}, { method: "POST", body: {
        id: requestId,
        orderer_id: orderer.id,
        store,
        order_number: orderNumber.trim(),
        hall: hall.trim(),
        dropoff_details: details.trim(),
        items: items.trim(),
        tip,
        pickup_latitude: pickupLatitude,
        pickup_longitude: pickupLongitude,
        status: "open"
      } });
      let warning = null;
      try {
        await markDashboardTestOrder(created[0]);
        try { await sendTestOffer(created[0], recipient); }
        catch (error) { warning = `Order created, but the test offer could not be sent: ${error.message}`; }
      } catch (error) {
        warning = `Order created, but it could not be marked as a dashboard test order: ${error.message}`;
      }
      res.status(201).json({ order: created[0], warning });
    } catch (error) {
      res.status(error.code === "23505" ? 409 : error.status || 502).json({
        error: error.code === "23505" ? "This test request was already submitted. Refresh the list." : error.message
      });
    }
  });

  router.post("/:id/notify", async (req, res) => {
    if (req.get("Origin") !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: "This request must come from the admin dashboard." });
    }
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid order ID." });
    const recipientEmail = typeof req.body?.recipientEmail === "string" ? req.body.recipientEmail.trim() : "";
    if (!validEmail(recipientEmail)) return res.status(400).json({ error: "Enter a valid test recipient email." });
    try {
      const orders = await nativeRequest("native_orders", { select: "id,orderer_id,store,status", id: `eq.${req.params.id}`, limit: "1" });
      const order = orders[0];
      if (!order) return res.status(404).json({ error: "Native order not found." });
      if (order.status !== "open") return res.status(409).json({ error: "Only open requests can receive a test offer." });
      if (!await isDashboardTestOrder(order.id)) {
        return res.status(403).json({ error: "Only orders created on the dashboard can receive test offers." });
      }
      const recipient = await accountByEmail(recipientEmail);
      if (!recipient) return res.status(404).json({ error: "No native app account has that test recipient email." });
      const alreadySent = await sendTestOffer(order, recipient);
      res.json({ alreadySent });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  // Issues the same one-time code the orderer's app shows, so an admin can
  // complete a dashboard test order by scanning it from the runner's phone.
  router.post("/:id/handoff-code", async (req, res) => {
    if (req.get("Origin") !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: "This request must come from the admin dashboard." });
    }
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid order ID." });
    try {
      const rows = await nativeRequest("native_orders", { select: "id,runner_id,status", id: `eq.${req.params.id}`, limit: "1" });
      const order = rows[0];
      if (!order) return res.status(404).json({ error: "Native order not found." });
      if (!await isDashboardTestOrder(order.id)) {
        return res.status(403).json({ error: "Only orders created on the dashboard can show a handoff QR code." });
      }
      if (!UUID.test(order.runner_id || "") || !["claimed", "picked_up", "arrived"].includes(order.status)) {
        return res.status(409).json({ error: "Accept this request on the deliverer's phone first, then show the QR code." });
      }
      // Matches start_native_delivery_handoff: 256-bit token, only its md5 is stored.
      const token = crypto.randomBytes(32).toString("hex");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
      await nativeRequest("native_delivery_handoffs", { on_conflict: "order_id" }, { method: "POST", upsert: true, body: {
        order_id: order.id,
        token_hash: crypto.createHash("md5").update(token).digest("hex"),
        expires_at: expiresAt,
        created_at: now.toISOString(),
        completed_at: null,
        confirmation_method: null
      } });
      res.json({ code: `WILDCATEATS:${order.id.toUpperCase()}:${token}`, expiresAt });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  router.post("/:id/fulfill", async (req, res) => {
    if (req.get("Origin") !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: "This request must come from the admin dashboard." });
    }
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid order ID." });
    try {
      const rows = await nativeRequest("native_orders", { select: "id,orderer_id,runner_id,status", id: `eq.${req.params.id}`, limit: "1" });
      const order = rows[0];
      if (!order) return res.status(404).json({ error: "Native order not found." });
      if (!["open", "claimed", "picked_up", "arrived"].includes(order.status)) {
        return res.status(409).json({ error: "Only active orders can be fulfilled." });
      }
      const runnerEmail = typeof req.body?.runnerEmail === "string" ? req.body.runnerEmail.trim() : "";
      let runnerID = order.runner_id;
      if (order.status === "open") {
        if (!validEmail(runnerEmail)) return res.status(400).json({ error: "Enter a valid runner email to fulfill an open order." });
        const runner = await accountByEmail(runnerEmail);
        if (!runner) return res.status(404).json({ error: "No native app account has that runner email." });
        if (runner.id === order.orderer_id && !await isDashboardTestOrder(order.id)) {
          return res.status(400).json({ error: "The orderer can only fulfill a dashboard test request." });
        }
        runnerID = runner.id;
      } else if (!UUID.test(runnerID || "")) {
        return res.status(409).json({ error: "This order has no assigned runner. Refresh the list and check its status." });
      }
      const now = new Date().toISOString();
      const body = { status: "delivered", delivered_at: now };
      if (order.status === "open") Object.assign(body, { runner_id: runnerID, claimed_at: now, picked_up_at: now, arrived_at: now });
      const params = { id: `eq.${order.id}`, status: `eq.${order.status}` };
      if (order.status === "open") params.runner_id = "is.null";
      else params.runner_id = `eq.${runnerID}`;
      const updated = await nativeRequest("native_orders", params, { method: "PATCH", body });
      if (!updated.length) return res.status(409).json({ error: "This order changed. Refresh the list and try again." });
      // A nearby offer may have been created when this order was posted.
      let warning = null;
      try {
        await nativeRequest("native_delivery_notifications", { order_id: `eq.${order.id}`, status: "eq.pending" }, {
          method: "PATCH", body: { status: "expired", responded_at: now }
        });
      } catch (_) {
        warning = "The order was fulfilled, but pending delivery offers could not be cleared.";
      }
      res.json({ order: updated[0], warning });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createNativeOrdersRouter, dollars, STORES };
