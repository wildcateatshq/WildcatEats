"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { MAX_DAYS_AHEAD, addDays, daysBetween, easternDate, isCalendarDate, puzzleNumber, validatePuzzle } = require("./puzzles");

const ARCHIVE_DAYS = 30;

function createPuzzleRouter(store, options = {}) {
  const router = express.Router();
  const today = options.today || (() => easternDate());
  // Pasted secrets often pick up invisible spaces, line breaks, or quotes; ignore those.
  const cleanToken = value => (value || "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  const publishToken = () => cleanToken(options.publishToken ?? process.env.PERCENTLE_PUBLISH_TOKEN);

  // Only the daily agent holds this token; it can publish and read unreleased puzzles.
  function isPublisher(req) {
    const expected = publishToken();
    const match = /^Bearer (.+)$/.exec(req.get("authorization") || "");
    if (!expected || !match) return false;
    const given = Buffer.from(cleanToken(match[1]));
    const wanted = Buffer.from(expected);
    if (given.length === wanted.length && crypto.timingSafeEqual(given, wanted)) return true;
    // Lengths only, never the tokens, so a mismatch can be diagnosed from the server log.
    console.warn(`Percentle publish token rejected: received ${given.length} characters, expected ${wanted.length}.`);
    return false;
  }

  function requirePublisher(req, res, next) {
    if (!publishToken()) return res.status(503).json({ error: "Publishing is disabled: PERCENTLE_PUBLISH_TOKEN is not set." });
    if (!isPublisher(req)) return res.status(401).json({ error: "A valid publish token is required." });
    next();
  }

  const send = (res, date, questions) => res.json({ date, number: puzzleNumber(date), questions });

  router.get("/today", async (req, res, next) => {
    try {
      const date = today();
      const questions = await store.get(date);
      if (!questions) return res.status(404).json({ error: "Today's puzzle hasn't been published yet.", date, number: puzzleNumber(date) });
      send(res, date, questions);
    } catch (error) {
      next(error);
    }
  });

  router.get("/archive", async (req, res, next) => {
    try {
      const date = today();
      const dates = await store.dates(addDays(date, -ARCHIVE_DAYS), addDays(date, -1));
      res.json({ puzzles: dates.map(day => ({ date: day, number: puzzleNumber(day) })) });
    } catch (error) {
      next(error);
    }
  });

  // Recent and scheduled puzzles, so the agent can avoid repeating questions.
  router.get("/history", requirePublisher, async (req, res, next) => {
    try {
      const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 90));
      const date = today();
      const dates = await store.dates(addDays(date, -days), addDays(date, MAX_DAYS_AHEAD));
      const puzzles = [];
      for (const day of dates) puzzles.push({ date: day, questions: await store.get(day) });
      res.json({ today: date, puzzles });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:date", async (req, res, next) => {
    try {
      const { date } = req.params;
      if (!isCalendarDate(date)) return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
      if (date > today() && !isPublisher(req)) return res.status(404).json({ error: "That puzzle isn't out yet." });
      const questions = await store.get(date);
      if (!questions) return res.status(404).json({ error: "No puzzle was published for that date." });
      send(res, date, questions);
    } catch (error) {
      next(error);
    }
  });

  router.put("/:date", requirePublisher, async (req, res, next) => {
    try {
      const { date } = req.params;
      const current = today();
      if (!isCalendarDate(date)) return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
      if (date < current) return res.status(400).json({ error: `Past puzzles can't be changed. Today in Eastern time is ${current}.` });
      if (daysBetween(current, date) > MAX_DAYS_AHEAD) {
        return res.status(400).json({ error: `Puzzles can be published at most ${MAX_DAYS_AHEAD} days ahead.` });
      }
      // Once a day is live, players' guesses and crowd scores depend on its questions.
      if (date === current && await store.get(date)) {
        return res.status(409).json({ error: "Today's puzzle is already live and can't be replaced." });
      }
      const questions = validatePuzzle(req.body?.questions);
      await store.put(date, questions);
      res.status(201);
      send(res, date, questions);
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createPuzzleRouter };
