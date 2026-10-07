"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createPuzzleStore, easternDate, puzzleNumber, validatePuzzle } = require("./puzzles");
const { createPuzzleRouter } = require("./puzzle-router");

const question = (category, overrides = {}) => ({
  text: `What percentage of ${category} things happened in 2024?`,
  answer: 42.5,
  category,
  funFact: "A short, true fact about the answer.",
  sourceName: "Example source",
  sourceUrl: "https://example.com/source",
  ...overrides
});
const validPuzzle = () => ["Sports", "Music", "Movies", "U.S. life", "Sports"].map((category, index) =>
  question(category, { text: `What percentage of ${category} item ${index} happened in 2024?` })
);

test("puzzle numbers count Eastern calendar days from launch", () => {
  assert.equal(puzzleNumber("2026-10-06"), 1);
  assert.equal(puzzleNumber("2026-11-05"), 31);
  assert.equal(easternDate(new Date("2026-10-07T03:59:00Z")), "2026-10-06");
});

test("valid puzzles pass and keep only the published fields", () => {
  const cleaned = validatePuzzle(validPuzzle().map(item => ({ ...item, extra: "dropped" })));
  assert.equal(cleaned.length, 5);
  assert.equal("extra" in cleaned[0], false);
});

test("puzzle validation reports every problem at once", () => {
  const puzzle = validPuzzle();
  puzzle[0].answer = 100;
  puzzle[1].sourceUrl = "http://insecure.example.com";
  puzzle[2].category = "Science";
  puzzle[3].text = "No question mark here at all";
  assert.throws(() => validatePuzzle(puzzle), /Question 1 answer[\s\S]*Question 2 sourceUrl[\s\S]*Question 3 category[\s\S]*Question 4 text/);
});

test("any category mix is allowed, but each puzzle has exactly five questions", () => {
  const allSports = validPuzzle().map((item, index) => ({ ...item, category: "Sports", text: `What percentage of sports thing ${index} happened?` }));
  assert.equal(validatePuzzle(allSports).length, 5);
  const allWorld = validPuzzle().map((item, index) => ({ ...item, category: "World", text: `What percentage of world thing ${index} happened?` }));
  assert.equal(validatePuzzle(allWorld).length, 5);
  assert.throws(() => validatePuzzle(validPuzzle().slice(0, 4)), /exactly 5/);
});

test("file-backed puzzle store persists across restarts", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-puzzles-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const filePath = path.join(folder, "puzzles.json");
  const store = createPuzzleStore({ filePath });
  await store.init();
  await store.put("2026-10-06", validatePuzzle(validPuzzle()));
  const reloaded = createPuzzleStore({ filePath });
  await reloaded.init();
  assert.equal((await reloaded.get("2026-10-06")).length, 5);
  assert.deepEqual(await reloaded.dates("2026-10-01", "2026-10-31"), ["2026-10-06"]);
});

test("puzzle API publishes with a token and never leaks future puzzles", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-puzzle-api-"));
  const store = createPuzzleStore({ filePath: path.join(folder, "puzzles.json") });
  await store.init();
  const app = express();
  app.use(express.json());
  app.use("/api/percentle/puzzles", createPuzzleRouter(store, { today: () => "2026-10-06", publishToken: "secret-token" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(folder, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/percentle/puzzles`;
  const publish = (date, token = "secret-token", questions = validPuzzle()) => fetch(`${url}/${date}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ questions })
  });

  assert.equal((await fetch(`${url}/today`)).status, 404);
  assert.equal((await publish("2026-10-06", "wrong-token")).status, 401);
  const bad = validPuzzle();
  bad[0].answer = 0;
  const rejected = await publish("2026-10-06", "secret-token", bad);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Question 1 answer/);

  assert.equal((await publish("2026-10-06")).status, 201);
  const today = await fetch(`${url}/today`).then(response => response.json());
  assert.equal(today.number, 1);
  assert.equal(today.questions.length, 5);
  assert.equal((await publish("2026-10-06")).status, 409);
  assert.equal((await publish("2026-10-05")).status, 400);
  assert.equal((await publish("2026-10-20")).status, 400);

  assert.equal((await publish("2026-10-07")).status, 201);
  assert.equal((await publish("2026-10-07")).status, 201, "unreleased days can be replaced");
  assert.equal((await fetch(`${url}/2026-10-07`)).status, 404);
  assert.equal((await fetch(`${url}/2026-10-07`, { headers: { authorization: "Bearer secret-token" } })).status, 200);

  assert.equal((await fetch(`${url}/history`)).status, 401);
  const padded = await fetch(`${url}/history`, { headers: { authorization: 'Bearer "secret-token" ' } });
  assert.equal(padded.status, 200, "stray quotes and spaces around the token are ignored");
  const history = await fetch(`${url}/history`, { headers: { authorization: "Bearer secret-token" } }).then(response => response.json());
  assert.deepEqual(history.puzzles.map(puzzle => puzzle.date), ["2026-10-07", "2026-10-06"]);
  assert.deepEqual((await fetch(`${url}/archive`).then(response => response.json())).puzzles, []);

  const auth = { authorization: "Bearer secret-token", "content-type": "application/json" };
  assert.equal((await fetch(`${url}/agent-notes`)).status, 401);
  assert.equal((await fetch(`${url}/agent-notes`, { headers: auth }).then(response => response.json())).notes, "");
  const saved = await fetch(`${url}/agent-notes`, { method: "PUT", headers: auth, body: JSON.stringify({ notes: "Likes NBA; dislikes census stats." }) });
  assert.equal(saved.status, 200);
  assert.equal((await fetch(`${url}/agent-notes`, { headers: auth }).then(response => response.json())).notes, "Likes NBA; dislikes census stats.");
  assert.equal((await fetch(`${url}/agent-notes`, { method: "PUT", headers: auth, body: JSON.stringify({ notes: "x".repeat(20_001) }) })).status, 400);
});
