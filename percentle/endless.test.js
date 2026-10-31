"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createEndlessStore, periodStart } = require("./endless");
const { createEndlessRouter } = require("./endless-router");
const { categoryFor, questionText } = require("./test-questions");

const question = n => ({
  text: questionText(n),
  answer: 40 + (n % 50),
  category: categoryFor(n),
  funFact: "A short fun fact for testing.",
  sourceName: "Test Source",
  sourceUrl: "https://example.com/source"
});
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("periods are two-week blocks starting on launch day", () => {
  assert.equal(periodStart("2026-10-06"), "2026-10-06");
  assert.equal(periodStart("2026-10-19"), "2026-10-06");
  assert.equal(periodStart("2026-10-20"), "2026-10-20");
});

test("the endless API fills banks in batches, goes live at 250 questions, and compares best runs", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-endless-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "endless.json");
  const store = createEndlessStore({ filePath });
  await store.init();
  const app = express();
  app.use(express.json());
  app.use("/e", createEndlessRouter(store, { today: () => "2026-10-08", publishToken: "secret" }));
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://localhost:${server.address().port}/e`;
  const auth = { "Content-Type": "application/json", Authorization: "Bearer secret" };
  const post = (pathname, body, headers = auth) => fetch(url + pathname, { method: "POST", headers, body: JSON.stringify(body) });

  assert.equal((await fetch(`${url}/bank`)).status, 404, "warming up with no questions");
  assert.deepEqual(await (await fetch(`${url}/availability`)).json(), { live: false, needed: 250 });
  assert.equal((await post("/banks/2026-10-06/questions", { questions: [question(1)] }, { "Content-Type": "application/json" })).status, 401, "only the agent adds questions");
  assert.equal((await post("/banks/2026-09-22/questions", { questions: [question(1)] })).status, 400, "past periods are closed");
  assert.equal((await post("/banks/2026-10-06/questions", { questions: Array.from({ length: 51 }, (_, i) => question(i)) })).status, 400, "batches are at most 50");

  for (let batch = 0; batch < 5; batch++) {
    if (batch === 4) assert.equal((await fetch(`${url}/bank`)).status, 404, "still warming up at 200");
    const response = await post("/banks/2026-10-06/questions", { questions: Array.from({ length: 50 }, (_, i) => question(batch * 50 + i)) });
    assert.equal(response.status, 201);
  }
  const duplicate = await post("/banks/2026-10-06/questions", { questions: [question(3)] });
  assert.equal(duplicate.status, 422, "repeats are turned away");
  assert.match((await duplicate.json()).rejected[0].problems[0], /too similar/);

  assert.equal((await (await fetch(`${url}/availability`)).json()).live, true);
  const bank = await (await fetch(`${url}/bank`)).json();
  assert.equal(bank.startsOn, "2026-10-06");
  assert.equal(bank.endsOn, "2026-10-19");
  assert.equal(bank.questions.length, 250);

  const status = await (await fetch(`${url}/status`, { headers: auth })).json();
  assert.equal(status.current.count, 250);
  assert.equal(Object.values(status.current.categories).reduce((sum, n) => sum + n, 0), 250);
  assert.deepEqual(status.next.categories, {});
  assert.equal(status.next.startsOn, "2026-10-20");

  const removed = await (await post("/banks/2026-10-06/remove", { texts: [question(0).text.toUpperCase()] })).json();
  assert.deepEqual(removed, { removed: 1, count: 249 });

  for (let n = 1; n <= 6; n++) await post("/runs", { startsOn: "2026-10-06", id: id(n), best: n * 2 }, { "Content-Type": "application/json" });
  const lower = await (await post("/runs", { startsOn: "2026-10-06", id: id(6), best: 3 }, { "Content-Type": "application/json" })).json();
  assert.equal(lower.players, 6);
  assert.equal(lower.betterThan, 91.7, "a worse run keeps the player's best (12): beats 5 of 6, plus half a tie");
  assert.equal((await post("/runs", { startsOn: "2026-09-08", id: id(1), best: 5 }, { "Content-Type": "application/json" })).status, 400, "old periods are closed");

  // Hard-mode runs are a separate line: a hard player is only compared with other hard players.
  const hard = await (await post("/runs", { startsOn: "2026-10-06", id: id(20), best: 1, mode: "hard" }, { "Content-Type": "application/json" })).json();
  assert.equal(hard.players, 1, "normal runs don't count on the hard line");
  for (let n = 21; n <= 26; n++) await post("/runs", { startsOn: "2026-10-06", id: id(n), best: n - 20, mode: "hard" }, { "Content-Type": "application/json" });
  const hardBest = await (await post("/runs", { startsOn: "2026-10-06", id: id(26), best: 6, mode: "hard" }, { "Content-Type": "application/json" })).json();
  assert.equal(hardBest.players, 7);
  assert.equal(hardBest.betterThan, 92.9, "the best hard run beats 6 of 7, plus half of its own tie");
  const normalAgain = await (await post("/runs", { startsOn: "2026-10-06", id: id(6), best: 3 }, { "Content-Type": "application/json" })).json();
  assert.equal(normalAgain.players, 6, "hard runs don't count on the normal line");
  assert.equal((await post("/runs", { startsOn: "2026-10-06", id: id(30), best: 3, mode: "easy" }, { "Content-Type": "application/json" })).status, 400);

  const reopened = createEndlessStore({ filePath });
  await reopened.init();
  assert.equal((await reopened.getBank("2026-10-06")).length, 249, "the bank survives a restart");
});
