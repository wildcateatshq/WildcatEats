const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { centsFromDollars, createNativeCreditsRouter } = require("./native-credits");

test("test credit amounts convert to exact cents", () => {
  assert.equal(centsFromDollars("0.01"), 1);
  assert.equal(centsFromDollars("10"), 1000);
  assert.equal(centsFromDollars("10.5"), 1050);
  assert.equal(centsFromDollars("1000.00"), 100000);
});

test("test credit amounts reject invalid or excessive values", () => {
  for (const value of ["0", "0.00", "1000.01", "1.001", "-1", "1e2", "01", 10, "", " 10"]) {
    assert.equal(centsFromDollars(value), null, String(value));
  }
});

test("admin credit route enforces origin and records exact cents", async () => {
  const originalFetch = global.fetch;
  const originalURL = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  const accountID = "11111111-1111-4111-8111-111111111111";
  const requestID = "22222222-2222-4222-8222-222222222222";
  const inserted = [];
  global.fetch = async (url, options) => {
    assert.equal(options.headers.apikey, "sb_secret_test_only");
    assert.equal(options.headers.Authorization, undefined);
    if (url.includes("native_profiles")) return new Response(JSON.stringify([{ id: accountID }]), { status: 200 });
    if (url.includes("native_test_balances")) return new Response(JSON.stringify([{ balance_cents: 1250 }]), { status: 200 });
    if (url.includes("native_test_credits")) {
      inserted.push(JSON.parse(options.body));
      return new Response(JSON.stringify([{ id: requestID }]), { status: 201 });
    }
    throw new Error(`Unexpected Supabase URL: ${url}`);
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { adminEmail: "admin@example.com" }; next(); });
  app.use("/accounts", createNativeCreditsRouter((_req, _res, next) => next()));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ amount: "12.50", reason: "Test order credit", requestId: requestID });
    const forbidden = await originalFetch(`${base}/accounts/${accountID}/credits`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://other.example" }, body
    });
    assert.equal(forbidden.status, 403);
    assert.equal(inserted.length, 0);
    const accepted = await originalFetch(`${base}/accounts/${accountID}/credits`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body
    });
    assert.equal(accepted.status, 201);
    assert.deepEqual(await accepted.json(), { balanceCents: 1250 });
    assert.deepEqual(inserted, [{
      user_id: accountID, amount_cents: 1250, reason: "Test order credit",
      created_by: "admin@example.com", request_id: requestID
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
