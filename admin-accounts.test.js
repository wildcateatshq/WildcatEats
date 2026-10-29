const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createAdminAccountsRouter, checkCredentials, isAdminEmail, hashPassword, verifyPassword } = require("./admin-accounts");

function withEnv(values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

// A fake admin_accounts table behind Supabase's REST API.
function fakeSupabase(rows) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/rest/v1/admin_accounts");
    const match = (parsed.searchParams.get("email") || "").replace(/^eq\./, "");
    const method = options.method || "GET";
    if (method === "POST") {
      const row = JSON.parse(options.body);
      if (rows.some((r) => r.email === row.email)) return Response.json({ code: "23505", message: "duplicate" }, { status: 409 });
      rows.push({ ...row, created_at: new Date().toISOString() });
      return Response.json([row], { status: 201 });
    }
    if (method === "DELETE") {
      const removed = rows.filter((r) => r.email === match);
      rows.splice(0, rows.length, ...rows.filter((r) => r.email !== match));
      return Response.json(removed);
    }
    return Response.json(match ? rows.filter((r) => r.email === match) : rows);
  };
}

test("stored admin passwords use salted scrypt", () => {
  const stored = hashPassword("correct horse battery");
  assert.notEqual(stored, hashPassword("correct horse battery"));
  assert.equal(verifyPassword("correct horse battery", stored), true);
  assert.equal(verifyPassword("wrong password!!", stored), false);
  assert.equal(verifyPassword("anything", "garbage"), false);
});

test("owner and added admins can sign in; others cannot", async () => {
  const restore = withEnv({
    ADMIN_EMAIL: "Owner@Example.com", ADMIN_PASSWORD: "owner-password-123",
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test_only"
  });
  const originalFetch = global.fetch;
  global.fetch = fakeSupabase([{ email: "added@example.com", name: "Added", password_hash: hashPassword("added-password-123"), created_by: "owner@example.com" }]);
  try {
    assert.equal(await checkCredentials("owner@example.com", "owner-password-123"), "owner@example.com");
    assert.equal(await checkCredentials("owner@example.com", "nope"), null);
    assert.equal(await checkCredentials("added@example.com", "added-password-123"), "added@example.com");
    assert.equal(await checkCredentials("added@example.com", "owner-password-123"), null);
    assert.equal(await checkCredentials("stranger@example.com", "added-password-123"), null);
    assert.equal(await isAdminEmail("added@example.com"), true);
    assert.equal(await isAdminEmail("stranger@example.com"), false);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test("admins can add and remove other admins from the dashboard", async () => {
  const restore = withEnv({
    ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: "owner-password-123",
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test_only"
  });
  const originalFetch = global.fetch;
  const rows = [];
  global.fetch = fakeSupabase(rows);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { adminEmail: "owner@example.com" }; next(); });
  app.use("/admins", createAdminAccountsRouter((_req, _res, next) => next()));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, method, body, origin = base) => originalFetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", Origin: origin }, body: body ? JSON.stringify(body) : undefined
  });
  try {
    assert.equal((await send("/admins", "POST", { name: "Jo", email: "jo@example.com", password: "long-enough-pw" }, "https://evil.example")).status, 403);
    assert.equal((await send("/admins", "POST", { name: "Jo", email: "jo@example.com", password: "short" })).status, 400);
    assert.equal((await send("/admins", "POST", { name: "Jo", email: "not-an-email", password: "long-enough-pw" })).status, 400);
    assert.equal((await send("/admins", "POST", { name: "Jo", email: "owner@example.com", password: "long-enough-pw" })).status, 409);

    const added = await send("/admins", "POST", { name: "Jo", email: "Jo@Example.com", password: "long-enough-pw" });
    assert.equal(added.status, 201);
    assert.equal(rows[0].email, "jo@example.com");
    assert.equal(rows[0].created_by, "owner@example.com");
    assert.equal(verifyPassword("long-enough-pw", rows[0].password_hash), true);
    assert.equal((await send("/admins", "POST", { name: "Jo", email: "jo@example.com", password: "long-enough-pw" })).status, 409);

    const listed = await (await originalFetch(`${base}/admins`)).json();
    assert.deepEqual(listed.admins.map((a) => [a.email, a.owner]), [["owner@example.com", true], ["jo@example.com", false]]);
    assert.equal(JSON.stringify(listed).includes("password"), false);

    assert.equal((await send("/admins/owner%40example.com", "DELETE")).status, 400);
    assert.equal((await send("/admins/jo%40example.com", "DELETE")).status, 200);
    assert.equal(rows.length, 0);
    assert.equal((await send("/admins/jo%40example.com", "DELETE")).status, 404);
  } finally {
    server.close();
    global.fetch = originalFetch;
    restore();
  }
});
