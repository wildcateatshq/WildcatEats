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

// Hard-mode players have their own crowd line, so they're only compared with each other.
const MODES = ["normal", "hard"];

function validateMode(mode = "normal") {
  if (!MODES.includes(mode)) throw new RangeError('mode must be "normal" or "hard".');
  return mode;
}

function validateSubmission(date, id, score) {
  if (!isUtcDate(date)) throw new RangeError("Date must be a UTC calendar date.");
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new RangeError("A valid anonymous submission ID is required.");
  if (!Number.isFinite(score) || score < 0 || score > 500 || Math.round(score * 10) !== score * 10) {
    throw new RangeError("Score must be between 0 and 500 with at most one decimal place.");
  }
}

// Builds the public summary from counts, so Postgres can do the counting itself however many
// players there are. players: everyone today; worse: scores above the player's (lower ranks
// better); tied: scores equal to theirs, themselves included; othersRanOut: other players at
// OUT_OF_CHARGE_RANK or above. hasOwn is false when there's no player to compare.
function summaryFromCounts({ players, worse = 0, tied = 0, othersRanOut = 0 }, hasOwn) {
  const hasEnoughComparison = hasOwn && players - 1 >= MINIMUM_COMPARISON_PLAYERS;
  return {
    players,
    betterThan: hasEnoughComparison ? Number(((worse + tied / 2) / players * 100).toFixed(1)) : null,
    // The share of the other players who also ran out of charge today.
    alsoRanOut: hasEnoughComparison ? Number((othersRanOut / (players - 1) * 100).toFixed(1)) : null,
    minimumComparisonPlayers: MINIMUM_COMPARISON_PLAYERS
  };
}

function summarize(entries, ownId = null) {
  const scoresById = entries instanceof Map ? entries : new Map(entries);
  const ownScore = ownId === null ? null : scoresById.get(ownId) ?? null;
  const counts = { players: scoresById.size, worse: 0, tied: 0, othersRanOut: 0 };
  for (const [id, score] of scoresById) {
    if (ownScore !== null && score > ownScore) counts.worse++;
    if (ownScore !== null && score === ownScore) counts.tied++;
    if (id !== ownId && score >= OUT_OF_CHARGE_RANK) counts.othersRanOut++;
  }
  return summaryFromCounts(counts, ownScore !== null);
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
  // dailyScores is keyed by date for normal mode and "hard:<date>" for hard mode.
  const keyFor = (date, mode) => (mode === "hard" ? `hard:${date}` : date);
  let writes = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const saved = {};
      for (const [key, entries] of dailyScores) {
        if (key.startsWith("hard:")) (saved.hard ??= {})[key.slice(5)] = Object.fromEntries(entries);
        else saved[key] = Object.fromEntries(entries);
      }
      const data = JSON.stringify(saved, null, 2);
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
      await pool.query("alter table percentle_daily_scores add column if not exists mode text not null default 'normal'");
      await pool.query("create index if not exists percentle_daily_scores_date_mode_score on percentle_daily_scores (puzzle_date, mode, score)");
      return;
    }
    try {
      const loaded = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) throw new Error("Crowd data must be a date-keyed object.");
      const days = [
        ...Object.entries(loaded).filter(([date]) => date !== "hard").map(([date, entries]) => [date, entries, "normal"]),
        ...Object.entries(loaded.hard || {}).map(([date, entries]) => [date, entries, "hard"])
      ];
      for (const [date, entries, mode] of days) {
        if (!isUtcDate(date) || !entries || typeof entries !== "object" || Array.isArray(entries)) {
          throw new Error(`Invalid Percentle crowd data for ${date}.`);
        }
        const cleaned = new Map();
        for (const [id, score] of Object.entries(entries)) {
          validateSubmission(date, id, score);
          cleaned.set(id, score);
        }
        dailyScores.set(keyFor(date, mode), cleaned);
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }

  async function getSummary(date, mode = "normal") {
    if (!isUtcDate(date)) throw new RangeError("Date must be a UTC calendar date.");
    validateMode(mode);
    if (pool) {
      const { rows } = await pool.query("select count(*)::int as players from percentle_daily_scores where puzzle_date = $1 and mode = $2", [date, mode]);
      return summaryFromCounts(rows[0], false);
    }
    const entries = dailyScores.get(keyFor(date, mode)) || new Map();
    return summarize(entries);
  }

  async function submit(date, id, score, mode = "normal") {
    validateSubmission(date, id, score);
    validateMode(mode);
    if (pool) {
      await pool.query(
        `insert into percentle_daily_scores (puzzle_date, anonymous_id, score, mode)
         values ($1, $2, $3, $4)
         on conflict (puzzle_date, anonymous_id)
         do update set score = excluded.score, mode = excluded.mode, submitted_at = now()`,
        [date, id, score, mode]
      );
      const { rows } = await pool.query(
        `select count(*)::int as players,
                coalesce(sum(case when score > $2 then 1 else 0 end), 0)::int as worse,
                coalesce(sum(case when score = $2 then 1 else 0 end), 0)::int as tied,
                coalesce(sum(case when score >= $4 and anonymous_id <> $3 then 1 else 0 end), 0)::int as "othersRanOut"
         from percentle_daily_scores where puzzle_date = $1 and mode = $5`,
        [date, score, id, OUT_OF_CHARGE_RANK, mode]
      );
      return summaryFromCounts(rows[0], true);
    }
    const operation = writes.then(async () => {
      const entries = dailyScores.get(keyFor(date, mode)) || new Map();
      entries.set(id, score);
      dailyScores.set(keyFor(date, mode), entries);
      await persist();
      return summarize(entries, id);
    });
    writes = operation.catch(() => {});
    return operation;
  }

  return { init, getSummary, submit };
}

module.exports = { createCrowdStore, isUtcDate, summarize, summaryFromCounts, validateSubmission };
