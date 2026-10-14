"use strict";

// Daily player stats for the editor's spreadsheet: who opened the game each day (under a lasting
// anonymous ID, never linked to their scores), where they came from, whether they shared, and how
// many endless runs they played. Finishes come from the crowd scores (percentle/crowd.js).
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES = ["direct", "search", "instagram", "tiktok", "reddit", "other"];
const SEARCH_HOSTS = ["google", "bing", "duckduckgo", "yahoo", "ecosia", "brave", "search.app"];
const SOCIAL_HOSTS = { instagram: ["instagram"], tiktok: ["tiktok"], reddit: ["reddit"] };
const EVENTS = { share: "shared", endless: "endless_runs" };

// Where a visit came from: a "?ref=" tag wins (chargle.io/?ref=flyer), then the linking site's
// host. Links opened from texts and most apps send neither, so they count as direct.
function sourceFor(ref, referrer) {
  const tag = typeof ref === "string" ? ref.trim().toLowerCase() : "";
  if (/^[a-z0-9_-]{1,30}$/.test(tag)) {
    return { source: SOURCES.includes(tag) ? tag : bucketForHost(tag) || "other", detail: tag };
  }
  const host = typeof referrer === "string" ? referrer.trim().toLowerCase().replace(/^(?:www|m|l|lm|out)\./, "") : "";
  if (!/^[a-z0-9.-]{1,80}$/.test(host)) return { source: "direct", detail: null };
  return { source: bucketForHost(host) || "other", detail: host };
}

function bucketForHost(host) {
  if (SEARCH_HOSTS.some(name => host === name || host.startsWith(`${name}.`) || host.includes(`.${name}.`))) return "search";
  for (const [source, names] of Object.entries(SOCIAL_HOSTS)) {
    if (names.some(name => host === name || host.startsWith(`${name}.`) || host.includes(`.${name}.`))) return source;
  }
  return null;
}

function addDays(date, days) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const COLUMNS = [
  "Date", "Day", "Opened the game", "New players", "Returning players", "Total players so far",
  "Finished the puzzle", "Finish rate (%)", "Hard mode finishes", "Ran out of charge", "Average charge left (%)",
  "Endless runs", "Players who shared",
  "From texts and apps (direct)", "From search", "From Instagram", "From TikTok", "From Reddit", "From other places", "Other places"
];

// One row per day from the first day with any data through `today`, oldest first; days with no
// players still get a row. Visit columns are blank before visit tracking began.
//   visits:   [{ date, source, detail, players, shared, endless }] (grouped by day, source, detail)
//   firsts:   [{ date, players }]  players whose first visit was that day
//   finishes: [{ date, finished, hard, out, chargeSum }] chargeSum covers finishers who didn't run out
function buildReport({ visits = [], firsts = [], finishes = [] }, today) {
  const dates = [...visits, ...firsts, ...finishes].map(row => row.date).filter(date => date <= today).sort();
  const firstDay = dates[0] || today;
  const trackedFrom = visits.map(row => row.date).sort()[0] || null;
  const newByDay = new Map(firsts.map(row => [row.date, row.players]));
  const finishByDay = new Map(finishes.map(row => [row.date, row]));
  const rows = [];
  let total = 0;
  for (let date = firstDay; date <= today; date = addDays(date, 1)) {
    const tracked = trackedFrom !== null && date >= trackedFrom;
    const dayVisits = visits.filter(row => row.date === date);
    const opened = dayVisits.reduce((sum, row) => sum + row.players, 0);
    const added = newByDay.get(date) || 0;
    total += added;
    const finish = finishByDay.get(date) || { finished: 0, hard: 0, out: 0, chargeSum: 0 };
    const survived = finish.finished - finish.out;
    const bySource = Object.fromEntries(SOURCES.map(source => [source, 0]));
    const others = new Map();
    for (const row of dayVisits) {
      bySource[row.source] = (bySource[row.source] || 0) + row.players;
      if (row.source === "other" && row.detail) others.set(row.detail, (others.get(row.detail) || 0) + row.players);
    }
    const blank = value => (tracked ? value : "");
    rows.push([
      date, WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()],
      blank(opened), blank(added), blank(opened - added), blank(total),
      finish.finished,
      tracked && opened > 0 ? Math.round(Math.min(finish.finished / opened, 1) * 100) : "",
      finish.hard, finish.out,
      survived > 0 ? Math.round((finish.chargeSum / survived) * 10) / 10 : "",
      blank(dayVisits.reduce((sum, row) => sum + row.endless, 0)),
      blank(dayVisits.reduce((sum, row) => sum + row.shared, 0)),
      ...SOURCES.map(source => blank(bySource[source])),
      [...others].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ")
    ]);
  }
  return { columns: COLUMNS, rows };
}

function toCsv({ columns, rows }) {
  const cell = value => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns, ...rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

function createStatsStore(options = {}) {
  const filePath = options.filePath || process.env.PERCENTLE_STATS_FILE || path.join(__dirname, "..", "data", "percentle-stats.json");
  const pool = options.pool !== undefined
    ? options.pool
    : process.env.DATABASE_URL
      ? new (require("pg").Pool)({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
      : null;
  // File mode: "date|id" -> { date, id, source, detail, shared, endless }
  const visits = new Map();
  let writes = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify([...visits.values()]), { encoding: "utf8", flag: "wx" });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function init() {
    if (pool) {
      await pool.query(`
        create table if not exists percentle_visits (
          visit_date date not null,
          player_id uuid not null,
          source text not null,
          detail text,
          shared integer not null default 0,
          endless_runs integer not null default 0,
          primary key (visit_date, player_id)
        )
      `);
      await pool.query("create index if not exists percentle_visits_player on percentle_visits (player_id, visit_date)");
      return;
    }
    try {
      for (const row of JSON.parse(await fs.readFile(filePath, "utf8"))) visits.set(`${row.date}|${row.id}`, row);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  function check(date, id) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError("Date must be a calendar date.");
    if (typeof id !== "string" || !UUID.test(id)) throw new RangeError("Player ID must be a random UUID.");
  }

  function fileWrite(change) {
    const operation = writes.then(async () => {
      change();
      await persist();
    });
    writes = operation.catch(() => {});
    return operation;
  }

  // The day's first visit sets its source; later visits that day don't change it.
  async function recordVisit(date, id, ref, referrer) {
    check(date, id);
    const { source, detail } = sourceFor(ref, referrer);
    if (pool) {
      await pool.query(
        `insert into percentle_visits (visit_date, player_id, source, detail) values ($1, $2, $3, $4)
         on conflict (visit_date, player_id) do nothing`,
        [date, id, source, detail]
      );
      return;
    }
    const key = `${date}|${id}`;
    if (visits.has(key)) return;
    await fileWrite(() => visits.set(key, { date, id, source, detail, shared: 0, endless: 0 }));
  }

  // "share" marks the player as having shared that day; "endless" counts one more endless run.
  async function recordEvent(date, id, kind) {
    check(date, id);
    if (!EVENTS[kind]) throw new RangeError("Unknown event.");
    if (pool) {
      const column = EVENTS[kind];
      const value = kind === "share" ? "1" : `percentle_visits.endless_runs + 1`;
      await pool.query(
        `insert into percentle_visits (visit_date, player_id, source, ${column}) values ($1, $2, 'direct', 1)
         on conflict (visit_date, player_id) do update set ${column} = ${value}`,
        [date, id]
      );
      return;
    }
    const key = `${date}|${id}`;
    await fileWrite(() => {
      const row = visits.get(key) || { date, id, source: "direct", detail: null, shared: 0, endless: 0 };
      if (kind === "share") row.shared = 1;
      else row.endless++;
      visits.set(key, row);
    });
  }

  // finishes come from the crowd store; see buildReport for the shapes.
  async function report(today, finishes) {
    if (pool) {
      const [grouped, firsts] = await Promise.all([
        pool.query(`select to_char(visit_date, 'YYYY-MM-DD') as date, source, detail, count(*)::int as players,
                           coalesce(sum(shared), 0)::int as shared, coalesce(sum(endless_runs), 0)::int as endless
                    from percentle_visits group by visit_date, source, detail`),
        pool.query(`select to_char(first, 'YYYY-MM-DD') as date, count(*)::int as players
                    from (select min(visit_date) as first from percentle_visits group by player_id) as starts group by first`)
      ]);
      return buildReport({ visits: grouped.rows, firsts: firsts.rows, finishes }, today);
    }
    const grouped = new Map();
    const firstSeen = new Map();
    for (const row of visits.values()) {
      const key = `${row.date}|${row.source}|${row.detail}`;
      const group = grouped.get(key) || { date: row.date, source: row.source, detail: row.detail, players: 0, shared: 0, endless: 0 };
      group.players++;
      group.shared += row.shared;
      group.endless += row.endless;
      grouped.set(key, group);
      if (!firstSeen.has(row.id) || row.date < firstSeen.get(row.id)) firstSeen.set(row.id, row.date);
    }
    const firsts = new Map();
    for (const date of firstSeen.values()) firsts.set(date, (firsts.get(date) || 0) + 1);
    return buildReport({
      visits: [...grouped.values()],
      firsts: [...firsts].map(([date, players]) => ({ date, players })),
      finishes
    }, today);
  }

  return { init, recordVisit, recordEvent, report };
}

module.exports = { buildReport, createStatsStore, sourceFor, toCsv, COLUMNS };
