"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { BANK_MAX_SAME_NAME, BANK_MAX_SAME_SHAPE, checkBankBatch, checkPuzzle, names } = require("./variety");
const { createPuzzleStore } = require("./puzzles");
const { createPuzzleRouter } = require("./puzzle-router");
const { createEndlessStore } = require("./endless");
const { createEndlessRouter } = require("./endless-router");
const { categoryFor, questionText } = require("./test-questions");

const q = (text, category = "Sports") => ({ text, category });
const full = (text, category) => ({ text, answer: 42.5, category, funFact: "A short, true fact.", sourceName: "Example source", sourceUrl: "https://example.com/source" });
const filler = (from, count) => Array.from({ length: count }, (_, i) => q(questionText(from + i), categoryFor(from + i)));

test("names are the question's subjects, not its time frames or generic words", () => {
  assert.deepEqual(names("In 2024–25, what percentage of Nikola Jokić's regular-season games were triple-doubles?"), ["nikola jokić"]);
  assert.deepEqual(names("As of October 2026, what percentage of the Billboard Hot 100 was rap?"), []);
  assert.deepEqual(names("In Pew Research Center's July 2023 survey, what percentage of U.S. adults said they have a tattoo?"), []);
  assert.deepEqual(names("In 2025, what percentage of World Series games went seven?"), ["world series"]);
  assert.deepEqual(names("In the 2025 NFL Draft, what percentage of picks came from the SEC?"), ["nfl draft", "sec"]);
});

test("a daily puzzle can't repeat a stat, even reworded or for another season", () => {
  const paris = q("What percentage of the 329 gold medals at the 2024 Paris Summer Olympics were won by the United States?", "World");
  const reworded = q("At the 2024 Paris Summer Olympics, what percentage of the gold medals awarded were won by the United States?", "World");
  const problems = checkPuzzle([reworded, ...filler(0, 4)], { others: [paris] });
  assert.match(problems.join(" "), /Question 1: too similar to an earlier question \("What percentage of the 329 gold medals/);

  const lastSeason = q("In 2024–25, what percentage of Nikola Jokić's regular-season games were triple-doubles?");
  const thisSeason = q("In 2025–26, what percentage of Nikola Jokić's regular-season games were triple-doubles?");
  assert.match(checkPuzzle([thisSeason, ...filler(0, 4)], { others: [lastSeason] }).join(" "), /too similar/);
  assert.deepEqual(checkPuzzle(filler(0, 5), { others: [paris, lastSeason] }), [], "different questions are fine");
});

test("within two weeks a daily puzzle can't reuse a kind of question or a subject, nor have 3 of a category", () => {
  const africa = q("As of 2026, what percentage of the world's population lives in Africa?", "World");
  const asia = q("In 2021, what percentage of the world's population lived in Asia?", "World");
  assert.match(checkPuzzle([asia, ...filler(0, 4)], { nearby: [africa] }).join(" "), /same kind of question .* within 14 days/);
  assert.deepEqual(checkPuzzle([asia, ...filler(0, 4)], { others: [africa] }), [], "after two weeks the same kind is fine again");

  const lakers = q("In 2025–26, what percentage of his made field goals for the Lakers were dunks for LeBron James?");
  const lakersAgain = q("In the 2024–25 regular season, what percentage of their home games did the Lakers win?");
  assert.match(checkPuzzle([lakersAgain, ...filler(0, 4)], { nearby: [lakers] }).join(" "), /"lakers" already appears 1 time within 14 days/);

  const threeSports = [...filler(0, 2).map(item => ({ ...item, category: "Sports" })), q(questionText(40)), ...filler(50, 2).map(item => ({ ...item, category: "World" }))];
  assert.match(checkPuzzle(threeSports).join(" "), /Question 3: a puzzle can have at most 2 Sports questions/);
  assert.deepEqual(checkPuzzle(threeSports, { special: true }), [], "a special may be all one category");
});

test("an endless bank limits each kind of question, subject, and category, and turns away repeats", () => {
  const players = ["Luka Dončić", "Stephen Curry", "Kevin Durant", "Jalen Brunson", "Devin Booker", "Anthony Edwards", "Tyrese Maxey", "Jayson Tatum"];
  const splits = players.map(player => q(`In 2025–26, what percentage of ${player}'s regular-season points came from free throws?`));
  const bank = filler(0, 100);
  const { accepted, rejected } = checkBankBatch(splits, { bank });
  assert.equal(accepted.length, BANK_MAX_SAME_SHAPE, "the batch counts against itself");
  assert.match(rejected[0].problems[0], /same kind of question has been asked 6 times in this bank/);

  const jokic = ["triple-doubles", "games with 30 points", "shots at the rim", "assisted baskets"].map(stat => q(`In 2025–26, how many of Nikola Jokić's ${stat} came at home, as a percentage?`));
  const subject = checkBankBatch(jokic.map((item, i) => ({ ...item, text: [
    "In 2025–26, what percentage of Nikola Jokić's regular-season games were triple-doubles?",
    "In 2025–26, what percentage of his free throws did Nikola Jokić make?",
    "In 2025–26, what percentage of Nikola Jokić's shots came at the rim?",
    "In 2025–26, what percentage of Nikola Jokić's baskets were assisted?"
  ][i] })), { bank });
  assert.equal(subject.accepted.length, BANK_MAX_SAME_NAME);
  assert.match(subject.rejected[0].problems.join(" "), /"nikola jokić" already appears 3 times in this bank/);

  const sportsHeavy = [...filler(200, 40).map(item => ({ ...item, category: "Sports" })), ...filler(300, 60).map(item => ({ ...item, category: "World" }))];
  const crowded = checkBankBatch([q(questionText(500))], { bank: sportsHeavy });
  assert.match(crowded.rejected[0].problems[0], /Sports already has 40 of this bank's 100 questions/);
  assert.equal(checkBankBatch([q(questionText(500), "Music")], { bank: sportsHeavy }).accepted.length, 1, "other categories still go in");

  const daily = q("At the 2024 Paris Summer Olympics, what percentage of the gold medals awarded were won by the United States?", "World");
  const repeat = checkBankBatch([q("What percentage of the 329 gold medals at the 2024 Paris Summer Olympics were won by the United States?", "World")], { bank, others: [daily] });
  assert.match(repeat.rejected[0].problems[0], /too similar/);
});

test("publishing and the agent's check endpoints enforce variety across daily puzzles and banks", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-variety-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const puzzles = createPuzzleStore({ filePath: path.join(dir, "puzzles.json") });
  const endless = createEndlessStore({ filePath: path.join(dir, "endless.json") });
  await puzzles.init();
  await endless.init();
  const today = () => "2026-10-08";
  const app = express();
  app.use(express.json());
  app.use("/p", createPuzzleRouter(puzzles, { today, publishToken: "secret", endless }));
  app.use("/e", createEndlessRouter(endless, { today, publishToken: "secret", puzzles }));
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://localhost:${server.address().port}`;
  const send = (method, pathname, body) => fetch(url + pathname, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify(body) });

  const paris = full("What percentage of the 329 gold medals at the 2024 Paris Summer Olympics were won by the United States?", "World");
  const day = (seed, first = full(questionText(seed * 5), "World")) => [first, ...[1, 2, 3, 4].map(i => full(questionText(seed * 5 + i), ["Sports", "Music", "U.S. life", "Movies"][i - 1]))];
  assert.equal((await send("PUT", "/p/2026-10-09", { questions: day(1, paris) })).status, 201);

  const reworded = full("At the 2024 Paris Summer Olympics, what percentage of the gold medals awarded were won by the United States?", "World");
  const check = await (await send("POST", "/p/2026-10-12/check", { questions: day(2, reworded) })).json();
  assert.equal(check.ok, false);
  assert.match(check.problems[0], /Question 1: too similar/);
  const refused = await send("PUT", "/p/2026-10-12", { questions: day(2, reworded) });
  assert.equal(refused.status, 400);
  assert.equal((await send("PUT", "/p/2026-10-09", { questions: day(1, paris) })).status, 201, "a day can be replaced with its own questions");

  const bankCheck = await (await send("POST", "/e/banks/2026-10-06/check", { questions: [reworded, full(questionText(90), "Music")] })).json();
  assert.deepEqual(bankCheck.results.map(result => result.ok), [false, true], "the bank knows the daily puzzles");
  const added = await send("POST", "/e/banks/2026-10-06/questions", { questions: [reworded, full(questionText(90), "Music")] });
  assert.equal(added.status, 201);
  const result = await added.json();
  assert.equal(result.added, 1);
  assert.equal(result.rejected.length, 1);
  const status = await (await fetch(`${url}/e/status`, { headers: { Authorization: "Bearer secret" } })).json();
  assert.equal(status.limits.maxSameKind, BANK_MAX_SAME_SHAPE);
});
