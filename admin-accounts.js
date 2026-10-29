const crypto = require("node:crypto");
const express = require("express");

const EMAIL = /^[^\s@%_,()]+@[^\s@%_,()]+\.[^\s@%_,()]+$/;
const MIN_PASSWORD = 12;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === check.length && crypto.timingSafeEqual(expected, check);
}

function ownerEmail() {
  return process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD ? process.env.ADMIN_EMAIL.trim().toLowerCase() : "";
}

function supabaseConfigured() {
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  return /^https:\/\/[^/]+$/.test(base) && Boolean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function adminRequest(params = {}, { method = "GET", body } = {}) {
  if (!supabaseConfigured()) {
    const error = new Error("Adding admins needs SUPABASE_URL and SUPABASE_SECRET_KEY on the server.");
    error.status = 503;
    throw error;
  }
  const base = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Accept: "application/json" };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  if (body) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers.Prefer = "return=representation";
  const response = await fetch(`${base}/rest/v1/admin_accounts?${new URLSearchParams(params)}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.code === "PGRST205" || payload?.code === "42P01"
        ? "The admin table is missing. Apply supabase/migrations/010_admin_accounts.sql first."
        : (payload?.message || "Supabase admin request failed.")
    );
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

// Short cache so every dashboard request doesn't hit Supabase, while a
// removed admin still loses access within half a minute.
const cache = new Map(); // email -> { admin, at }
const CACHE_MS = 30 * 1000;

async function findAdmin(email) {
  if (!email || !supabaseConfigured()) return null;
  const hit = cache.get(email);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.admin;
  const rows = await adminRequest({ select: "email,name,password_hash,created_by,created_at", email: `eq.${email}`, limit: "1" });
  const admin = rows[0] || null;
  cache.set(email, { admin, at: Date.now() });
  return admin;
}

// True when the email belongs to the owner or a stored admin. Errors count as
// "not an admin" so an outage never grants access.
async function isAdminEmail(email) {
  const key = String(email || "").toLowerCase();
  if (!key) return false;
  if (key === ownerEmail()) return true;
  try { return Boolean(await findAdmin(key)); } catch (_) { return false; }
}

function adminsConfigured() {
  return Boolean(ownerEmail()) || supabaseConfigured();
}

// Returns the signed-in email, or null for a wrong email or password.
async function checkCredentials(email, password) {
  const owner = ownerEmail();
  if (owner && email === owner) {
    const expected = crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD).digest();
    const supplied = crypto.createHash("sha256").update(password).digest();
    return crypto.timingSafeEqual(expected, supplied) ? owner : null;
  }
  let admin = null;
  try {
    admin = await findAdmin(email);
  } catch (error) {
    // Before migration 010 is applied there are simply no added admins yet.
    if (error.code !== "PGRST205" && error.code !== "42P01") throw error;
  }
  if (!admin) {
    hashPassword(password); // keep timing similar for unknown emails
    return null;
  }
  return verifyPassword(password, admin.password_hash) ? admin.email : null;
}

function createAdminAccountsRouter(requireAdmin) {
  const router = express.Router();
  router.use(requireAdmin);
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET" && req.get("Origin") !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: "This request must come from the admin dashboard." });
    }
    next();
  });

  router.get("/", async (req, res) => {
    const owner = ownerEmail();
    const list = owner ? [{ email: owner, name: "Owner", owner: true, createdBy: null, createdAt: null }] : [];
    try {
      const rows = supabaseConfigured()
        ? await adminRequest({ select: "email,name,created_by,created_at", order: "created_at.asc" })
        : [];
      for (const row of rows) {
        if (row.email !== owner) list.push({ email: row.email, name: row.name, owner: false, createdBy: row.created_by, createdAt: row.created_at });
      }
      res.json({ admins: list, you: req.session.adminEmail, canAdd: supabaseConfigured() });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, admins: list, you: req.session.adminEmail });
    }
  });

  router.post("/", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (email.length > 254 || !EMAIL.test(email)) return res.status(400).json({ error: "Enter a complete email address." });
    if (!name || name.length > 100) return res.status(400).json({ error: "Enter a name (up to 100 characters)." });
    if (password.length < MIN_PASSWORD || password.length > 200) {
      return res.status(400).json({ error: `Use a password of at least ${MIN_PASSWORD} characters.` });
    }
    if (email === ownerEmail()) return res.status(409).json({ error: "That email is already the owner admin." });
    try {
      await adminRequest({}, {
        method: "POST",
        body: { email, name, password_hash: hashPassword(password), created_by: req.session.adminEmail }
      });
      cache.delete(email);
      res.status(201).json({ admin: { email, name, owner: false, createdBy: req.session.adminEmail } });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "That email is already an admin." });
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  router.delete("/:email", async (req, res) => {
    const email = String(req.params.email || "").trim().toLowerCase();
    if (email === ownerEmail()) return res.status(400).json({ error: "The owner admin is set on the server and can't be removed here." });
    if (email === req.session.adminEmail) return res.status(400).json({ error: "You can't remove your own admin access." });
    try {
      const removed = await adminRequest({ email: `eq.${email}` }, { method: "DELETE" });
      cache.delete(email);
      if (!removed.length) return res.status(404).json({ error: "Admin not found." });
      res.json({ ok: true });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createAdminAccountsRouter, checkCredentials, isAdminEmail, adminsConfigured, ownerEmail, hashPassword, verifyPassword };
