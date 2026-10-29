const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createNativeOrdersRouter, dollars } = require("./native-orders");

const ordererID = "11111111-1111-4111-8111-111111111111";
const runnerID = "22222222-2222-4222-8222-222222222222";
const orderID = "33333333-3333-4333-8333-333333333333";

test("test payout accepts exact dollars within bounds", () => {
  assert.equal(dollars("0"), 0);
  assert.equal(dollars("5.50"), 5.5);
  assert.equal(dollars("1000"), 1000);
  for (const value of ["-1", "1000.01", "1.001", "1e2", "01", 5, ""]) assert.equal(dollars(value), null);
});

test("admin lists and updates store-open overrides", async () => {
  const originalFetch = global.fetch;
  const originalURL = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  let override = null;
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname.split("/").pop(), "native_store_hours_overrides");
    if (options.method === "POST") {
      assert.equal(parsed.searchParams.get("on_conflict"), "store");
      assert.match(options.headers.Prefer, /resolution=merge-duplicates/);
      override = JSON.parse(options.body);
      return Response.json([override], { status: 201 });
    }
    return Response.json(override ? [override] : []);
  };
  const app = express();
  app.use(express.json());
  app.use("/native-orders", createNativeOrdersRouter((_req, _res, next) => next()));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await originalFetch(`${base}/native-orders/store-overrides`);
    assert.equal(initial.status, 200);
    assert.equal((await initial.json()).stores.length, 6);
    const forbidden = await originalFetch(`${base}/native-orders/store-overrides/COVA`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://other.example" }, body: JSON.stringify({ forceOpen: true })
    });
    assert.equal(forbidden.status, 403);
    const invalid = await originalFetch(`${base}/native-orders/store-overrides/Unknown`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ forceOpen: true })
    });
    assert.equal(invalid.status, 400);
    const updated = await originalFetch(`${base}/native-orders/store-overrides/COVA`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ forceOpen: true })
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).forceOpen, true);
    assert.equal(override.store, "COVA");
    assert.equal(override.force_open, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalURL;
    if (originalKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = originalKey;
  }
});

test("admin creates and fulfills a native request without runner location", async () => {
  const originalFetch = global.fetch;
  const originalURL = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  let order = null;
  let offersExpired = false;
  const sentOffers = [];
  const markers = [];
  global.fetch = async (url, options) => {
    assert.equal(options.headers.apikey, "sb_secret_test_only");
    assert.equal(options.headers.Authorization, undefined);
    const parsed = new URL(url);
    const table = parsed.pathname.split("/").pop();
    if (table === "native_profiles") {
      const email = parsed.searchParams.get("email")?.slice(3);
      if (email === "orderer@villanova.edu") return Response.json([{ id: ordererID, email }]);
      if (email === "runner@villanova.edu") return Response.json([{ id: runnerID, email }]);
      return Response.json([]);
    }
    if (table === "native_orders") {
      if (options.method === "POST") {
        order = { ...JSON.parse(options.body), created_at: new Date().toISOString() };
        return Response.json([order], { status: 201 });
      }
      if (options.method === "PATCH") {
        assert.equal(parsed.searchParams.get("status"), "eq.open");
        assert.equal(parsed.searchParams.get("runner_id"), "is.null");
        order = { ...order, ...JSON.parse(options.body) };
        return Response.json([order]);
      }
      return Response.json(order ? [order] : []);
    }
    if (table === "native_delivery_notifications") {
      if (options.method === "GET") return Response.json(markers.map((marker) => ({ id: "55555555-5555-4555-8555-555555555555", order_id: marker.order_id })));
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        if (body.title === "Admin dashboard test order") markers.push(body);
        else sentOffers.push(body);
        return Response.json([{ id: "44444444-4444-4444-8444-444444444444" }], { status: 201 });
      }
      assert.equal(options.method, "PATCH");
      assert.equal(JSON.parse(options.body).status, "expired");
      offersExpired = true;
      return Response.json([]);
    }
    throw new Error(`Unexpected Supabase request: ${url}`);
  };
  const app = express();
  app.use(express.json());
  app.use("/native-orders", createNativeOrdersRouter((_req, _res, next) => next()));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const data = { ordererEmail: "orderer@villanova.edu", recipientEmail: "orderer@villanova.edu", store: "COVA", orderNumber: "12345", hall: "Sullivan Hall", items: "Pizza", details: "Outside", payout: "5.00", requestId: orderID };
    const forbidden = await originalFetch(`${base}/native-orders`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://other.example" }, body: JSON.stringify(data) });
    assert.equal(forbidden.status, 403);
    assert.equal(order, null);
    const created = await originalFetch(`${base}/native-orders`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(data) });
    assert.equal(created.status, 201);
    assert.equal(order.orderer_id, ordererID);
    assert.equal(order.pickup_latitude, 40.03538279831171);
    assert.equal(order.status, "open");
    assert.equal(markers.length, 1);
    assert.equal(sentOffers.length, 1);
    assert.equal(sentOffers[0].recipient_id, ordererID);
    const notified = await originalFetch(`${base}/native-orders/${orderID}/notify`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ recipientEmail: "orderer@villanova.edu" }) });
    assert.equal(notified.status, 200);
    assert.equal(sentOffers.length, 2);
    const marker = markers.pop();
    const unmarkedOffer = await originalFetch(`${base}/native-orders/${orderID}/notify`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ recipientEmail: "orderer@villanova.edu" }) });
    assert.equal(unmarkedOffer.status, 403);
    const unmarkedFulfill = await originalFetch(`${base}/native-orders/${orderID}/fulfill`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ runnerEmail: "orderer@villanova.edu" }) });
    assert.equal(unmarkedFulfill.status, 400);
    markers.push(marker);
    const fulfilled = await originalFetch(`${base}/native-orders/${orderID}/fulfill`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ runnerEmail: "orderer@villanova.edu" }) });
    assert.equal(fulfilled.status, 200);
    assert.equal(order.status, "delivered");
    assert.equal(order.runner_id, ordererID);
    assert.ok(order.delivered_at);
    assert.equal(offersExpired, true);
    const again = await originalFetch(`${base}/native-orders/${orderID}/fulfill`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ runnerEmail: "orderer@villanova.edu" }) });
    assert.equal(again.status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalURL;
    if (originalKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = originalKey;
  }
});

test("admin issues a one-time handoff QR code only for accepted dashboard test orders", async () => {
  const crypto = require("node:crypto");
  const originalFetch = global.fetch;
  const originalURL = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  let order = { id: orderID, orderer_id: ordererID, runner_id: null, status: "open" };
  let marked = true;
  let handoff = null;
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split("/").pop();
    if (table === "native_orders") return Response.json([order]);
    if (table === "native_delivery_notifications") return Response.json(marked ? [{ id: "55555555-5555-4555-8555-555555555555" }] : []);
    if (table === "native_delivery_handoffs") {
      assert.equal(options.method, "POST");
      assert.equal(parsed.searchParams.get("on_conflict"), "order_id");
      assert.match(options.headers.Prefer, /resolution=merge-duplicates/);
      handoff = JSON.parse(options.body);
      return Response.json([handoff], { status: 201 });
    }
    throw new Error(`Unexpected Supabase request: ${url}`);
  };
  const app = express();
  app.use(express.json());
  app.use("/native-orders", createNativeOrdersRouter((_req, _res, next) => next()));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (origin = base) => originalFetch(`${base}/native-orders/${orderID}/handoff-code`, { method: "POST", headers: { Origin: origin } });
  try {
    assert.equal((await request("https://other.example")).status, 403);
    assert.equal((await request()).status, 409);
    order = { ...order, runner_id: runnerID, status: "claimed" };
    marked = false;
    assert.equal((await request()).status, 403);
    assert.equal(handoff, null);
    marked = true;
    const issued = await request();
    assert.equal(issued.status, 200);
    const { code, expiresAt } = await issued.json();
    const [prefix, id, token] = code.split(":");
    assert.equal(prefix, "WILDCATEATS");
    assert.equal(id, orderID.toUpperCase());
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(handoff.order_id, orderID);
    assert.equal(handoff.token_hash, crypto.createHash("md5").update(token).digest("hex"));
    assert.equal(handoff.completed_at, null);
    assert.equal(handoff.expires_at, expiresAt);
    assert.ok(Date.parse(expiresAt) > Date.now());
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalURL;
    if (originalKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = originalKey;
  }
});

test("admin lists user locations with their account names", async () => {
  const originalFetch = global.fetch;
  const originalURL = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  global.fetch = async (url) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split("/").pop();
    if (table === "native_runner_locations") {
      assert.equal(parsed.searchParams.get("order"), "updated_at.desc");
      return Response.json([
        { user_id: runnerID, latitude: 40.0367, longitude: -75.3433, updated_at: "2026-10-28T12:00:00Z" },
        { user_id: ordererID, latitude: null, longitude: -75.3, updated_at: "2026-10-28T11:00:00Z" }
      ]);
    }
    if (table === "native_profiles") {
      assert.equal(parsed.searchParams.get("id"), `in.(${runnerID},${ordererID})`);
      return Response.json([{ id: runnerID, name: "Runner", email: "runner@villanova.edu" }]);
    }
    throw new Error(`Unexpected Supabase request: ${url}`);
  };
  const app = express();
  app.use("/native-orders", createNativeOrdersRouter((_req, _res, next) => next()));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  try {
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}/native-orders/locations`);
    assert.equal(response.status, 200);
    const { locations } = await response.json();
    assert.deepEqual(locations, [{
      userID: runnerID, name: "Runner", email: "runner@villanova.edu",
      latitude: 40.0367, longitude: -75.3433, updatedAt: "2026-10-28T12:00:00Z"
    }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalURL;
    if (originalKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = originalKey;
  }
});
