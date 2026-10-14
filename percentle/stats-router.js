"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { easternDate } = require("./puzzles");
const { clientAddress, createRateLimit } = require("./crowd-router");
const { toCsv } = require("./stats");

const EVENTS_PER_MINUTE = 60;

function sameSecret(given, expected) {
  const hash = value => crypto.createHash("sha256").update(String(value)).digest();
  return crypto.timingSafeEqual(hash(given), hash(expected));
}

// /visit and /event are sent by the game page. /daily.csv is the editor's spreadsheet feed (one
// row per day), readable only with PERCENTLE_STATS_KEY, so it can sit in an Excel "From Web" link.
function createStatsRouter(stats, crowd, options = {}) {
  const router = express.Router();
  const currentDate = options.currentDate || (() => easternDate());
  const statsKey = () => (options.statsKey !== undefined ? options.statsKey : process.env.PERCENTLE_STATS_KEY);
  const allow = createRateLimit(options.perMinute ?? EVENTS_PER_MINUTE, options.now);
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  const limited = handler => async (req, res, next) => {
    if (!allow(clientAddress(req))) return res.status(429).json({ error: "Too many requests. Try again in a minute." });
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  };

  router.post("/visit", limited(async (req, res) => {
    const { id, ref, referrer } = req.body || {};
    await stats.recordVisit(currentDate(), id, ref, referrer);
    res.status(204).end();
  }));

  router.post("/event", limited(async (req, res) => {
    const { id, kind } = req.body || {};
    await stats.recordEvent(currentDate(), id, kind);
    res.status(204).end();
  }));

  router.get("/daily.csv", async (req, res, next) => {
    const key = statsKey();
    if (!key) return res.status(404).json({ error: "Stats are not set up on this server." });
    const given = req.query.key || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!given || !sameSecret(given, key)) return res.status(401).json({ error: "Wrong stats key." });
    try {
      const report = await stats.report(currentDate(), await crowd.dailyFinishes());
      res.type("text/csv").set("Content-Disposition", 'inline; filename="chargle-daily-stats.csv"').send(toCsv(report));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createStatsRouter };
