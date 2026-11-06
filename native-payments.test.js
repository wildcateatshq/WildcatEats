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
  const cards = [
    { id: "pm_visa", customer: "cus_orderer", card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 } },
    { id: "pm_amex", customer: "cus_orderer", card: { brand: "amex", last4: "0005", exp_month: 9, exp_year: 2029 } },
    { id: "pm_someone", customer: "cus_other", card: { brand: "visa", last4: "1111", exp_month: 1, exp_year: 2031 } }
  ];
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return Promise.resolve(typeof result === "function" ? result(...args) : result); };
  const stripe = {
    calls,
    customers: {
      create: record("customers.create", { id: "cus_orderer" }),
      retrieve: record("customers.retrieve", (id) => ({ id })),
      update: record("customers.update", {}),
      listPaymentMethods: (_customer, { limit }) => Promise.resolve({ data: cards.slice(0, limit) })
    },
    checkout: { sessions: {
      create: record("checkout.create", { url: "https://checkout.stripe.com/c/pay/cs_test_abc" }),
      retrieve: record("checkout.retrieve", (id) => ({
        id, customer: "cus_orderer", status: "complete",
        setup_intent: { status: "succeeded", payment_method: { id: "pm_visa", card: { brand: "visa", last4: "4242" } } }
      }))
    } },
    tokens: { create: record("tokens.create", { id: "tok_applepay" }) },
    paymentMethods: {
      create: (params) => {
        calls.push(["paymentMethods.create", params]);
        const method = { id: "pm_applepay", customer: null, card: { brand: "visa", last4: "9999", exp_month: 2, exp_year: 2031, wallet: { type: "apple_pay" } } };
        cards.push(method);
        return Promise.resolve(method);
      },
      attach: (id, { customer }) => { calls.push(["paymentMethods.attach", id, customer]); cards.find((c) => c.id === id).customer = customer; return Promise.resolve({}); },
      detach: (id) => { calls.push(["paymentMethods.detach", id]); cards.splice(cards.findIndex((c) => c.id === id), 1); return Promise.resolve({}); },
      retrieve: (id) => { const card = cards.find((c) => c.id === id); return card ? Promise.resolve(card) : Promise.reject(new Error("No such payment method")); }
    },
    accounts: {
      create: record("accounts.create", { id: "acct_runner" }),
      retrieve: record("accounts.retrieve", (id) => ({ id, payouts_enabled: true, capabilities: { transfers: "active" } })),
      createLoginLink: record("accounts.createLoginLink", { url: "https://connect.stripe.com/express/login" }),
      update: record("accounts.update", {}),
      listExternalAccounts: record("accounts.listExternalAccounts", { data: [
        { id: "ba_chase", object: "bank_account", bank_name: "CHASE", last4: "6789", default_for_currency: true },
        { id: "card_debit", object: "card", brand: "Visa", last4: "1881", default_for_currency: false }
      ] })
    },
    payouts: { create: (params) => { calls.push(["payouts.create", params]); return Promise.resolve({ id: "po_1", amount: params.amount, arrival_date: 1800000000 }); } },
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

test("orderers save Apple Pay from the app's payment sheet", async () => {
  const tables = { native_profiles: [{ id: ordererID, name: "Ada", email: "ada@example.com" }] };
  const stripe = fakeStripe();
  const { call, close } = await harness(tables, stripe);
  const token = "orderer-token-0123456789";
  const paymentData = Buffer.from('{"version":"EC_v1","data":"abc"}').toString("base64");
  try {
    assert.equal((await call("/api/native/payments/apple-pay", { method: "POST", body: { paymentData, transactionId: "t1" } })).status, 401);
    assert.equal((await call("/api/native/payments/apple-pay", { token, method: "POST", body: { paymentData: "not base64!", transactionId: "t1" } })).status, 400);
    assert.equal((await call("/api/native/payments/apple-pay", { token, method: "POST", body: { paymentData } })).status, 400);

    const saved = await call("/api/native/payments/apple-pay", {
      token, method: "POST", body: { paymentData, network: "Visa", displayName: "Visa 9999", transactionId: "txn_123" }
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.card, { brand: "visa", last4: "9999" });
    const [, tokenParams] = stripe.calls.find(([name]) => name === "tokens.create");
    assert.deepEqual(tokenParams, {
      pk_token: '{"version":"EC_v1","data":"abc"}',
      pk_token_transaction_id: "txn_123",
      pk_token_payment_network: "Visa",
      pk_token_instrument_name: "Visa 9999"
    });
    assert.deepEqual(stripe.calls.find(([name]) => name === "paymentMethods.create")[1], { type: "card", card: { token: "tok_applepay" } });
    assert.deepEqual(stripe.calls.find(([name]) => name === "paymentMethods.attach"), ["paymentMethods.attach", "pm_applepay", "cus_orderer"]);
    assert.equal(tables.native_payment_accounts[0].payment_method_id, "pm_applepay");

    const list = await call("/api/native/payments/cards", { token });
    const applePay = list.json.cards.find((card) => card.id === "pm_applepay");
    assert.equal(applePay.wallet, "apple_pay");
    assert.equal(applePay.isDefault, true);
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

test("orderers see their saved cards, pick the default, and remove one", async () => {
  const tables = { native_payment_accounts: [{ user_id: ordererID, stripe_customer_id: "cus_orderer", payment_method_id: "pm_visa", card_brand: "visa", card_last4: "4242" }] };
  const stripe = fakeStripe();
  // Only this customer's cards come back from Stripe's list.
  stripe.customers.listPaymentMethods = async (_customer, { limit }) => ({ data: [
    { id: "pm_visa", card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 } },
    { id: "pm_amex", card: { brand: "amex", last4: "0005", exp_month: 9, exp_year: 2029 } }
  ].filter((card) => stripe.calls.every(([name, id]) => name !== "paymentMethods.detach" || id !== card.id)).slice(0, limit) });
  const { call, close } = await harness(tables, stripe);
  const token = "orderer-token-0123456789";
  try {
    const listed = await call("/api/native/payments/cards", { token });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.cards.map((c) => [c.id, c.last4, c.isDefault]), [["pm_visa", "4242", true], ["pm_amex", "0005", false]]);
    assert.equal(listed.json.cards[0].expYear, 2030);

    assert.equal((await call("/api/native/payments/cards/pm_someone/default", { token, method: "POST", body: {} })).status, 404);
    assert.equal((await call("/api/native/payments/cards/not-a-card/default", { token, method: "POST", body: {} })).status, 400);

    const switched = await call("/api/native/payments/cards/pm_amex/default", { token, method: "POST", body: {} });
    assert.equal(switched.status, 200);
    assert.equal(tables.native_payment_accounts[0].payment_method_id, "pm_amex");
    assert.equal(tables.native_payment_accounts[0].card_last4, "0005");
    assert.deepEqual(switched.json.cards.find((c) => c.isDefault).id, "pm_amex");

    // Removing the default card falls back to the remaining one.
    const removed = await call("/api/native/payments/cards/pm_amex", { token, method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json.cards.map((c) => [c.id, c.isDefault]), [["pm_visa", true]]);
    assert.equal(tables.native_payment_accounts[0].payment_method_id, "pm_visa");

    await call("/api/native/payments/cards/pm_visa", { token, method: "DELETE" });
    assert.equal(tables.native_payment_accounts[0].payment_method_id, null);
    const [, , cleared] = stripe.calls.filter(([name]) => name === "customers.update").pop();
    assert.equal(cleared.invoice_settings.default_payment_method, "");
  } finally {
    close();
  }
});

test("runners withdraw their available balance to a bank or debit card", async () => {
  const tables = { native_payment_accounts: [{ user_id: runnerID, stripe_account_id: "acct_runner", payouts_ready: true }] };
  const stripe = fakeStripe();
  const { call, close } = await harness(tables, stripe);
  const token = "runner-token-01234567890";
  const requestId = "44444444-4444-4444-8444-444444444444";
  try {
    const listed = await call("/api/native/payments/payouts/destinations", { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.availableCents, 375);
    assert.equal(listed.json.pendingCents, 125);
    assert.deepEqual(listed.json.destinations.map((d) => [d.id, d.type, d.isDefault]), [["ba_chase", "bank", true], ["card_debit", "card", false]]);
    // The account is switched to manual payouts so earnings wait for Withdraw.
    const [, , schedule] = stripe.calls.find(([name]) => name === "accounts.update");
    assert.equal(schedule.settings.payouts.schedule.interval, "manual");

    const withdraw = (body) => call("/api/native/payments/payouts/withdraw", { token, method: "POST", body: { requestId, ...body } });
    assert.equal((await withdraw({ amountCents: 50, destinationId: "card_debit" })).status, 400);
    assert.equal((await withdraw({ amountCents: 1.5, destinationId: "card_debit" })).status, 400);
    assert.equal((await withdraw({ amountCents: 300, destinationId: "ba_someoneelse" })).status, 404);
    const tooMuch = await withdraw({ amountCents: 400, destinationId: "card_debit" });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.json.error, /available balance/);

    const sent = await withdraw({ amountCents: 375, destinationId: "card_debit" });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.amountCents, 375);
    assert.equal(sent.json.destination.last4, "1881");
    const [, payout] = stripe.calls.find(([name]) => name === "payouts.create");
    assert.deepEqual([payout.amount, payout.destination, payout.method], [375, "card_debit", "standard"]);

    const noAccount = await call("/api/native/payments/payouts/destinations", { token: "orderer-token-0123456789" });
    assert.equal(noAccount.status, 409);
    assert.equal(noAccount.json.code, "payouts_required");
  } finally {
    close();
  }
});

