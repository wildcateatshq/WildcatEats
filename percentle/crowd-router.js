"use strict";

const express = require("express");
const { easternDate } = require("./puzzles");

// Each player sends their score once when they finish (and again when they revisit the results),
// so this is generous: many students on one campus network can share an address. It only stops a
// single address from flooding today's crowd line.
const SUBMISSIONS_PER_MINUTE = 60;

// The visitor's address: Cloudflare's header when it's in front, otherwise the last address the
// host's proxy added (the one that actually connected), otherwise the socket.
function clientAddress(req) {
  const forwarded = (req.get("x-forwarded-for") || "").split(",").map(part => part.trim()).filter(Boolean);
  return req.get("cf-connecting-ip") || forwarded.at(-1) || req.socket.remoteAddress || "unknown";
}

function createRateLimit(perMinute, now = () => Date.now()) {
  const windows = new Map();
  let sweptAt = now();
  return function allow(key) {
    const time = now();
    // Forget finished windows now and then so the map can't grow without limit.
    if (time - sweptAt > 60_000) {
      for (const [k, window] of windows) if (time - window.start >= 60_000) windows.delete(k);
      sweptAt = time;
    }
    const window = windows.get(key);
    if (!window || time - window.start >= 60_000) {
      windows.set(key, { start: time, count: 1 });
      return true;
    }
    window.count++;
    return window.count <= perMinute;
  };
}

function createCrowdRouter(store, currentDate = () => easternDate(), options = {}) {
  const router = express.Router();
  const allow = createRateLimit(options.perMinute ?? SUBMISSIONS_PER_MINUTE, options.now);
  // Crowd responses are personal and change constantly, so nothing should cache them.
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req, res, next) => {
    try {
      res.json(await store.getSummary(req.query.date));
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    if (!allow(clientAddress(req))) {
      return res.status(429).json({ error: "Too many scores from this network right now. Try again in a minute." });
    }
    const { date, id, score } = req.body || {};
    if (date !== currentDate()) {
      return res.status(400).json({ error: "Only today's puzzle accepts crowd scores." });
    }
    try {
      res.json(await store.submit(date, id, score));
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createCrowdRouter, createRateLimit };
