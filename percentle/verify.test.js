"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buyItem, forBrowser, verifyState } = require("./verify");

const TODAY = "2026-11-09";
const day = answers => answers.map((answer, i) => ({ text: `Daily question ${i} for testing?`, answer }));
const puzzles = { get: async date => (date <= TODAY ? day([20, 40, 60, 80, 50]) : null) };
const bankQuestions = Array.from({ length: 40 }, (_, i) => ({ text: `Endless question number ${i}?`, answer: 50 }));
const endless = { getBank: async startsOn => (startsOn === "2026-11-03" ? bankQuestions : []) };
const deps = { puzzles, endless, today: TODAY };

let questionKey;
test.before(async () => {
  ({ questionKey } = await import("../public/percentle/game.mjs"));
});

const fresh = () => ({ verified: { daily: {}, endless: {}, owned: {}, endlessStats: { best: {}, hardBest: {}, allTime: 0, hardAllTime: 0, runs: 0 } } });

test("daily games are scored from their guesses, and games a browser makes up don't count", async () => {
  const merged = {
    progress: { [TODAY]: { guesses: [30, 40, 60, 80, 60] }, "2026-11-08": { guesses: [20, 40] } },
    games: [{ date: TODAY, score: 0, charge: 100 }, { date: "2026-11-01", score: 0, charge: 100 }]
  };
  const result = await verifyState(fresh(), merged, deps);
  assert.deepEqual(result.games, [{ date: TODAY, score: 20, charge: 90 }], "only the finished game, with its real charge");
  assert.equal("verified" in forBrowser(result), false, "the verified record stays on the server");

  const again = await verifyState(result, { progress: { [TODAY]: { guesses: [20, 40, 60, 80, 50] } } }, deps);
  assert.equal(again.games[0].charge, 90, "a day is scored once; replaying it changes nothing");

  const tomorrow = await verifyState(fresh(), { progress: { "2026-11-10": { guesses: [20, 40, 60, 80, 50] } } }, deps);
  assert.deepEqual(tomorrow.games, [], "no game for a day that hasn't come");
  const impossible = await verifyState(fresh(), { progress: { [TODAY]: { guesses: [99, 99, 99, 99, 99] } } }, deps);
  assert.deepEqual(impossible.games, [], "no guesses after the battery ran out");
});

test("a save from before verification keeps everything it had", async () => {
  const saved = {
    games: [{ date: "2026-10-20", score: 30, charge: 70 }],
    wallet: { endless: { a: { date: "2026-10-20", coins: 45 } }, owned: { "color-ice": { date: "2026-10-21", price: 160 } } },
    endless: { best: { "2026-10-20": 9 }, allTime: 9, runs: 4 }
  };
  const result = await verifyState(saved, { ...saved, games: [...saved.games, { date: "2026-10-21", score: 0, charge: 100 }] }, deps);
  assert.deepEqual(result.games, [{ date: "2026-10-20", score: 30, charge: 70 }]);
  assert.equal(result.wallet.endless.a.coins, 45);
  assert.deepEqual(Object.keys(result.wallet.owned), ["color-ice"]);
  assert.equal(result.endless.allTime, 9);
});

test("endless runs are checked against their bank before they pay", async () => {
  const keys = bankQuestions.slice(0, 4).map(question => questionKey(question.text));
  const run = { date: TODAY, startsOn: "2026-11-03", hard: false, questions: keys, guesses: [50, 0, 0, 0] };
  const result = await verifyState(fresh(), { wallet: { pending: { r1: run } } }, deps);
  assert.deepEqual(result.wallet.endless.r1, { date: TODAY, coins: 10, base: 10 }, "3 rounds survived pays 10");
  assert.equal(result.endless.best["2026-11-03"], 3);
  assert.equal(result.endless.runs, 1);
  assert.deepEqual(result.wallet.pending, {});

  const unfinished = { ...run, guesses: [50, 50, 50, 50] };
  const madeUp = { ...run, questions: ["nope", ...keys.slice(1)] };
  const wrongBank = { ...run, startsOn: "2026-10-06" };
  const rejected = await verifyState(fresh(), { wallet: { pending: { a: unfinished, b: madeUp, c: wrongBank } } }, deps);
  assert.deepEqual(rejected.wallet.endless, {}, "a run that didn't end, asks questions not in the bank, or names the wrong bank pays nothing");
});

test("items are bought with checked coins only", async () => {
  const poor = await verifyState(fresh(), { progress: { [TODAY]: { guesses: [30, 40, 60, 80, 60] } }, wallet: { owned: { "visitor-ufo": { price: 0 } } } }, deps);
  assert.deepEqual(poor.wallet.owned, {}, "items a browser claims to own don't count");
  await assert.rejects(buyItem(poor, "lightning-blue", { today: TODAY }), /enough coins/);

  const rich = fresh();
  rich.verified.daily = Object.fromEntries(["2026-11-01", "2026-11-02", "2026-11-03"].map(date => [date, { score: 0, charge: 100 }]));
  const bought = await buyItem(rich, "lightning-blue", { today: TODAY, now: 5 });
  assert.equal(bought.wallet.owned["lightning-blue"].price > 0, true);
  assert.deepEqual(bought.wallet.equipped.lightning, { id: "lightning-blue", at: 5 });
  await assert.rejects(buyItem(bought, "lightning-blue", { today: TODAY }), /already have/);
  await assert.rejects(buyItem(bought, "color-gold", { today: TODAY }), /isn't for sale/);

  const owner = await verifyState(fresh(), {}, { ...deps, owner: true });
  assert.equal(owner.wallet.owned["visitor-ufo"].price, 0, "the game's owner has everything, free");
});

test("only today's and yesterday's games and runs pay; older ones count in stats for nothing", async () => {
  const guesses = [20, 40, 60, 80, 50];
  const result = await verifyState(fresh(), { progress: { [TODAY]: { guesses }, "2026-11-08": { guesses }, "2026-11-01": { guesses } } }, deps);
  assert.deepEqual(result.games.map(game => [game.date, Boolean(game.unpaid)]), [["2026-11-01", true], ["2026-11-08", false], [TODAY, false]]);
  await assert.rejects(buyItem(result, "visitor-balloon", { today: TODAY }), /enough coins/, "200 coins from two paying days isn't 250");

  const keys = bankQuestions.slice(0, 4).map(question => questionKey(question.text));
  const old = { date: "2026-11-05", startsOn: "2026-11-03", hard: false, questions: keys, guesses: [50, 0, 0, 0] };
  const runs = await verifyState(fresh(), { wallet: { pending: { old } } }, deps);
  assert.deepEqual(runs.wallet.endless.old, { date: "2026-11-05", coins: 0, base: 0 });
  assert.equal(runs.endless.best["2026-11-03"], 3, "an old run still counts toward bests");
});

test("finished endless runs survive the merge of two saves, so the server can check them", () => {
  const { mergeStates } = require("./accounts");
  const merged = mergeStates({ wallet: { pending: {} } }, { wallet: { pending: { r1: { date: TODAY } } } });
  assert.deepEqual(Object.keys(merged.wallet.pending), ["r1"]);
});
