"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCrowdStore, isUtcDate, summarize, summaryFromCounts, validateSubmission } = require("./crowd");
const { createRateLimit } = require("./crowd-router");

const date = "2026-10-06";
const ids = Array.from({ length: 8 }, (_, index) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
);

test("accepts real UTC dates and rejects normalized or malformed dates", () => {
  assert.equal(isUtcDate(date), true);
  assert.equal(isUtcDate("2026-02-30"), false);
  assert.equal(isUtcDate("10/06/2026"), false);
});

test("anonymous crowd submissions validate IDs and one-decimal scores", () => {
  assert.doesNotThrow(() => validateSubmission(date, ids[0], 12.3));
  assert.throws(() => validateSubmission(date, "player-name", 12), RangeError);
  assert.throws(() => validateSubmission(date, ids[0], 500.1), RangeError);
  assert.throws(() => validateSubmission(date, ids[0], 12.34), RangeError);
});

test("calculates the percent of other players beaten", () => {
  const entries = new Map(ids.slice(0, 6).map((id, index) => [id, (index + 1) * 10]));
  const summary = summarize(entries, ids[2]);
  assert.equal(summary.players, 6);
  assert.equal(summary.betterThan, 58.3);
});

test("splits tied ranks evenly when calculating percent of players beaten", () => {
  const entries = new Map([
    [ids[0], 10],
    [ids[1], 20],
    [ids[2], 20],
    [ids[3], 20],
    [ids[4], 30],
    [ids[5], 40]
  ]);
  assert.equal(summarize(entries, ids[2]).betterThan, 58.3);
});

test("reports the share of other players who also ran out of charge", () => {
  // Ranks of 400+ mean the player ran out of charge.
  const entries = new Map([
    [ids[0], 12.5],
    [ids[1], 88],
    [ids[2], 420],
    [ids[3], 450],
    [ids[4], 60],
    [ids[5], 410]
  ]);
  assert.equal(summarize(entries, ids[2]).alsoRanOut, 40, "2 of the 5 others ran out");
  assert.equal(summarize(entries, ids[0]).alsoRanOut, 60, "3 of the 5 others ran out");
  assert.equal(summarize(new Map([[ids[0], 420]]), ids[0]).alsoRanOut, null, "withheld with too few players");
});

test("withholds a crowd percentile until five other players have submitted", () => {
  const entries = new Map(ids.slice(0, 5).map((id, index) => [id, (index + 1) * 10]));
  assert.equal(summarize(entries, ids[2]).betterThan, null);
  assert.equal(summarize(new Map([[ids[0], 10]]), ids[0]).betterThan, null);
});

test("persists submissions and updates the same anonymous browser ID", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-crowd-"));
  const file = path.join(folder, "crowd.json");
  try {
    const store = createCrowdStore(file);
    await store.init();
    await Promise.all(ids.slice(0, 6).map((id, index) => store.submit(date, id, index * 10)));
    assert.equal((await store.getSummary(date)).players, 6);
    const updated = await store.submit(date, ids[5], 22.5);
    assert.equal(updated.players, 6);
    assert.equal(updated.betterThan, 41.7);
    const reopened = createCrowdStore(file);
    await reopened.init();
    assert.equal((await reopened.getSummary(date)).players, 6);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test("the counts Postgres returns give the same summary as counting the scores directly", () => {
  const entries = new Map([[ids[0], 12.5], [ids[1], 88], [ids[2], 420], [ids[3], 88], [ids[4], 60], [ids[5], 410]]);
  // What the SQL query returns for ids[1] (88): 2 worse (420 and 410), 2 tied (both 88s), 2 others ran out.
  assert.deepEqual(summaryFromCounts({ players: 6, worse: 2, tied: 2, othersRanOut: 2 }, true), summarize(entries, ids[1]));
  assert.equal(summaryFromCounts({ players: 6 }, false).betterThan, null, "no player to compare");
});

test("the crowd rate limit allows a burst per address, then resets each minute", () => {
  let now = 0;
  const allow = createRateLimit(3, () => now);
  assert.deepEqual([1, 2, 3, 4].map(() => allow("a")), [true, true, true, false]);
  assert.equal(allow("b"), true, "other addresses are counted separately");
  now = 60_000;
  assert.equal(allow("a"), true, "a new minute starts fresh");
});
