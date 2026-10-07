import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGuessKey,
  dailyTotal,
  guessEntryFrom,
  guessEntryText,
  easternDate,
  pointsOff,
  scoreColor,
  viewForProgress,
} from "../public/percentle/game.mjs";

test("points off is absolute percentage point difference", () => {
  assert.equal(pointsOff(21.5, 36), 14.5);
  assert.equal(pointsOff(100, 0), 100);
});

test("points off rejects guesses outside the percentage range", () => {
  assert.throws(() => pointsOff(-0.1, 20), RangeError);
  assert.throws(() => pointsOff(101, 20), RangeError);
});

test("daily total sums the five absolute differences", () => {
  const questions = [10, 20, 30, 40, 50].map(answer => ({ answer }));
  assert.equal(dailyTotal([11, 18, 30.5, 42, 45], questions), 10.5);
  assert.throws(() => dailyTotal([10], questions), RangeError);
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

test("result colors respect their point-off thresholds", () => {
  assert.equal(scoreColor(5), "green");
  assert.equal(scoreColor(15), "yellow");
  assert.equal(scoreColor(30), "orange");
  assert.equal(scoreColor(30.1), "red");
});
