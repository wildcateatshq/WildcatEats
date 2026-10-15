const express = require("express");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function centsFromDollars(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(value)) return null;
  const [dollars, fractional = ""] = value.split(".");
  const cents = Number(dollars) * 100 + Number(fractional.padEnd(2, "0"));
  return cents >= 1 && cents <= 100000 ? cents : null;
}

function credentials() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!/^https:\/\/[^/]+$/.test(url) || !key) return null;
  return { url, key };
}

async function nativeRequest(table, params = {}, { method = "GET", body } = {}) {
  const configured = credentials();
  if (!configured) {
    const error = new Error("Native account credits are not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY on the server.");
    error.status = 503;
    throw error;
  }
  const query = new URLSearchParams(params);
  const url = `${configured.url}/rest/v1/${table}?${query}`;
  const headers = { apikey: configured.key, Accept: "application/json" };
  // Legacy service_role JWTs need Authorization; new sb_secret keys use apikey.
  if (!configured.key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${configured.key}`;
  if (body) headers["Content-Type"] = "application/json";
  if (method === "POST") headers.Prefer = "return=representation";
  const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.code === "PGRST205" || payload?.code === "42P01"
        ? "Native account-credit tables are missing. Apply supabase/migrations/004_native_test_credits.sql first."
        : (payload?.message || "Supabase account-credit request failed.")
    );
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

function createNativeCreditsRouter(requireAdmin) {
  const router = express.Router();
  router.use(requireAdmin);
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email.trim() : "";
    if (email && (email.length > 254 || !EMAIL.test(email))) {
      return res.status(400).json({ error: "Enter a complete email address." });
    }
    try {
      const params = { select: "id,name,email", order: "created_at.desc", limit: "20" };
      if (email) params.email = `ilike.${email}`;
      const profiles = await nativeRequest("native_profiles", params);
      const ids = profiles.map((profile) => profile.id).filter((id) => UUID.test(id));
      const balances = ids.length
        ? await nativeRequest("native_test_balances", { select: "user_id,balance_cents", user_id: `in.(${ids.join(",")})` })
        : [];
      const byID = new Map(balances.map((balance) => [balance.user_id, Number(balance.balance_cents)]));
      res.json({ accounts: profiles.map((profile) => ({ ...profile, balanceCents: byID.get(profile.id) || 0 })) });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  router.get("/:id/credits", async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid account ID." });
    try {
      const credits = await nativeRequest("native_test_credits", {
        select: "id,amount_cents,reason,created_by,created_at",
        user_id: `eq.${req.params.id}`,
        order: "created_at.desc",
        limit: "20"
      });
      res.json({ credits });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  router.post("/:id/credits", async (req, res) => {
    // The admin cookie alone is not enough to authorize a cross-site POST.
    const origin = req.get("Origin");
    if (!origin || origin !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: "This request must come from the admin dashboard." });
    }
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid account ID." });
    const amountCents = centsFromDollars(req.body?.amount);
    if (amountCents === null) return res.status(400).json({ error: "Enter an amount from $0.01 to $1,000.00." });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 500) return res.status(400).json({ error: "Enter a reason (3–500 characters)." });
    if (!UUID.test(req.body?.requestId || "")) return res.status(400).json({ error: "Invalid request ID. Refresh the page and try again." });
    try {
      const profiles = await nativeRequest("native_profiles", { select: "id", id: `eq.${req.params.id}`, limit: "1" });
      if (!profiles.length) return res.status(404).json({ error: "Native account not found." });
      await nativeRequest("native_test_credits", {}, {
        method: "POST",
        body: {
          user_id: req.params.id,
          amount_cents: amountCents,
          reason,
          created_by: req.session.adminEmail,
          request_id: req.body.requestId
        }
      });
      const balances = await nativeRequest("native_test_balances", { select: "balance_cents", user_id: `eq.${req.params.id}`, limit: "1" });
      res.status(201).json({ balanceCents: Number(balances[0]?.balance_cents || 0) });
    } catch (error) {
      const message = error.code === "23505" ? "This credit was already submitted. Refresh the balance." : error.message;
      res.status(error.code === "23505" ? 409 : error.status || 502).json({ error: message });
    }
  });

  return router;
}

module.exports = { createNativeCreditsRouter, centsFromDollars };
