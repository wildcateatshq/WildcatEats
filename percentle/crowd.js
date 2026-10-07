"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MINIMUM_COMPARISON_PLAYERS = 5;
// Players who ran out of charge submit a rank of at least this (keep in step with
// OUT_OF_CHARGE_RANK in public/percentle/game.mjs);
// everyone who finished submits their points off, which is always lower.
const OUT_OF_CHARGE_RANK = 400;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUtcDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validateSubmission(date, id, score) {
  if (!isUtcDate(date)) throw new RangeError("Date must be a UTC calendar date.");
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new RangeError("A valid anonymous submission ID is required.");
  if (!Number.isFinite(score) || score < 0 || score > 500 || Math.round(score * 10) !== score * 10) {
    throw new RangeError("Score must be between 0 and 500 with at most one decimal place.");
  }
}

function summarize(entries, ownId = null) {
  const scoresById = entries instanceof Map ? entries : new Map(entries);
  const scores = [...scoresById.values()];
  const ownScore = ownId === null ? null : scoresById.get(ownId) ?? null;
  const hasEnoughComparison = ownScore !== null && scoresById.size - 1 >= MINIMUM_COMPARISON_PLAYERS;
  const betterThan = hasEnoughComparison
    ? Number(((scores.filter(score => score > ownScore).length +
      scores.filter(score => score === ownScore).length / 2) / scores.length * 100).toFixed(1))
    : null;
  // The share of the other players who also ran out of charge today.
  const others = [...scoresById].filter(([id]) => id !== ownId).map(([, score]) => score);
  const alsoRanOut = hasEnoughComparison
    ? Number((others.filter(score => score >= OUT_OF_CHARGE_RANK).length / others.length * 100).toFixed(1))
    : null;
  return {
    players: scoresById.size,
    betterThan,
    alsoRanOut,
    minimumComparisonPlayers: MINIMUM_COMPARISON_PLAYERS
  };
}

function createCrowdStore(options = {}) {
  const filePath = typeof options === "string"
    ? options
    : options.filePath || process.env.PERCENTLE_CROWD_FILE || path.join(__dirname, "..", "data", "percentle-crowd.json");
  const Pool = typeof options === "object" && options.pool
    ? null
    : process.env.DATABASE_URL
      ? require("pg").Pool
      : null;
  const pool = typeof options === "object" && options.pool
    ? options.pool
    : Pool
      ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
      : null;
  const dailyScores = new Map();
  let writes = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const data = JSON.stringify(
        Object.fromEntries([...dailyScores].map(([date, entries]) => [date, Object.fromEntries(entries)])),
        null,
        2
      );
      await fs.writeFile(tempPath, data, { encoding: "utf8", flag: "wx" });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(cleanupError => {
        if (cleanupError.code !== "ENOENT") console.error("Could not remove temporary Percentle crowd data.", cleanupError);
      });
      throw error;
    }
  }

  async function init() {
    if (pool) {
      await pool.query(`
        create table if not exists percentle_daily_scores (
          puzzle_date date not null,
          anonymous_id uuid not null,
          score numeric(4, 1) not null check (score >= 0 and score <= 500),
          submitted_at timestamptz not null default now(),
          primary key (puzzle_date, anonymous_id)
        )
      `);
      return;
    }
    try {
      const loaded = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) throw new Error("Crowd data must be a date-keyed object.");
      for (const [date, entries] of Object.entries(loaded)) {
        if (!isUtcDate(date) || !entries || typeof entries !== "object" || Array.isArray(entries)) {
          throw new Error(`Invalid Percentle crowd data for ${date}.`);
        }
        const cleaned = new Map();
        for (const [id, score] of Object.entries(entries)) {
          validateSubmission(date, id, score);
          cleaned.set(id, score);
        }
        dailyScores.set(date, cleaned);
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }

  async function getSummary(date) {
    if (!isUtcDate(date)) throw new RangeError("Date must be a UTC calendar date.");
    if (pool) {
      const { rows } = await pool.query(
        "select anonymous_id, score from percentle_daily_scores where puzzle_date = $1",
        [date]
      );
      return summarize(new Map(rows.map(row => [row.anonymous_id, Number(row.score)])));
    }
    const entries = dailyScores.get(date) || new Map();
    return summarize(entries);
  }

  async function submit(date, id, score) {
    validateSubmission(date, id, score);
    if (pool) {
      await pool.query(
        `insert into percentle_daily_scores (puzzle_date, anonymous_id, score)
         values ($1, $2, $3)
         on conflict (puzzle_date, anonymous_id)
         do update set score = excluded.score, submitted_at = now()`,
        [date, id, score]
      );
      const { rows } = await pool.query(
        "select anonymous_id, score from percentle_daily_scores where puzzle_date = $1",
        [date]
      );
      return summarize(new Map(rows.map(row => [row.anonymous_id, Number(row.score)])), id);
    }
    const operation = writes.then(async () => {
      const entries = dailyScores.get(date) || new Map();
      entries.set(id, score);
      dailyScores.set(date, entries);
      await persist();
      return summarize(entries, id);
    });
    writes = operation.catch(() => {});
    return operation;
  }

  return { init, getSummary, submit };
}

module.exports = { createCrowdStore, isUtcDate, summarize, validateSubmission };
