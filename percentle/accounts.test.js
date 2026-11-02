"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createAccountStore, hashPassword, mergeStates, verifyPassword } = require("./accounts");
const { createAccountsRouter } = require("./accounts-router");
const { buildReport } = require("./stats");

test("passwords are stored as salted hashes and checked against them", async () => {
  const stored = await hashPassword("correct horse");
  assert.match(stored, /^scrypt\$/);
  assert.equal(stored.includes("correct horse"), false);
  assert.notEqual(stored, await hashPassword("correct horse"), "a new salt each time");
  assert.equal(await verifyPassword("correct horse", stored), true);
  assert.equal(await verifyPassword("wrong horse", stored), false);
});

test("two devices' saves merge without losing anything", () => {
  const phone = {
    games: [{ date: "2026-10-30", score: 20, charge: 80 }, { date: "2026-10-31", score: 40, charge: 60 }],
    progress: { "2026-10-31": { guesses: [1, 2, 3, 4, 5] }, "2026-11-01": { guesses: [10] } },
    achievements: { firstCharge: "2026-10-30" },
    endless: { best: { "2026-10-20": 7 }, allTime: 7, runs: 3, hardBest: {}, hardAllTime: 0 }
  };
  const laptop = {
    games: [{ date: "2026-10-31", score: 10, charge: 90 }, { date: "2026-11-01", score: 30, charge: 70 }],
    progress: { "2026-11-01": { guesses: [10, 20, 30, 40, 50] } },
    achievements: { firstCharge: "2026-11-01", hardMode: "2026-11-01" },
    endless: { best: { "2026-10-20": 4, "2026-11-03": 2 }, allTime: 4, runs: 5, hardBest: { "2026-10-20": 3 }, hardAllTime: 3 }
  };
  const merged = mergeStates(phone, laptop);
  assert.deepEqual(merged.games.map(game => game.date), ["2026-10-30", "2026-10-31", "2026-11-01"]);
  assert.equal(merged.games[1].charge, 60, "a day played on both keeps the one already saved");
  assert.equal(merged.progress["2026-11-01"].guesses.length, 5, "progress keeps whichever got further");
  assert.equal(merged.achievements.firstCharge, "2026-10-30", "achievements keep the first time earned");
  assert.equal(merged.achievements.hardMode, "2026-11-01");
  assert.deepEqual(merged.endless.best, { "2026-10-20": 7, "2026-11-03": 2 });
  assert.equal(merged.endless.allTime, 7);
  assert.equal(merged.endless.runs, 5);
  assert.equal(merged.endless.hardAllTime, 3);
  assert.deepEqual(mergeStates(null, laptop).games, laptop.games, "a new account takes the device's save");
});

test("players sign up, log in on another device, sync their save, and log out", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-accounts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "accounts.json");
  const store = createAccountStore({ filePath });
  await store.init();
  const app = express();
  app.use(express.json());
  app.use("/a", createAccountsRouter(store));
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://localhost:${server.address().port}/a`;
  const send = (method, pathname, body, cookie) => fetch(url + pathname, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body)
  });
  const cookieOf = response => response.headers.get("set-cookie").split(";")[0];

  assert.equal((await (await send("GET", "/me")).json()).account, null, "nobody is logged in");
  const bad = await send("POST", "/signup", { email: "nope", username: "x", password: "short" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /valid email[\s\S]*3 to 20[\s\S]*8 characters/);

  const signup = await send("POST", "/signup", { email: " Jamie@Example.com ", username: "jamie_w", password: "battery-power" });
  assert.equal(signup.status, 201);
  assert.deepEqual((await signup.json()).account, { username: "jamie_w", email: "jamie@example.com" });
  assert.match(signup.headers.get("set-cookie"), /chargle_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
  const phone = cookieOf(signup);
  assert.equal((await send("POST", "/signup", { email: "jamie@example.com", username: "other", password: "battery-power" })).status, 409, "one account per email");
  assert.equal((await send("POST", "/signup", { email: "b@example.com", username: "JAMIE_W", password: "battery-power" })).status, 409, "usernames are unique, ignoring case");

  const saved = await (await send("PUT", "/state", { state: { games: [{ date: "2026-11-01", score: 30, charge: 70 }] } }, phone)).json();
  assert.equal(saved.state.games.length, 1);

  assert.equal((await send("POST", "/login", { email: "jamie@example.com", password: "wrong-password" })).status, 401);
  assert.equal((await send("POST", "/login", { email: "nobody@example.com", password: "battery-power" })).status, 401);
  const login = await send("POST", "/login", { email: "JAMIE@example.com", password: "battery-power" });
  assert.equal(login.status, 200);
  const laptop = cookieOf(login);
  const merged = await (await send("PUT", "/state", { state: { games: [{ date: "2026-11-02", score: 5, charge: 95 }] } }, laptop)).json();
  assert.deepEqual(merged.state.games.map(game => game.date), ["2026-11-01", "2026-11-02"], "the laptop gets the phone's games too");
  assert.equal((await (await send("GET", "/me", undefined, phone)).json()).account.username, "jamie_w");

  assert.equal((await send("POST", "/logout", undefined, laptop)).status, 204);
  assert.equal((await (await send("GET", "/me", undefined, laptop)).json()).account, null, "that session is over");
  assert.equal((await (await send("GET", "/me", undefined, phone)).json()).account.username, "jamie_w", "other devices stay logged in");
  assert.equal((await send("PUT", "/state", { state: {} }, laptop)).status, 401, "saving needs a session");
  assert.equal((await send("PUT", "/state", { state: [] }, phone)).status, 400);

  const reopened = createAccountStore({ filePath });
  await reopened.init();
  assert.equal((await reopened.findByEmail("jamie@example.com")).username, "jamie_w", "accounts survive a restart");
  assert.equal((await reopened.dailySignups()).reduce((sum, day) => sum + day.accounts, 0), 1);
});

test("the stats spreadsheet counts new and total accounts per day", () => {
  const { columns, rows } = buildReport({ signups: [{ date: "2026-11-01", accounts: 2 }, { date: "2026-11-03", accounts: 1 }] }, "2026-11-03");
  assert.deepEqual(columns.slice(-2), ["New accounts", "Total accounts"]);
  assert.deepEqual(rows.map(row => row.slice(-2)), [[2, 2], [0, 2], [1, 3]]);
});
