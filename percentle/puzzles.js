"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// Puzzle #1 is this Eastern-time date; later numbers count calendar days from it.
const LAUNCH_DATE = "2026-10-06";
const QUESTIONS_PER_PUZZLE = 5;
// Any mix is allowed on a given day; the category only labels the question.
const CATEGORIES = ["U.S. life", "Sports", "Music", "Movies", "World"];
// The agent may publish this many days ahead; players never see a puzzle before its date.
const MAX_DAYS_AHEAD = 7;
const DAY_MS = 86_400_000;

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

// Calendar date in New York (EST/EDT), so puzzles roll over at midnight Eastern.
function easternDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Seconds until the next midnight in New York, when the next puzzle goes live. Midnight is 04:00
// or 05:00 UTC depending on daylight saving, so both are checked rather than assuming a 24-hour day.
function secondsUntilEasternMidnight(now = new Date()) {
  const tomorrow = addDays(easternDate(now), 1);
  const [year, month, day] = tomorrow.split("-").map(Number);
  const midnight = [4, 5].map(hour => Date.UTC(year, month - 1, day, hour))
    .find(time => easternDate(new Date(time)) === tomorrow && easternDate(new Date(time - 1)) !== tomorrow);
  return Math.max(1, Math.floor((midnight - now.getTime()) / 1000));
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function puzzleNumber(date) {
  if (!isCalendarDate(date)) throw new RangeError("Date must be a YYYY-MM-DD calendar date.");
  return daysBetween(LAUNCH_DATE, date) + 1;
}

function text(value, field, min, max, problems) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    problems.push(`${field} must be ${min}–${max} characters.`);
    return "";
  }
  return value.trim();
}

// Returns cleaned questions or throws a RangeError listing every problem, so an agent
// can fix all of them in one retry.
function validatePuzzle(questions) {
  if (!Array.isArray(questions) || questions.length !== QUESTIONS_PER_PUZZLE) {
    throw new RangeError(`A puzzle needs exactly ${QUESTIONS_PER_PUZZLE} questions.`);
  }
  const problems = [];
  const cleaned = questions.map((question, index) => {
    const label = `Question ${index + 1}`;
    if (!question || typeof question !== "object") {
      problems.push(`${label} must be an object.`);
      return null;
    }
    const result = {
      text: text(question.text, `${label} text`, 15, 220, problems),
      // Answers are always stored rounded to one decimal place (42.46 becomes 42.5).
      answer: Number.isFinite(question.answer) ? Math.round(question.answer * 10) / 10 : question.answer,
      category: question.category,
      funFact: text(question.funFact, `${label} funFact`, 10, 180, problems),
      sourceName: text(question.sourceName, `${label} sourceName`, 3, 140, problems),
      sourceUrl: question.sourceUrl
    };
    if (result.text && !result.text.endsWith("?")) problems.push(`${label} text must be a question ending in "?".`);
    if (!Number.isFinite(result.answer) || result.answer <= 0 || result.answer >= 100) {
      problems.push(`${label} answer must be a number strictly between 0 and 100 after rounding to one decimal place.`);
    }
    if (!CATEGORIES.includes(result.category)) problems.push(`${label} category must be one of: ${CATEGORIES.join(", ")}.`);
    try {
      if (new URL(result.sourceUrl).protocol !== "https:") throw new Error();
    } catch {
      problems.push(`${label} sourceUrl must be an https:// URL.`);
    }
    return result;
  });
  const texts = cleaned.filter(Boolean).map(question => question.text.toLowerCase());
  if (new Set(texts).size !== texts.length) problems.push("Questions must not repeat.");
  if (problems.length) throw new RangeError(problems.join(" "));
  return cleaned;
}

function createPuzzleStore(options = {}) {
  const filePath = options.filePath || process.env.PERCENTLE_PUZZLES_FILE || path.join(__dirname, "..", "data", "percentle-puzzles.json");
  const pool = options.pool || (options.filePath || !process.env.DATABASE_URL
    ? null
    : new (require("pg").Pool)({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }));
  const puzzles = new Map();
  let writes = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(Object.fromEntries(puzzles), null, 2), { encoding: "utf8", flag: "wx" });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function init() {
    if (pool) {
      await pool.query(`
        create table if not exists percentle_puzzles (
          puzzle_date date primary key,
          questions jsonb not null,
          published_at timestamptz not null default now()
        )
      `);
      await pool.query(`
        create table if not exists percentle_agent_notes (
          id smallint primary key default 1 check (id = 1),
          notes text not null,
          updated_at timestamptz not null default now()
        )
      `);
      return;
    }
    try {
      const loaded = JSON.parse(await fs.readFile(filePath, "utf8"));
      for (const [date, questions] of Object.entries(loaded)) {
        if (!isCalendarDate(date)) throw new Error(`Invalid Percentle puzzle date ${date}.`);
        puzzles.set(date, validatePuzzle(questions));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function get(date) {
    if (pool) {
      const { rows } = await pool.query("select questions from percentle_puzzles where puzzle_date = $1", [date]);
      return rows[0]?.questions || null;
    }
    return puzzles.get(date) || null;
  }

  // Dates with a puzzle between `from` and `to` inclusive, newest first.
  async function dates(from, to) {
    if (pool) {
      const { rows } = await pool.query(
        "select to_char(puzzle_date, 'YYYY-MM-DD') as date from percentle_puzzles where puzzle_date between $1 and $2 order by puzzle_date desc",
        [from, to]
      );
      return rows.map(row => row.date);
    }
    return [...puzzles.keys()].filter(date => date >= from && date <= to).sort().reverse();
  }

  async function put(date, questions) {
    if (pool) {
      await pool.query(
        `insert into percentle_puzzles (puzzle_date, questions) values ($1, $2)
         on conflict (puzzle_date) do update set questions = excluded.questions, published_at = now()`,
        [date, JSON.stringify(questions)]
      );
      return;
    }
    const operation = writes.then(() => {
      puzzles.set(date, questions);
      return persist();
    });
    writes = operation.catch(() => {});
    return operation;
  }

  // The agent's running notes on what the editor likes and dislikes, carried between nightly runs.
  const notesPath = filePath.replace(/\.json$/, "") + "-agent-notes.md";

  async function getNotes() {
    if (pool) {
      const { rows } = await pool.query("select notes, updated_at from percentle_agent_notes where id = 1");
      return rows[0] ? { notes: rows[0].notes, updatedAt: rows[0].updated_at } : { notes: "", updatedAt: null };
    }
    try {
      const [notes, stats] = await Promise.all([fs.readFile(notesPath, "utf8"), fs.stat(notesPath)]);
      return { notes, updatedAt: stats.mtime };
    } catch (error) {
      if (error.code === "ENOENT") return { notes: "", updatedAt: null };
      throw error;
    }
  }

  async function putNotes(notes) {
    if (pool) {
      await pool.query(
        `insert into percentle_agent_notes (id, notes) values (1, $1)
         on conflict (id) do update set notes = excluded.notes, updated_at = now()`,
        [notes]
      );
      return;
    }
    await fs.mkdir(path.dirname(notesPath), { recursive: true });
    await fs.writeFile(notesPath, notes, "utf8");
  }

  return { init, get, dates, put, getNotes, putNotes };
}

module.exports = {
  CATEGORIES,
  LAUNCH_DATE,
  MAX_DAYS_AHEAD,
  addDays,
  createPuzzleStore,
  secondsUntilEasternMidnight,
  daysBetween,
  easternDate,
  isCalendarDate,
  puzzleNumber,
  validatePuzzle
};
