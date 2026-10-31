"use strict";

const express = require("express");
const { createRateLimit } = require("./crowd-router");
const { MAX_BATCH, MIN_LIVE_QUESTIONS, PERIOD_DAYS, periodStart, validateQuestions } = require("./endless");
const { publisherAuth } = require("./puzzle-router");
const { addDays, easternDate, secondsUntilEasternMidnight } = require("./puzzles");
const { BANK_CATEGORY_CAPS, BANK_MAX_SAME_NAME, BANK_MAX_SAME_SHAPE, checkBankBatch } = require("./variety");

// How far back the variety checks look in the daily puzzles for repeats.
const VARIETY_HISTORY_DAYS = 365;

// Run submissions per address per minute: generous, like the daily crowd line's, since a whole
// campus can share one address.
const RUNS_PER_MINUTE = 60;

// The visitor's address, as for the daily crowd line.
function clientAddress(req) {
  const forwarded = (req.get("x-forwarded-for") || "").split(",").map(part => part.trim()).filter(Boolean);
  return req.get("cf-connecting-ip") || forwarded.at(-1) || req.socket.remoteAddress || "unknown";
}

function createEndlessRouter(store, options = {}) {
  const router = express.Router();
  const today = options.today || (() => easternDate());
  const { requirePublisher } = publisherAuth(options);
  const allowRun = createRateLimit(options.runsPerMinute ?? RUNS_PER_MINUTE, options.now);
  // The daily puzzle store, when there is one, so a bank question doesn't repeat a daily one.
  const puzzles = options.puzzles;

  // Checks questions for a bank against that bank, the other two open periods' banks, and the
  // daily puzzles. Returns the questions that pass and why the rest don't.
  async function checkForBank(startsOn, questions) {
    const current = periodStart(today());
    const others = [];
    for (const period of [addDays(current, -PERIOD_DAYS), current, addDays(current, PERIOD_DAYS)]) {
      if (period !== startsOn) others.push(...await store.getBank(period));
    }
    if (puzzles) {
      for (const day of await puzzles.dates(addDays(today(), -VARIETY_HISTORY_DAYS), addDays(today(), PERIOD_DAYS))) {
        others.push(...(await puzzles.getPuzzle(day)).questions);
      }
    }
    return checkBankBatch(questions, { bank: await store.getBank(startsOn), others });
  }

  // The bank players use: this period's once it has enough questions, otherwise last period's.
  async function liveBank() {
    const current = periodStart(today());
    for (const startsOn of [current, addDays(current, -PERIOD_DAYS)]) {
      const questions = await store.getBank(startsOn);
      if (questions.length >= MIN_LIVE_QUESTIONS) return { startsOn, questions };
    }
    return null;
  }

  // A tiny check the start screen uses to show the Endless button as live or "coming soon",
  // without downloading the whole bank.
  router.get("/availability", async (req, res, next) => {
    try {
      const bank = await liveBank();
      res.set("Cache-Control", "public, max-age=300");
      res.json({ live: Boolean(bank), needed: MIN_LIVE_QUESTIONS });
    } catch (error) {
      next(error);
    }
  });

  router.get("/bank", async (req, res, next) => {
    try {
      const bank = await liveBank();
      if (!bank) {
        res.set("Cache-Control", "no-store");
        return res.status(404).json({ error: "Endless mode is warming up. Check back soon.", needed: MIN_LIVE_QUESTIONS });
      }
      // New questions only join at midnight Eastern for players (the bank grows nightly).
      const seconds = secondsUntilEasternMidnight();
      res.set("Cache-Control", `public, max-age=${Math.min(seconds, 600)}, s-maxage=${seconds}`);
      res.json({ startsOn: bank.startsOn, endsOn: addDays(bank.startsOn, PERIOD_DAYS - 1), questions: bank.questions });
    } catch (error) {
      next(error);
    }
  });

  // For the agent: the previous, current, and next periods' banks, so it can fill the right one,
  // keep the category mix balanced, and avoid repeating questions.
  router.get("/status", requirePublisher, async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      const current = periodStart(today());
      const periods = { previous: addDays(current, -PERIOD_DAYS), current, next: addDays(current, PERIOD_DAYS) };
      const result = {
        today: today(), minLive: MIN_LIVE_QUESTIONS, maxBatch: MAX_BATCH,
        // The variety limits each bank is held to (see variety.js).
        limits: { categoryShares: BANK_CATEGORY_CAPS, maxSameKind: BANK_MAX_SAME_SHAPE, maxSameSubject: BANK_MAX_SAME_NAME }
      };
      for (const [name, startsOn] of Object.entries(periods)) {
        const questions = await store.getBank(startsOn);
        const categories = {};
        for (const question of questions) categories[question.category] = (categories[question.category] || 0) + 1;
        result[name] = { startsOn, count: questions.length, categories, texts: questions.map(question => question.text) };
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // Only this period's and next period's banks can change.
  function writablePeriod(req, res) {
    const current = periodStart(today());
    if (![current, addDays(current, PERIOD_DAYS)].includes(req.params.startsOn)) {
      res.status(400).json({ error: `Only the current (${current}) or next (${addDays(current, PERIOD_DAYS)}) period's bank can change.` });
      return false;
    }
    return true;
  }

  router.post("/banks/:startsOn/questions", requirePublisher, async (req, res, next) => {
    try {
      if (!writablePeriod(req, res)) return;
      const batch = req.body?.questions;
      if (!Array.isArray(batch) || batch.length > MAX_BATCH) return res.status(400).json({ error: `Send 1 to ${MAX_BATCH} questions at a time.` });
      // Questions that would repeat, or crowd one category, kind of question, or subject, are turned
      // away with the reasons; the rest are added.
      const { accepted, rejected } = await checkForBank(req.params.startsOn, validateQuestions(batch));
      if (!accepted.length) return res.status(422).json({ error: "None of these questions were added.", added: 0, rejected });
      const result = await store.addQuestions(req.params.startsOn, accepted);
      res.status(201).json({ ...result, rejected });
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  // For the agent: checks draft questions (text and category) against a bank before it researches
  // them. Nothing is saved.
  router.post("/banks/:startsOn/check", requirePublisher, async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!writablePeriod(req, res)) return;
      const questions = req.body?.questions;
      if (!Array.isArray(questions) || !questions.length || !questions.every(question => typeof question?.text === "string")) {
        return res.status(400).json({ error: "questions must be a list of { text, category }." });
      }
      const { rejected } = await checkForBank(req.params.startsOn, questions);
      const problems = new Map(rejected.map(item => [item.text, item.problems]));
      res.json({ results: questions.map(question => ({ text: question.text, ok: !problems.has(question.text), problems: problems.get(question.text) || [] })) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/banks/:startsOn/remove", requirePublisher, async (req, res, next) => {
    try {
      if (!writablePeriod(req, res)) return;
      const texts = req.body?.texts;
      if (!Array.isArray(texts) || !texts.length || !texts.every(text => typeof text === "string")) {
        return res.status(400).json({ error: "texts must be a list of question texts." });
      }
      res.json(await store.removeQuestions(req.params.startsOn, texts));
    } catch (error) {
      next(error);
    }
  });

  // A player's best run this period, compared anonymously with everyone else's.
  router.post("/runs", async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!allowRun(clientAddress(req))) return res.status(429).json({ error: "Too many runs from this network right now. Try again in a minute." });
    const { startsOn, id, best, mode } = req.body || {};
    const current = periodStart(today());
    if (![current, addDays(current, -PERIOD_DAYS)].includes(startsOn)) return res.status(400).json({ error: "That endless period isn't open." });
    try {
      res.json(await store.submitRun(startsOn, id, best, mode));
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createEndlessRouter };
