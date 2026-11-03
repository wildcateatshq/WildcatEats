"use strict";

const express = require("express");
const { createRateLimit } = require("./crowd-router");
const { AccountTaken, RESET_MINUTES, hashPassword, hashToken, newReset, newSession, publicAccount, validatePassword, validateSignup, validateState, verifyPassword } = require("./accounts");
const { createMailer } = require("./mailer");

// Sign-ups and log-ins per address per minute: plenty for a person (or a campus sharing one
// address), too few to guess passwords.
const ATTEMPTS_PER_MINUTE = 20;
const COOKIE = "chargle_session";
// Compared against when an email has no account, so a wrong email takes as long as a wrong password.
const NO_ACCOUNT_HASH = hashPassword("no account has this password");

function clientAddress(req) {
  const forwarded = (req.get("x-forwarded-for") || "").split(",").map(part => part.trim()).filter(Boolean);
  return req.get("cf-connecting-ip") || forwarded.at(-1) || req.socket.remoteAddress || "unknown";
}

function sessionToken(req) {
  for (const part of (req.get("cookie") || "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

// The session cookie: hidden from page scripts, sent only to this site, and only over https when
// the site is on https (Render's proxy says so in x-forwarded-proto).
function setSessionCookie(req, res, token, maxAgeSeconds) {
  const secure = req.secure || req.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  res.set("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

// Reset links always point at the real site (never at whatever host a request claims to be for,
// which someone could fake to send people a link to their own site).
const SITE_URL = process.env.CHARGLE_URL || "https://chargle.io";

function createAccountsRouter(store, options = {}) {
  const router = express.Router();
  const allow = createRateLimit(options.attemptsPerMinute ?? ATTEMPTS_PER_MINUTE, options.now);
  const mailer = options.mailer || createMailer();
  const siteUrl = options.siteUrl || SITE_URL;
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  async function startSession(req, res, account) {
    const session = newSession();
    await store.createSession(account.id, session);
    setSessionCookie(req, res, session.token, Math.floor((session.expiresAt - Date.now()) / 1000));
  }

  // The signed-in account, or a 401.
  const signedIn = handler => async (req, res, next) => {
    try {
      const token = sessionToken(req);
      const account = token ? await store.accountForSession(hashToken(token)) : null;
      if (!account) return res.status(401).json({ error: "You're not logged in." });
      await handler(req, res, account);
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  };

  router.post("/signup", async (req, res, next) => {
    if (!allow(clientAddress(req))) return res.status(429).json({ error: "Too many tries. Wait a minute and try again." });
    try {
      const { email, username, password } = validateSignup(req.body);
      const account = await store.createAccount({ email, username, passwordHash: await hashPassword(password) });
      await startSession(req, res, account);
      res.status(201).json({ account: publicAccount(account) });
    } catch (error) {
      if (error instanceof AccountTaken) {
        return res.status(409).json({ error: error.message === "username" ? "That username is taken. Try another." : "That email already has an account. Log in instead." });
      }
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  router.post("/login", async (req, res, next) => {
    if (!allow(clientAddress(req))) return res.status(429).json({ error: "Too many tries. Wait a minute and try again." });
    try {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const account = email ? await store.findByEmail(email) : null;
      const matches = await verifyPassword(password, account ? account.passwordHash : await NO_ACCOUNT_HASH);
      if (!account || !matches) return res.status(401).json({ error: "That email and password don't match." });
      await startSession(req, res, account);
      res.json({ account: publicAccount(account) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      const token = sessionToken(req);
      if (token) await store.deleteSession(hashToken(token));
      setSessionCookie(req, res, "", 0);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // Who's logged in on this browser: the account, or null (not an error, so a visit without an
  // account doesn't log one in the browser's console).
  router.get("/me", async (req, res, next) => {
    try {
      const token = sessionToken(req);
      const account = token ? await store.accountForSession(hashToken(token)) : null;
      res.json({ account: account ? publicAccount(account) : null });
    } catch (error) {
      next(error);
    }
  });

  // Forgot password: emails a one-time reset link if the email has an account. The answer is the
  // same either way, so the form can't be used to find out who has an account.
  router.post("/forgot", async (req, res, next) => {
    if (!allow(clientAddress(req))) return res.status(429).json({ error: "Too many tries. Wait a minute and try again." });
    try {
      // Without email set up nobody would get the link (on a local test server it's in the log).
      const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.get("host") || "");
      if (!mailer.configured && !local) return res.status(503).json({ error: "Password reset emails aren't set up yet. Try again later." });
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const account = email ? await store.findByEmail(email) : null;
      if (account) {
        const reset = newReset();
        if (await store.createReset(account.id, reset)) {
          const link = `${siteUrl}/?password-token=${encodeURIComponent(reset.token)}`;
          await mailer.sendPasswordReset(account.email, account.username, link, RESET_MINUTES);
        }
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // A reset link's new password: sets it, logs the account out everywhere else, and logs it in here.
  router.post("/reset", async (req, res, next) => {
    if (!allow(clientAddress(req))) return res.status(429).json({ error: "Too many tries. Wait a minute and try again." });
    try {
      const password = validatePassword(req.body?.password);
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      const account = token ? await store.resetPassword(hashToken(token), await hashPassword(password)) : null;
      if (!account) return res.status(400).json({ error: "That reset link has expired or was already used. Ask for a new one." });
      await startSession(req, res, account);
      res.json({ account: publicAccount(account) });
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  // Deletes the logged-in account and its saved stats, after the password is confirmed.
  router.post("/delete", signedIn(async (req, res, account) => {
    if (!allow(clientAddress(req))) return res.status(429).json({ error: "Too many tries. Wait a minute and try again." });
    if (!await verifyPassword(req.body?.password, await store.passwordHashFor(account.id))) {
      return res.status(401).json({ error: "That password isn't right." });
    }
    await store.deleteAccount(account.id);
    setSessionCookie(req, res, "", 0);
    res.status(204).end();
  }));

  // A signed-in browser's save: merged into the account's, and the combined save sent back.
  router.put("/state", signedIn(async (req, res, account) => {
    const state = await store.mergeState(account.id, validateState(req.body?.state));
    res.json({ account: publicAccount(account), state });
  }));

  return router;
}

module.exports = { createAccountsRouter };
