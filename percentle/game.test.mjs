import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGuessKey,
  chargeLeft,
  crowdRank,
  DRAIN_RATE,
  REACTIONS,
  reactionFor,
  dailyTotal,
  guessEntryFrom,
  guessEntryText,
  litLevel,
  easternDate,
  isOutOfCharge,
  pointsOff,
  scoreColor,
  viewForProgress,
} from "../public/percentle/game.mjs";

test("points off is absolute percentage point difference", () => {
  assert.equal(pointsOff(21.5, 36), 14.5);
  assert.equal(pointsOff(100, 0), 100);
});

test("guesses within 0.5 points of the answer score a perfect 0", () => {
  assert.equal(pointsOff(16.4, 16), 0);
  assert.equal(pointsOff(15.6, 16), 0);
  assert.equal(pointsOff(16.5, 16), 0, "exactly 0.5 counts");
  assert.equal(pointsOff(16.6, 16), 0.6, "just outside scores the full difference");
  assert.equal(pointsOff(0.3, 0.8), 0);
});

test("points off rejects guesses outside the percentage range", () => {
  assert.throws(() => pointsOff(-0.1, 20), RangeError);
  assert.throws(() => pointsOff(101, 20), RangeError);
});

test("daily total sums the five absolute differences", () => {
  const questions = [10, 20, 30, 40, 50].map(answer => ({ answer }));
  // 1 + 2 + 0 (30.5 is within 0.5 of 30) + 2 + 5
  assert.equal(dailyTotal([11, 18, 30.5, 42, 45], questions), 10);
  assert.throws(() => dailyTotal([10], questions), RangeError);
});

test("charge left drains from 100 at the drain rate and can go negative", () => {
  assert.equal(chargeLeft(0), 100);
  assert.equal(chargeLeft(60, 0.5), 70);
  assert.equal(chargeLeft(200, 0.5), 0);
  assert.equal(chargeLeft(216.4, 0.5), -8.2);
  assert.equal(chargeLeft(60, 1), 40);
  assert.equal(chargeLeft(60), 100 - 60 * DRAIN_RATE, "defaults to DRAIN_RATE");
});

test("the game is over once the charge drops below zero, but exactly zero survives", () => {
  const questions = [10, 20, 30, 40, 50].map(answer => ({ answer }));
  assert.equal(isOutOfCharge([10, 20], questions, 1), false);
  assert.equal(isOutOfCharge([100, 20], questions, 1), false, "90 off leaves 10% charge");
  assert.equal(isOutOfCharge([100, 30], questions, 1), false, "exactly 0.0% survives");
  assert.equal(isOutOfCharge([100, 30.6], questions, 1), true, "−0.6% is out");
  assert.equal(isOutOfCharge([100, 100], questions, 0.5), false, "at half drain, 170 off still leaves charge");
  // Out of charge after question 2: once it's revealed, the game jumps to results.
  assert.deepEqual(viewForProgress({ guesses: [100, 100], revealed: 1 }, 5, true), { phase: "reveal", index: 1 });
  assert.deepEqual(viewForProgress({ guesses: [100, 100], revealed: 2 }, 5, true), { phase: "results", index: 5 });
});

test("the crowd ranks every finisher above every player who ran out, and later deaths above earlier ones", () => {
  const questions = [10, 20, 30, 40, 50].map(answer => ({ answer }));
  const finishedBadly = crowdRank([60, 70, 30, 40, 50], questions, 1); // 100 off, 0.0% left
  const diedOnQ5 = crowdRank([60, 70, 30, 40, 51], questions, 1);
  const diedOnQ3 = crowdRank([60, 70, 31], questions, 1);
  const diedOnQ3Worse = crowdRank([100, 100, 100], questions, 1);
  assert.equal(finishedBadly, 100);
  assert.ok(diedOnQ5 > finishedBadly);
  assert.ok(diedOnQ3 > diedOnQ5);
  assert.equal(diedOnQ3, diedOnQ3Worse, "same question ties");
  assert.ok(crowdRank([100, 100, 100], questions, 0.5) <= 500, "fits the crowd store's limit");
});

test("the day rolls over at midnight Eastern in both EDT and EST", () => {
  assert.equal(easternDate(new Date("2026-10-07T03:59:00Z")), "2026-10-06");
  assert.equal(easternDate(new Date("2026-10-07T04:00:00Z")), "2026-10-07");
  assert.equal(easternDate(new Date("2026-12-01T04:59:00Z")), "2026-11-30");
  assert.equal(easternDate(new Date("2026-12-01T05:00:00Z")), "2026-12-01");
});

test("each locked question reveals before the next guess and final results", () => {
  const progress = { guesses: [], revealed: 0 };
  for (let index = 0; index < 5; index++) {
    assert.deepEqual(viewForProgress(progress), { phase: "guess", index });
    progress.guesses.push(50);
    assert.deepEqual(viewForProgress(progress), { phase: "reveal", index });
    progress.revealed++;
  }
  assert.deepEqual(viewForProgress(progress), { phase: "results", index: 5 });
});

test("typed guesses keep a fixed decimal point", () => {
  const type = (start, keys) => guessEntryText([...keys].reduce(applyGuessKey, guessEntryFrom(start)));
  assert.equal(type(50, "425"), "42.5", "two whole digits, then the tenths");
  assert.equal(type(50, "42"), "42.0");
  assert.equal(type(50, "7.5"), "7.5", "a decimal point jumps to the tenths early");
  assert.equal(type(50, "4"), "4.0");
  assert.equal(type(50, "4256"), "42.6", "extra digits replace the tenths");
  assert.equal(type(50, "05"), "5.0", "no leading zero");
  const backspace = keys => [...keys].map(key => key === "<" ? "Backspace" : key);
  const typeKeys = (start, keys) => guessEntryText(keys.reduce(applyGuessKey, guessEntryFrom(start)));
  assert.equal(typeKeys(37.4, backspace("<")), "37.0", "backspace clears the tenths first");
  assert.equal(typeKeys(37.4, backspace("<<")), "3.0", "then the whole digits");
  assert.equal(typeKeys(50, backspace("425<<")), "4.0");
  assert.equal(typeKeys(50, backspace("425<<6")), "46.0", "after deleting, typing continues in the whole part");
});

test("guesses glow brighter the closer they are, fully lit within the perfect margin", () => {
  assert.equal(litLevel(0), 1);
  assert.equal(litLevel(0.5), 1);
  assert.ok(litLevel(5) > litLevel(5.1), "each tenth further away is a little dimmer");
  assert.equal(litLevel(25), 0.5);
  assert.equal(litLevel(50), 0);
  assert.equal(litLevel(80), 0);
});

test("reactions match how close the guess was and stay the same on reload", () => {
  const tierOf = line => REACTIONS.findIndex(tier => tier.lines.includes(line));
  assert.equal(reactionFor(0, "q"), "", "perfect answers get the stamp instead");
  assert.equal(tierOf(reactionFor(2, "q")), 0);
  assert.equal(tierOf(reactionFor(10, "q")), 2);
  assert.equal(tierOf(reactionFor(45, "q")), 4);
  assert.equal(reactionFor(10, "same question"), reactionFor(10, "same question"));
});

test("result colors respect their point-off thresholds", () => {
  assert.equal(scoreColor(5), "green");
  assert.equal(scoreColor(15), "yellow");
  assert.equal(scoreColor(30), "orange");
  assert.equal(scoreColor(30.1), "red");
});
