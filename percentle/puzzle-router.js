"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { MAX_DAYS_AHEAD, addDays, daysBetween, easternDate, isCalendarDate, puzzleNumber, secondsUntilEasternMidnight, validatePuzzle, validateTheme } = require("./puzzles");
const { DAILY_WINDOW_DAYS, checkPuzzle } = require("./variety");

const ARCHIVE_DAYS = 30;
// How far back the variety checks look for repeats.
const VARIETY_HISTORY_DAYS = 365;
const MAX_NOTES_LENGTH = 20_000;

// The publish token check, shared by the puzzle and endless-bank routes. Only the daily agent
// holds the token.
function publisherAuth(options = {}) {
  // Pasted secrets often pick up invisible spaces, line breaks, or quotes; ignore those.
  const cleanToken = value => (value || "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  const publishToken = () => cleanToken(options.publishToken ?? process.env.PERCENTLE_PUBLISH_TOKEN);

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

  return { isPublisher, requirePublisher };
}

function createPuzzleRouter(store, options = {}) {
  const router = express.Router();
  const today = options.today || (() => easternDate());
  const { isPublisher, requirePublisher } = publisherAuth(options);
  // The endless bank store, when there is one, so a daily question doesn't repeat a bank's.
  const endless = options.endless;

  // A puzzle for `date` against everything already written: puzzles within two weeks of it, older
  // ones, and the endless banks. The date's own puzzle is left out, since this one replaces it.
  async function varietyProblems(date, questions, special) {
    const nearby = [], others = [];
    for (const day of await store.dates(addDays(date, -VARIETY_HISTORY_DAYS), addDays(date, MAX_DAYS_AHEAD + DAILY_WINDOW_DAYS))) {
      if (day === date) continue;
      const puzzle = await store.getPuzzle(day);
      (Math.abs(daysBetween(day, date)) <= DAILY_WINDOW_DAYS ? nearby : others).push(...puzzle.questions);
    }
    if (endless) {
      const { periodStart, PERIOD_DAYS } = require("./endless");
      const current = periodStart(today());
      for (const startsOn of [addDays(current, -PERIOD_DAYS), current, addDays(current, PERIOD_DAYS)]) others.push(...await endless.getBank(startsOn));
    }
    return checkPuzzle(questions, { nearby, others, special });
  }

  // A special also carries its theme (e.g. "World Series Special"); normal days leave it out.
  const send = (res, date, { questions, theme }) => res.json({ date, number: puzzleNumber(date), ...(theme ? { theme } : {}), questions });

  // A live puzzle can't change, so it can be cached until the next one goes live at midnight
  // Eastern (browsers re-check every 10 minutes; a CDN such as Cloudflare can hold it all day).
  // Past puzzles never change at all. Anything else (not published yet, agent-only routes) is
  // never cached, so it shows up the moment it changes.
  const cacheUntilMidnight = res => {
    const seconds = secondsUntilEasternMidnight();
    res.set("Cache-Control", `public, max-age=${Math.min(seconds, 600)}, s-maxage=${seconds}`);
  };
  const cacheForever = res => res.set("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
  const noStore = res => res.set("Cache-Control", "no-store");

  router.get("/today", async (req, res, next) => {
    try {
      const date = today();
      const puzzle = await store.getPuzzle(date);
      if (!puzzle) {
        noStore(res);
        return res.status(404).json({ error: "Today's puzzle hasn't been published yet.", date, number: puzzleNumber(date) });
      }
      cacheUntilMidnight(res);
      send(res, date, puzzle);
    } catch (error) {
      next(error);
    }
  });

  router.get("/archive", async (req, res, next) => {
    try {
      const date = today();
      const dates = await store.dates(addDays(date, -ARCHIVE_DAYS), addDays(date, -1));
      cacheUntilMidnight(res);
      res.json({ puzzles: dates.map(day => ({ date: day, number: puzzleNumber(day) })) });
    } catch (error) {
      next(error);
    }
  });

  // Recent and scheduled puzzles, so the agent can avoid repeating questions.
  router.get("/history", requirePublisher, async (req, res, next) => {
    noStore(res);
    try {
      const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 90));
      const date = today();
      const dates = await store.dates(addDays(date, -days), addDays(date, MAX_DAYS_AHEAD));
      const puzzles = [];
      for (const day of dates) {
        const { questions, theme } = await store.getPuzzle(day);
        puzzles.push({ date: day, ...(theme ? { theme } : {}), questions });
      }
      res.json({ today: date, puzzles });
    } catch (error) {
      next(error);
    }
  });

  // The agent's notes on the editor's likes and dislikes, read and rewritten on each run.
  router.get("/agent-notes", requirePublisher, async (req, res, next) => {
    noStore(res);
    try {
      res.json(await store.getNotes());
    } catch (error) {
      next(error);
    }
  });

  router.put("/agent-notes", requirePublisher, async (req, res, next) => {
    try {
      const notes = req.body?.notes;
      if (typeof notes !== "string" || notes.length > MAX_NOTES_LENGTH) {
        return res.status(400).json({ error: `notes must be a string of at most ${MAX_NOTES_LENGTH} characters.` });
      }
      await store.putNotes(notes);
      res.json({ notes, updatedAt: new Date().toISOString() });
    } catch (error) {
      next(error);
    }
  });

  // For the agent: checks a draft puzzle's questions for repeats before it researches them. Only
  // each question's text and category are needed. Nothing is saved.
  router.post("/:date/check", requirePublisher, async (req, res, next) => {
    noStore(res);
    try {
      const { date } = req.params;
      if (!isCalendarDate(date)) return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
      const questions = req.body?.questions;
      if (!Array.isArray(questions) || !questions.length || !questions.every(question => typeof question?.text === "string")) {
        return res.status(400).json({ error: "questions must be a list of { text, category }." });
      }
      const problems = await varietyProblems(date, questions, Boolean(req.body?.theme));
      res.json({ ok: !problems.length, problems });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:date", async (req, res, next) => {
    try {
      const { date } = req.params;
      if (!isCalendarDate(date)) return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
      const current = today();
      if (date > current && !isPublisher(req)) return res.status(404).json({ error: "That puzzle isn't out yet." });
      const puzzle = await store.getPuzzle(date);
      if (!puzzle) return res.status(404).json({ error: "No puzzle was published for that date." });
      if (date < current) cacheForever(res);
      else if (date === current) cacheUntilMidnight(res);
      else noStore(res);
      send(res, date, puzzle);
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
      const theme = validateTheme(req.body?.theme);
      const problems = await varietyProblems(date, questions, Boolean(theme));
      if (problems.length) return res.status(400).json({ error: problems.join(" ") });
      await store.put(date, questions, theme);
      res.status(201);
      send(res, date, { questions, theme });
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createPuzzleRouter, publisherAuth };
