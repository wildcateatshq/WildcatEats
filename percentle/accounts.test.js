"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createAccountStore, hashPassword, mergeStates, publicAccount, verifyPassword } = require("./accounts");
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

  const wallets = mergeStates(
    { wallet: { endless: { runA: { date: "2026-11-01", coins: 55 } }, owned: { "color-ice": "2026-11-01" }, equipped: { colors: { id: "color-ice", at: 100 } } } },
    { wallet: { endless: { runB: { date: "2026-11-02", coins: 10 } }, owned: { "lightning-pink": "2026-11-02" }, equipped: { colors: { id: "color-gold", at: 200 }, lightning: { id: "lightning-pink", at: 150 } } } }
  ).wallet;
  assert.deepEqual(Object.keys(wallets.endless).sort(), ["runA", "runB"], "coins from runs on both devices");
  assert.deepEqual(Object.keys(wallets.owned).sort(), ["color-ice", "lightning-pink"], "items bought on both devices");
  assert.equal(wallets.equipped.colors.id, "color-gold", "the most recent pick wins");
  assert.equal(wallets.equipped.lightning.id, "lightning-pink");
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
  const bad = await send("POST", "/signup", { email: "nope", username: "x", password: "short", agreed: true });
  assert.equal(bad.status, 400);
  const unagreed = await send("POST", "/signup", { email: "kid@example.com", username: "kid_1", password: "battery-power" });
  assert.equal(unagreed.status, 400, "signing up needs the 13+ and Terms box ticked");
  assert.match((await unagreed.json()).error, /13 or older/);
  assert.match((await bad.json()).error, /valid email[\s\S]*3 to 20[\s\S]*8 characters/);

  const signup = await send("POST", "/signup", { email: " Jamie@Example.com ", username: "jamie_w", password: "battery-power", agreed: true });
  assert.equal(signup.status, 201);
  assert.deepEqual((await signup.json()).account, { username: "jamie_w", email: "jamie@example.com" });
  assert.match(signup.headers.get("set-cookie"), /chargle_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
  const phone = cookieOf(signup);
  assert.equal((await send("POST", "/signup", { email: "jamie@example.com", username: "other", password: "battery-power", agreed: true })).status, 409, "one account per email");
  assert.equal((await send("POST", "/signup", { email: "b@example.com", username: "JAMIE_W", password: "battery-power", agreed: true })).status, 409, "usernames are unique, ignoring case");

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

test("a forgotten password is reset by a one-time emailed link, and an account can be deleted", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-reset-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createAccountStore({ filePath: path.join(dir, "accounts.json") });
  await store.init();
  const sent = [];
  const mailer = { configured: true, sendPasswordReset: async (to, username, link) => sent.push({ to, username, link }) };
  const app = express();
  app.use(express.json());
  app.use("/a", createAccountsRouter(store, { mailer, siteUrl: "https://chargle.io" }));
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://localhost:${server.address().port}/a`;
  const send = (pathname, body, cookie) => fetch(url + pathname, {
    method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body)
  });
  const cookieOf = response => response.headers.get("set-cookie").split(";")[0];

  const phone = cookieOf(await send("/signup", { email: "sam@example.com", username: "sam", password: "old-password", agreed: true }));
  assert.deepEqual(await (await send("/forgot", { email: "nobody@example.com" })).json(), { ok: true }, "the same answer for an email with no account");
  assert.equal(sent.length, 0);
  assert.equal((await send("/forgot", { email: "SAM@example.com" })).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "sam@example.com");
  assert.match(sent[0].link, /^https:\/\/chargle\.io\/\?password-token=[\w-]+$/, "the link always points at the real site");
  await send("/forgot", { email: "sam@example.com" });
  assert.equal(sent.length, 1, "asking again right away doesn't send another email");

  const token = new URL(sent[0].link).searchParams.get("password-token");
  assert.equal((await send("/reset", { token, password: "short" })).status, 400);
  assert.equal((await send("/reset", { token: "made-up", password: "new-password" })).status, 400);
  const reset = await send("/reset", { token, password: "new-password" });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).account.username, "sam");
  assert.equal((await send("/reset", { token, password: "another-password" })).status, 400, "a link works only once");
  assert.equal((await send("/login", { email: "sam@example.com", password: "old-password" })).status, 401, "the old password is gone");
  assert.equal((await (await fetch(`${url}/me`, { headers: { Cookie: phone } })).json()).account, null, "other devices are logged out");
  const laptop = cookieOf(await send("/login", { email: "sam@example.com", password: "new-password" }));

  assert.equal((await send("/delete", { password: "wrong-password" }, laptop)).status, 401, "deleting needs the password");
  assert.equal((await send("/delete", { password: "new-password" }, laptop)).status, 204);
  assert.equal(await store.findByEmail("sam@example.com"), null, "the account is gone");
  assert.equal((await send("/login", { email: "sam@example.com", password: "new-password" })).status, 401);
  assert.equal((await send("/signup", { email: "sam@example.com", username: "sam", password: "fresh-start", agreed: true })).status, 201, "the email and username are free again");
});

test("without email set up, a live server says reset emails aren't available", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-nomail-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createAccountStore({ filePath: path.join(dir, "accounts.json") });
  await store.init();
  const app = express();
  app.use(express.json());
  app.use("/a", createAccountsRouter(store, { mailer: { configured: false, sendPasswordReset: async () => false } }));
  const server = app.listen(0);
  t.after(() => server.close());
  // fetch can't set the Host header, so this asks with node:http.
  const forgot = host => new Promise((resolve, reject) => {
    const request = require("node:http").request({
      port: server.address().port, path: "/a/forgot", method: "POST", headers: { "Content-Type": "application/json", Host: host }
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end(JSON.stringify({ email: "a@example.com" }));
  });
  assert.equal(await forgot("chargle.io"), 503);
  assert.equal(await forgot(`localhost:${server.address().port}`), 200, "a local test server still works (the link goes to its log)");
});

test("reset emails go through Resend when its key is set", async () => {
  const { createMailer } = require("./mailer");
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => "" };
  };
  const mailer = createMailer({ RESEND_API_KEY: "re_test", CHARGLE_MAIL_FROM: "Chargle <noreply@chargle.io>" }, fakeFetch);
  assert.equal(mailer.configured, true);
  assert.equal(await mailer.sendPasswordReset("sam@example.com", "sam", "https://chargle.io/?password-token=abc", 60), true);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].options.headers.Authorization, "Bearer re_test");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.from, "Chargle <noreply@chargle.io>");
  assert.equal(body.to, "sam@example.com");
  assert.match(body.text, /https:\/\/chargle\.io\/\?password-token=abc/);
  assert.equal(createMailer({}).configured, false, "nothing set: not configured");
});

test("the local test account exists only on a server started for local testing", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-dev-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createAccountStore({ filePath: path.join(dir, "accounts.json") });
  await store.init();
  const app = express();
  app.use(express.json());
  app.use("/live", createAccountsRouter(store, { dev: false }));
  app.use("/local", createAccountsRouter(store, { dev: true }));
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://localhost:${server.address().port}`;
  assert.equal((await fetch(`${url}/live/dev-login`, { method: "POST" })).status, 404, "not on the live site");
  const login = await fetch(`${url}/local/dev-login`, { method: "POST" });
  assert.equal((await login.json()).account.username, "local_tester");
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const put = state => fetch(`${url}/local/state`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ state }) });
  await put({ games: [{ date: "2026-11-01", score: 10, charge: 90 }] });
  assert.equal((await fetch(`${url}/local/dev-reset`, { method: "POST", headers: { Cookie: cookie } })).status, 204);
  assert.deepEqual((await (await put({})).json()).state.games, [], "reset empties the test account's save");
  assert.equal((await (await fetch(`${url}/local/dev-login`, { method: "POST" })).json()).account.username, "local_tester", "the same account next time");
});

test("the stats spreadsheet counts new and total accounts per day", () => {
  const { columns, rows } = buildReport({ signups: [{ date: "2026-11-01", accounts: 2 }, { date: "2026-11-03", accounts: 1 }] }, "2026-11-03");
  assert.deepEqual(columns.slice(-2), ["New accounts", "Total accounts"]);
  assert.deepEqual(rows.map(row => row.slice(-2)), [[2, 2], [0, 2], [1, 3]]);
});

test("only accounts named in CHARGLE_OWNER_EMAILS are marked as the owner", t => {
  const previous = process.env.CHARGLE_OWNER_EMAILS;
  t.after(() => (previous === undefined ? delete process.env.CHARGLE_OWNER_EMAILS : (process.env.CHARGLE_OWNER_EMAILS = previous)));
  process.env.CHARGLE_OWNER_EMAILS = " Boss@Example.com , other@example.com";
  assert.equal(publicAccount({ username: "boss", email: "boss@example.com" }).owner, true);
  assert.equal("owner" in publicAccount({ username: "player", email: "player@example.com" }), false);
  delete process.env.CHARGLE_OWNER_EMAILS;
  assert.equal("owner" in publicAccount({ username: "boss", email: "boss@example.com" }), false);
});
