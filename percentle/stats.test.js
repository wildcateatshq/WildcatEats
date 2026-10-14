"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildReport, createStatsStore, sourceFor, toCsv, COLUMNS } = require("./stats");
const { createStatsRouter } = require("./stats-router");
const { createCrowdStore } = require("./crowd");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const column = name => COLUMNS.indexOf(name);

test("a visit's source comes from its ref tag, then the linking site, else direct", () => {
  assert.deepEqual(sourceFor("TikTok", "www.google.com"), { source: "tiktok", detail: "tiktok" });
  assert.deepEqual(sourceFor("flyer", null), { source: "other", detail: "flyer" });
  assert.deepEqual(sourceFor(null, "www.google.com"), { source: "search", detail: "google.com" });
  assert.deepEqual(sourceFor(null, "l.instagram.com"), { source: "instagram", detail: "instagram.com" });
  assert.deepEqual(sourceFor(null, "old.reddit.com"), { source: "reddit", detail: "old.reddit.com" });
  assert.deepEqual(sourceFor(null, "news.ycombinator.com"), { source: "other", detail: "news.ycombinator.com" });
  assert.deepEqual(sourceFor(null, null), { source: "direct", detail: null });
  assert.deepEqual(sourceFor("<script>", "not a host!"), { source: "direct", detail: null });
});

test("the report has a row for every day in order, blanks visit columns before tracking began", () => {
  const { columns, rows } = buildReport({
    visits: [
      { date: "2026-10-09", source: "direct", detail: null, players: 3, shared: 1, endless: 2 },
      { date: "2026-10-09", source: "other", detail: "flyer", players: 2, shared: 0, endless: 0 },
      { date: "2026-10-10", source: "search", detail: "google.com", players: 1, shared: 0, endless: 0 }
    ],
    firsts: [{ date: "2026-10-09", players: 5 }],
    finishes: [
      { date: "2026-10-07", finished: 8, hard: 1, out: 2, chargeSum: 300 },
      { date: "2026-10-09", finished: 4, hard: 0, out: 0, chargeSum: 250 }
    ]
  }, "2026-10-11");
  assert.equal(columns[0], "Date");
  assert.deepEqual(rows.map(row => row[0]), ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
  const [oct7, oct8, oct9, oct10, oct11] = rows;
  assert.equal(oct7[column("Day")], "Wed");
  assert.equal(oct7[column("Finished the puzzle")], 8);
  assert.equal(oct7[column("Average charge left (%)")], 50);
  assert.equal(oct7[column("Opened the game")], "");
  assert.equal(oct8[column("Finished the puzzle")], 0);
  assert.equal(oct9[column("Opened the game")], 5);
  assert.equal(oct9[column("New players")], 5);
  assert.equal(oct9[column("Finish rate (%)")], 80);
  assert.equal(oct9[column("Endless runs")], 2);
  assert.equal(oct9[column("Players who shared")], 1);
  assert.equal(oct9[column("From other places")], 2);
  assert.equal(oct9[column("Other places")], "flyer 2");
  assert.equal(oct10[column("Returning players")], 1);
  assert.equal(oct10[column("From search")], 1);
  assert.equal(oct10[column("Total players so far")], 5);
  assert.equal(oct11[column("Opened the game")], 0);
  assert.match(toCsv({ columns, rows }).split("\r\n")[0], /^Date,Day,Opened the game,/);
});

test("visits, shares and endless runs are stored, and the spreadsheet feed needs the key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chargle-stats-"));
  let today = "2026-10-13";
  const stats = createStatsStore({ filePath: path.join(dir, "stats.json"), pool: null });
  const crowd = createCrowdStore({ filePath: path.join(dir, "crowd.json") });
  await Promise.all([stats.init(), crowd.init()]);
  await crowd.submit("2026-10-13", A, 30, "normal");
  await crowd.submit("2026-10-13", B, 410, "hard");
  const app = express();
  app.use(express.json());
  app.use("/stats", createStatsRouter(stats, crowd, { currentDate: () => today, statsKey: "secret-key" }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/stats`;
  const post = (route, body) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("visit", { id: A, ref: "flyer" })).status, 204);
    assert.equal((await post("visit", { id: A, referrer: "www.google.com" })).status, 204);
    assert.equal((await post("visit", { id: B, referrer: "www.instagram.com" })).status, 204);
    assert.equal((await post("event", { id: A, kind: "share" })).status, 204);
    assert.equal((await post("event", { id: A, kind: "endless" })).status, 204);
    assert.equal((await post("event", { id: A, kind: "endless" })).status, 204);
    assert.equal((await post("visit", { id: "not-a-uuid" })).status, 400);
    assert.equal((await post("event", { id: A, kind: "hack" })).status, 400);
    today = "2026-10-14";
    await post("visit", { id: A });
    await post("visit", { id: C });

    assert.equal((await fetch(`${base}/daily.csv`)).status, 401);
    assert.equal((await fetch(`${base}/daily.csv?key=wrong`)).status, 401);
    const response = await fetch(`${base}/daily.csv?key=secret-key`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/csv/);
    const [header, oct13, oct14] = (await response.text()).trim().split("\r\n").map(line => line.split(","));
    const at = (row, name) => row[header.indexOf(name)];
    assert.equal(at(oct13, "Date"), "2026-10-13");
    assert.equal(at(oct13, "Opened the game"), "2");
    assert.equal(at(oct13, "Finished the puzzle"), "2");
    assert.equal(at(oct13, "Hard mode finishes"), "1");
    assert.equal(at(oct13, "Ran out of charge"), "1");
    assert.equal(at(oct13, "Average charge left (%)"), "70");
    assert.equal(at(oct13, "Players who shared"), "1");
    assert.equal(at(oct13, "Endless runs"), "2");
    assert.equal(at(oct13, "From Instagram"), "1");
    assert.equal(at(oct13, "From other places"), "1");
    assert.equal(at(oct13, "Other places"), "flyer 1");
    assert.equal(at(oct14, "New players"), "1");
    assert.equal(at(oct14, "Returning players"), "1");
    assert.equal(at(oct14, "Total players so far"), "3");

    // A restart reloads what was stored.
    const reloaded = createStatsStore({ filePath: path.join(dir, "stats.json"), pool: null });
    await reloaded.init();
    const { rows } = await reloaded.report("2026-10-14", []);
    assert.equal(rows.at(-1)[column("Total players so far")], 3);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("without a stats key the feed is switched off", async () => {
  const app = express();
  app.use("/stats", createStatsRouter({}, {}, { statsKey: "" }));
  const server = app.listen(0);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/stats/daily.csv?key=x`)).status, 404);
  } finally {
    server.close();
  }
});
