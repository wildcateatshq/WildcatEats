"use strict";

// Endless mode: players answer questions until their charge runs out, drawing from a bank of up
// to ~500 questions that changes every two weeks. The agent fills each period's bank in nightly
// batches. Players' best runs are compared anonymously within the period.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { LAUNCH_DATE, addDays, daysBetween, easternDate, isCalendarDate, validateQuestions } = require("./puzzles");

const PERIOD_DAYS = 14;
// A bank goes live once it has this many questions; before that, the previous period's bank is used.
const MIN_LIVE_QUESTIONS = 100;
const MAX_BANK_QUESTIONS = 600;
const MAX_BATCH = 50;
const MINIMUM_COMPARISON_PLAYERS = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Periods run in two-week blocks from launch day. Returns the start date of the period holding `date`.
function periodStart(date = easternDate()) {
  return addDays(LAUNCH_DATE, Math.floor(daysBetween(LAUNCH_DATE, date) / PERIOD_DAYS) * PERIOD_DAYS);
}

function validateRun(startsOn, id, best) {
  if (!isCalendarDate(startsOn) || periodStart(startsOn) !== startsOn) throw new RangeError("startsOn must be a period's start date.");
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new RangeError("A valid anonymous run ID is required.");
  if (!Number.isInteger(best) || best < 0 || best > MAX_BANK_QUESTIONS) throw new RangeError(`best must be a whole number from 0 to ${MAX_BANK_QUESTIONS}.`);
}

// Higher is better here (rounds survived), and ties share the midpoint, as on the daily line.
function summarizeRuns({ players, beaten = 0, tied = 0 }, hasOwn) {
  const hasEnoughComparison = hasOwn && players - 1 >= MINIMUM_COMPARISON_PLAYERS;
  return {
    players,
    betterThan: hasEnoughComparison ? Number(((beaten + tied / 2) / players * 100).toFixed(1)) : null,
    minimumComparisonPlayers: MINIMUM_COMPARISON_PLAYERS
  };
}

function createEndlessStore(options = {}) {
  const filePath = options.filePath || process.env.PERCENTLE_ENDLESS_FILE || path.join(__dirname, "..", "data", "percentle-endless.json");
  const pool = options.pool || (options.filePath || !process.env.DATABASE_URL
    ? null
    : new (require("pg").Pool)({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }));
  // File storage: { banks: { startsOn: [questions] }, runs: { startsOn: { id: best } } }.
  let data = { banks: {}, runs: {} };
  let writes = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  // File writes go one at a time so concurrent requests can't lose each other's changes.
  function queued(change) {
    const operation = writes.then(async () => {
      const result = change();
      await persist();
      return result;
    });
    writes = operation.catch(() => {});
    return operation;
  }

  async function init() {
    if (pool) {
      await pool.query(`
        create table if not exists percentle_endless_banks (
          starts_on date primary key,
          questions jsonb not null default '[]'::jsonb,
          updated_at timestamptz not null default now()
        )
      `);
      await pool.query(`
        create table if not exists percentle_endless_runs (
          starts_on date not null,
          anonymous_id uuid not null,
          best integer not null check (best >= 0),
          submitted_at timestamptz not null default now(),
          primary key (starts_on, anonymous_id)
        )
      `);
      return;
    }
    try {
      const loaded = JSON.parse(await fs.readFile(filePath, "utf8"));
      data = { banks: loaded.banks || {}, runs: loaded.runs || {} };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function getBank(startsOn) {
    if (pool) {
      const { rows } = await pool.query("select questions from percentle_endless_banks where starts_on = $1", [startsOn]);
      return rows[0]?.questions || [];
    }
    return data.banks[startsOn] || [];
  }

  // Adds a batch of questions to a period's bank, skipping any already in it (same text).
  // Returns how many were added and the bank's new size.
  async function addQuestions(startsOn, questions) {
    const add = bank => {
      const seen = new Set(bank.map(question => question.text.toLowerCase()));
      const fresh = questions.filter(question => !seen.has(question.text.toLowerCase()));
      if (bank.length + fresh.length > MAX_BANK_QUESTIONS) throw new RangeError(`A bank holds at most ${MAX_BANK_QUESTIONS} questions.`);
      return { bank: [...bank, ...fresh], added: fresh.length };
    };
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("insert into percentle_endless_banks (starts_on) values ($1) on conflict do nothing", [startsOn]);
        const { rows } = await client.query("select questions from percentle_endless_banks where starts_on = $1 for update", [startsOn]);
        const { bank, added } = add(rows[0].questions);
        await client.query("update percentle_endless_banks set questions = $2, updated_at = now() where starts_on = $1", [startsOn, JSON.stringify(bank)]);
        await client.query("commit");
        return { added, count: bank.length };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    return queued(() => {
      const { bank, added } = add(data.banks[startsOn] || []);
      data.banks[startsOn] = bank;
      return { added, count: bank.length };
    });
  }

  // Removes questions (matched by exact text, ignoring case), for the editor's spot-check fixes.
  async function removeQuestions(startsOn, texts) {
    const drop = new Set(texts.map(text => text.toLowerCase()));
    const keep = bank => bank.filter(question => !drop.has(question.text.toLowerCase()));
    if (pool) {
      const bank = await getBank(startsOn);
      const kept = keep(bank);
      await pool.query("update percentle_endless_banks set questions = $2, updated_at = now() where starts_on = $1", [startsOn, JSON.stringify(kept)]);
      return { removed: bank.length - kept.length, count: kept.length };
    }
    return queued(() => {
      const bank = data.banks[startsOn] || [];
      data.banks[startsOn] = keep(bank);
      return { removed: bank.length - data.banks[startsOn].length, count: data.banks[startsOn].length };
    });
  }

  // Saves a player's best run for the period (keeping the higher one) and compares it.
  async function submitRun(startsOn, id, best) {
    validateRun(startsOn, id, best);
    if (pool) {
      await pool.query(
        `insert into percentle_endless_runs (starts_on, anonymous_id, best) values ($1, $2, $3)
         on conflict (starts_on, anonymous_id) do update set best = greatest(percentle_endless_runs.best, excluded.best), submitted_at = now()`,
        [startsOn, id, best]
      );
      const { rows } = await pool.query(
        `with mine as (select best from percentle_endless_runs where starts_on = $1 and anonymous_id = $2)
         select count(*)::int as players,
                coalesce(sum(case when r.best < mine.best then 1 else 0 end), 0)::int as beaten,
                coalesce(sum(case when r.best = mine.best then 1 else 0 end), 0)::int as tied
         from percentle_endless_runs r, mine where r.starts_on = $1`,
        [startsOn, id]
      );
      return summarizeRuns(rows[0], true);
    }
    return queued(() => {
      const runs = (data.runs[startsOn] ??= {});
      runs[id] = Math.max(runs[id] ?? 0, best);
      const all = Object.values(runs);
      return summarizeRuns({
        players: all.length,
        beaten: all.filter(other => other < runs[id]).length,
        tied: all.filter(other => other === runs[id]).length
      }, true);
    });
  }

  return { init, getBank, addQuestions, removeQuestions, submitRun };
}

module.exports = { MAX_BATCH, MIN_LIVE_QUESTIONS, PERIOD_DAYS, createEndlessStore, periodStart, summarizeRuns, validateQuestions, validateRun };
