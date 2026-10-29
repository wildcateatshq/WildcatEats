const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createNativePaymentsRouter, nativeStripeReturn, runnerCents } = require("./native-payments");

const ordererID = "11111111-1111-4111-8111-111111111111";
const runnerID = "22222222-2222-4222-8222-222222222222";
const orderID = "33333333-3333-4333-8333-333333333333";
const tokens = { "orderer-token-0123456789": ordererID, "runner-token-01234567890": runnerID };

// Just enough of Supabase's REST API (PostgREST filters) and auth for these routes.
function fakeSupabase(tables) {
  const matches = (row, params) => [...params].every(([key, value]) => {
    if (["select", "limit", "order", "on_conflict"].includes(key)) return true;
    const [op, ...rest] = value.split(".");
    const operand = rest.join(".");
    if (op === "eq") return String(row[key]) === operand;
    if (op === "is") return row[key] === null || row[key] === undefined;
    if (op === "gt") return row[key] !== null && String(row[key]) > operand;
    throw new Error(`fake filter ${value}`);
  });
  return async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/auth/v1/user") {
      const id = tokens[(options.headers.Authorization || "").replace("Bearer ", "")];
      return id ? Response.json({ id, email: `${id.slice(0, 4)}@example.com` }) : Response.json({ msg: "bad jwt" }, { status: 401 });
    }
    const table = parsed.pathname.replace("/rest/v1/", "");
    const rows = (tables[table] ||= []);
    const params = parsed.searchParams;
    const method = options.method || "GET";
    if (method === "GET") return Response.json(rows.filter((row) => matches(row, params)));
    if (method === "POST") {
      const body = JSON.parse(options.body);
      const conflict = params.get("on_conflict");
      const existing = conflict && rows.find((row) => row[conflict] === body[conflict]);
      if (existing) { Object.assign(existing, body); return Response.json([existing], { status: 201 }); }
      const row = { id: `row-${rows.length + 1}`, ...body };
      rows.push(row);
      return Response.json([row], { status: 201 });
    }
    const hit = rows.filter((row) => matches(row, params));
    if (method === "PATCH") { hit.forEach((row) => Object.assign(row, JSON.parse(options.body))); return Response.json(hit); }
    if (method === "DELETE") { tables[table] = rows.filter((row) => !hit.includes(row)); return Response.json(hit); }
    throw new Error(`fake method ${method}`);
  };
}

function fakeStripe({ declines = false } = {}) {
  const calls = [];
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return Promise.resolve(typeof result === "function" ? result(...args) : result); };
  const stripe = {
    calls,
    customers: {
      create: record("customers.create", { id: "cus_orderer" }),
      retrieve: record("customers.retrieve", (id) => ({ id })),
      update: record("customers.update", {})
    },
    checkout: { sessions: {
      create: record("checkout.create", { url: "https://checkout.stripe.com/c/pay/cs_test_abc" }),
      retrieve: record("checkout.retrieve", (id) => ({
        id, customer: "cus_orderer", status: "complete",
        setup_intent: { status: "succeeded", payment_method: { id: "pm_visa", card: { brand: "visa", last4: "4242" } } }
      }))
    } },
    paymentMethods: { detach: record("paymentMethods.detach", {}) },
    accounts: {
      create: record("accounts.create", { id: "acct_runner" }),
      retrieve: record("accounts.retrieve", (id) => ({ id, payouts_enabled: true, capabilities: { transfers: "active" } })),
      createLoginLink: record("accounts.createLoginLink", { url: "https://connect.stripe.com/express/login" })
    },
    accountLinks: { create: record("accountLinks.create", { url: "https://connect.stripe.com/setup/e/abc" }) },
    balance: { retrieve: record("balance.retrieve", { available: [{ currency: "usd", amount: 375 }], pending: [{ currency: "usd", amount: 125 }] }) },
    paymentIntents: {
      create: (...args) => {
        calls.push(["paymentIntents.create", ...args]);
        return declines ? Promise.reject(new Error("Your card was declined.")) : Promise.resolve({ id: "pi_1", status: "succeeded" });
      }
    },
    refunds: { create: record("refunds.create", { id: "re_1" }) }
  };
  return stripe;
}

async function harness(tables, stripe) {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY, fetch: global.fetch };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  global.fetch = fakeSupabase(tables);
  const app = express();
  app.use(express.json());
  app.use("/api/native", createNativePaymentsRouter({ stripe }));
  app.get("/native/stripe/return", nativeStripeReturn);
  const server = await new Promise((resolve) => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { token, method = "GET", body } = {}) => {
    const response = await saved.fetch(`${base}${path}`, {
      method, redirect: "manual",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, headers: response.headers, json: await response.json().catch(() => null) };
  };
  const close = () => {
    server.close();
    global.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = saved.key;
  };
  return { call, close };
}

function openOrder(fields = {}) {
  return { id: orderID, orderer_id: ordererID, runner_id: null, status: "open", tip: 5, store: "COVA", claimed_at: null, ...fields };
}

test("runner keeps 75% of the delivery fee", () => {
  assert.equal(runnerCents(500), 375);
  assert.equal(runnerCents(101), 76);
});

test("orderers save a card through Stripe Checkout", async () => {
  const tables = { native_profiles: [{ id: ordererID, name: "Ada", email: "ada@example.com" }] };
  const stripe = fakeStripe();
  const { call, close } = await harness(tables, stripe);
  try {
    assert.equal((await call("/api/native/payments")).status, 401);
    assert.equal((await call("/api/native/payments", { token: "not-a-real-token-123456" })).status, 401);

    const before = await call("/api/native/payments", { token: "orderer-token-0123456789" });
    assert.equal(before.status, 200);
    assert.equal(before.json.enabled, true);
    assert.equal(before.json.card, null);

    const link = await call("/api/native/payments/card", { token: "orderer-token-0123456789", method: "POST", body: {} });
    assert.equal(link.status, 200);
    assert.match(link.json.url, /^https:\/\/checkout\.stripe\.com\//);
    const [, sessionParams] = stripe.calls.find(([name]) => name === "checkout.create");
    assert.equal(sessionParams.mode, "setup");
    assert.equal(sessionParams.customer, "cus_orderer");
    assert.match(sessionParams.success_url, /session_id=\{CHECKOUT_SESSION_ID\}$/);
    assert.equal(tables.native_payment_accounts[0].stripe_customer_id, "cus_orderer");

    assert.equal((await call("/api/native/payments/card/confirm", { token: "orderer-token-0123456789", method: "POST", body: { sessionId: "nope" } })).status, 400);
    const confirmed = await call("/api/native/payments/card/confirm", { token: "orderer-token-0123456789", method: "POST", body: { sessionId: "cs_test_abcdefghijkl" } });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.json.card, { brand: "visa", last4: "4242" });
    assert.equal(tables.native_payment_accounts[0].payment_method_id, "pm_visa");

    // Someone else can't attach this Checkout session to their own account.
    const stolen = await call("/api/native/payments/card/confirm", { token: "runner-token-01234567890", method: "POST", body: { sessionId: "cs_test_abcdefghijkl" } });
    assert.equal(stolen.status, 403);

    const back = await call("/native/stripe/return?kind=card&session_id=cs_test_abcdefghijkl");
    assert.equal(back.status, 302);
    assert.equal(back.headers.get("location"), "novadash://stripe?kind=card&session_id=cs_test_abcdefghijkl");
    const odd = await call("/native/stripe/return?kind=javascript:alert(1)");
    assert.equal(odd.headers.get("location"), "novadash://stripe?kind=card-cancel");
  } finally {
    close();
  }
});

test("runners set up payouts, then get the Stripe dashboard", async () => {
  const tables = {};
  const stripe = fakeStripe();
  stripe.accounts.retrieve = async (id) => ({ id, payouts_enabled: false, capabilities: { transfers: "inactive" } });
  const { call, close } = await harness(tables, stripe);
  try {
    const onboarding = await call("/api/native/payments/payouts", { token: "runner-token-01234567890", method: "POST", body: {} });
    assert.equal(onboarding.status, 200);
    assert.equal(onboarding.json.kind, "onboarding");
    assert.equal(tables.native_payment_accounts[0].stripe_account_id, "acct_runner");

    stripe.accounts.retrieve = async (id) => ({ id, payouts_enabled: true, capabilities: { transfers: "active" } });
    const status = await call("/api/native/payments", { token: "runner-token-01234567890" });
    assert.deepEqual(status.json.payouts, { connected: true, ready: true });
    assert.equal(status.json.balanceCents, 500);
    assert.equal(tables.native_payment_accounts[0].payouts_ready, true);

    const dashboard = await call("/api/native/payments/payouts", { token: "runner-token-01234567890", method: "POST", body: {} });
    assert.equal(dashboard.json.kind, "dashboard");
  } finally {
    close();
  }
});

function readyAccounts() {
  return [
    { user_id: ordererID, stripe_customer_id: "cus_orderer", payment_method_id: "pm_visa", payouts_ready: false },
    { user_id: runnerID, stripe_account_id: "acct_runner", payouts_ready: true }
  ];
}

test("accepting a delivery charges the orderer and pays the runner", async () => {
  const tables = { native_orders: [openOrder()], native_payment_accounts: readyAccounts(), native_delivery_notifications: [] };
  const stripe = fakeStripe();
  const { call, close } = await harness(tables, stripe);
  try {
    const own = await call(`/api/native/orders/${orderID}/claim`, { token: "orderer-token-0123456789", method: "POST", body: {} });
    assert.equal(own.status, 400);

    const accepted = await call(`/api/native/orders/${orderID}/claim`, { token: "runner-token-01234567890", method: "POST", body: {} });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.charged, true);
    assert.equal(tables.native_orders[0].status, "claimed");
    assert.equal(tables.native_orders[0].runner_id, runnerID);
    const [, intent, options] = stripe.calls.find(([name]) => name === "paymentIntents.create");
    assert.equal(intent.amount, 500);
    assert.equal(intent.application_fee_amount, 125);
    assert.equal(intent.transfer_data.destination, "acct_runner");
    assert.equal(intent.customer, "cus_orderer");
    assert.equal(intent.off_session, true);
    assert.match(options.idempotencyKey, new RegExp(`^native-claim-${orderID}-`));
    assert.equal(tables.native_order_payments[0].status, "paid");
    assert.equal(tables.native_order_payments[0].runner_cents, 375);

    const again = await call(`/api/native/orders/${orderID}/claim`, { token: "runner-token-01234567890", method: "POST", body: {} });
    assert.equal(again.status, 409);

    // Releasing within 30 seconds reopens the order and refunds everything.
    const released = await call(`/api/native/orders/${orderID}/release`, { token: "runner-token-01234567890", method: "POST", body: {} });
    assert.equal(released.status, 200);
    assert.equal(released.json.warning, null);
    assert.equal(tables.native_orders[0].status, "open");
    assert.equal(tables.native_orders[0].runner_id, null);
    const [, refund] = stripe.calls.find(([name]) => name === "refunds.create");
    assert.deepEqual(refund, { payment_intent: "pi_1", reverse_transfer: true, refund_application_fee: true });
    assert.equal(tables.native_order_payments[0].status, "refunded");
  } finally {
    close();
  }
});

test("release is refused after the 30-second window", async () => {
  const claimedAt = new Date(Date.now() - 31 * 1000).toISOString();
  const tables = { native_orders: [openOrder({ status: "claimed", runner_id: runnerID, claimed_at: claimedAt })] };
  const { call, close } = await harness(tables, fakeStripe());
  try {
    const late = await call(`/api/native/orders/${orderID}/release`, { token: "runner-token-01234567890", method: "POST", body: {} });
    assert.equal(late.status, 409);
    assert.match(late.json.error, /30-second/);
    assert.equal(tables.native_orders[0].status, "claimed");
  } finally {
    close();
  }
});

test("a declined card reopens the order, and missing setup blocks accepting", async () => {
  const tables = { native_orders: [openOrder()], native_payment_accounts: readyAccounts(), native_delivery_notifications: [] };
  const { call, close } = await harness(tables, fakeStripe({ declines: true }));
  try {
    const declined = await call(`/api/native/orders/${orderID}/claim`, { token: "runner-token-01234567890", method: "POST", body: {} });
    assert.equal(declined.status, 402);
    assert.equal(tables.native_orders[0].status, "open");
    assert.equal(tables.native_orders[0].runner_id, null);
    assert.equal((tables.native_order_payments || []).length, 0);

    tables.native_payment_accounts[1].payouts_ready = false;
    const noPayouts = await call(`/api/native/orders/${orderID}/claim`, { token: "runner-token-01234567890", method: "POST", body: {} });
    // The fake Stripe account reports ready, so a recheck lets this through to the (declining) charge.
    assert.equal(noPayouts.status, 402);

    tables.native_payment_accounts[0].payment_method_id = null;
    const noCard = await call(`/api/native/orders/${orderID}/claim`, { token: "runner-token-01234567890", method: "POST", body: {} });
    assert.equal(noCard.status, 409);
    assert.match(noCard.json.error, /hasn't added a card/);
    assert.equal(tables.native_orders[0].status, "open");
  } finally {
    close();
  }
});

test("without Stripe keys, deliveries are accepted for test credits", async () => {
  const tables = { native_orders: [openOrder()], native_delivery_notifications: [] };
  const { call, close } = await harness(tables, null);
  try {
    const status = await call("/api/native/payments", { token: "orderer-token-0123456789" });
    assert.equal(status.json.enabled, false);
    assert.equal((await call("/api/native/payments/card", { token: "orderer-token-0123456789", method: "POST", body: {} })).status, 503);
    const accepted = await call(`/api/native/orders/${orderID}/claim`, { token: "runner-token-01234567890", method: "POST", body: {} });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.charged, false);
    assert.equal(tables.native_orders[0].status, "claimed");
  } finally {
    close();
  }
});
