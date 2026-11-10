import test from "node:test";
import assert from "node:assert/strict";
import {
  achievementsForGame,
  applyGuessKey,
  bestGuessIndex,
  chargeTrack,
  chargeLeft,
  statsCharge,
  coinBalance,
  dailyCoins,
  endlessCoins,
  endlessDay,
  equippedItem,
  ENDLESS_COINS_PER_DAY,
  MARKET_ITEMS,
  formatValue,
  fromPosition,
  roundToScale,
  scaleOf,
  scaleStep,
  toPosition,
  crowdRank,
  DRAIN_RATE,
  drainRateFor,
  roundsSurvived,
  endlessClock,
  dailyTotal,
  guessEntryFrom,
  guessEntryText,
  litLevel,
  longestStreak,
  lowBatteryTier,
  streakAchievements,
  easternDate,
  endlessAchievements,
  endlessOrder,
  finalCharge,
  isOutOfCharge,
  pointsOff,
  questionKey,
  scoreColor,
  viewForProgress,
  activeVisitors,
  hasExtra
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

test("custom scales step by about a thousandth of the range and play by position along the bar", () => {
  const salary = { min: 20000, max: 120000, prefix: "$" };
  const rating = { min: 1, max: 10, unit: "/10" };
  const act = { min: 1, max: 36, unit: "points" };
  assert.equal(scaleStep(scaleOf({})), 0.1, "percentages keep tenths");
  assert.equal(scaleStep(salary), 100);
  assert.equal(scaleStep(rating), 0.01);
  assert.equal(scaleStep(act), 0.1);
  assert.equal(scaleStep({ min: 400, max: 1600 }), 1);
  assert.equal(toPosition(70000, salary), 50);
  assert.equal(fromPosition(50, salary), 70000);
  assert.equal(fromPosition(33.3333, rating), 4);
  assert.equal(roundToScale(19.43, act), 19.4);
  assert.equal(formatValue(70000, salary), "$70,000");
  assert.equal(formatValue(7.25, rating), "7.25/10");
  assert.equal(formatValue(19.4, act), "19.4 points");
  const grammys = { min: 0, max: 40, unit: "Grammys", whole: true };
  assert.equal(scaleStep(grammys), 1, "a count steps by whole numbers");
  assert.equal(fromPosition(33.3333, grammys), 13);
  assert.equal(formatValue(13, grammys), "13 Grammys");
  assert.equal(scaleStep({ ...salary, whole: true }), 100, "a big count keeps its bigger step");
  assert.equal(formatValue(42.5, scaleOf({})), "42.5%", "percentages look the same as ever");
  // Missing by a tenth of the range drains like 10 points off a percentage.
  assert.equal(pointsOff(toPosition(80000, salary), toPosition(70000, salary)), 10);
  assert.equal(pointsOff(toPosition(70400, salary), toPosition(70000, salary)), 0, "within 0.5% of the range is a supercharge");
});

test("typing a guess follows the scale's digits and decimals", () => {
  const type = (start, scale, keys) => guessEntryText([...keys].reduce((entry, key) => applyGuessKey(entry, key), guessEntryFrom(start, scale)));
  assert.equal(type(5.5, { min: 1, max: 10 }, "725"), "7.25");
  assert.equal(type(18.5, { min: 1, max: 36 }, "194"), "19.4");
  assert.equal(type(70000, { min: 20000, max: 120000 }, "65000"), "65000");
  assert.equal(type(70000, { min: 20000, max: 120000 }, "6.5"), "65", "no decimals on a scale that steps by 100");
});

test("coins: a daily game pays its charge, an endless run pays more the farther it gets, up to a daily limit", () => {
  assert.equal(dailyCoins({ charge: 60 }), 60, "finish on 60% and get 60");
  assert.equal(dailyCoins({ charge: 59.6 }), 60);
  assert.equal(dailyCoins({ charge: 40, hard: true }), 70, "hard games pay their regular-mode equivalent");
  assert.equal(dailyCoins({ charge: -12 }), 0, "running out pays nothing");
  assert.equal(endlessCoins(1), 1);
  assert.equal(endlessCoins(3), 4, "a run lost early pays little");
  assert.equal(endlessCoins(10), 40);
  const day = (paid, best) => ({ paid, best });
  assert.equal(endlessCoins(9, day(120, 34)), ENDLESS_COINS_PER_DAY - 120, "no more than the day's endless limit");
  assert.equal(endlessCoins(5, day(ENDLESS_COINS_PER_DAY, 40)), 0);
  assert.equal(endlessCoins(50), 400, "a long run pays in full");
  assert.equal(endlessCoins(10, day(400, 400)), 0, "nothing more after it that day");
  assert.equal(endlessCoins(50, day(150, 100)), 250, "a long run tops the day up to its own pay");
  assert.equal(endlessCoins(30, day(400, 400)), 0);
  assert.deepEqual(endlessDay({ endless: { a: { date: "2026-11-02", coins: 100, rounds: 20 }, b: { date: "2026-11-02", coins: 50 }, c: { date: "2026-11-01", coins: 7, rounds: 4 } } }, "2026-11-02"), { paid: 150, best: 100 });
  for (let rounds = 1; rounds < 40; rounds++) assert.ok(endlessCoins(rounds + 1) > endlessCoins(rounds), "every round pays something");
  const wallet = { endless: { a: { date: "2026-11-02", coins: 55 }, b: { date: "2026-11-01", coins: 30 } }, owned: { "color-ice": "2026-11-02" }, equipped: { colors: { id: "color-ice", at: 1 }, lightning: { id: "lightning-pink", at: 2 } } };
  assert.equal(endlessDay(wallet, "2026-11-02").paid, 55);
  assert.deepEqual(coinBalance({ games: [{ charge: 60 }, { charge: 90 }], wallet: { ...wallet, owned: { "color-ice": { date: "2026-11-02", price: 150 } } } }),
    { earned: 235, spent: 150, balance: 85 }, "an item costs what was paid for it, even if its price goes up later");
  assert.equal(equippedItem(wallet, "colors").id, "color-ice");
  assert.equal(equippedItem(wallet, "lightning").id, "lightning-gold", "an item that wasn't bought can't be in use");
  assert.equal(equippedItem(wallet, "visitors").id, "visitor-none");
  for (const category of ["visitors", "colors", "lightning"]) {
    assert.equal(MARKET_ITEMS.filter(item => item.category === category && item.price === 0).length, 1, `one free ${category} item to start with`);
  }
});

test("a hard game counts in stats as the charge the same guesses would leave in regular mode", () => {
  assert.equal(statsCharge(40, true), 70, "40% hard is 70% regular");
  assert.equal(statsCharge(0, true), 50, "an empty hard battery that survived is half full in regular");
  assert.equal(statsCharge(100, true), 100);
  assert.equal(statsCharge(33.3, true), 66.7, "rounded to one decimal place");
  assert.equal(statsCharge(-4, true), -4, "running out of charge still counts as running out");
  assert.equal(statsCharge(40), 40, "regular games are unchanged");
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
  const finishedLow = crowdRank([60, 70, 30, 40, 50], questions, 1); // 50, 0, then three supercharges: 15% left
  const diedOnQ5 = crowdRank([50, 60, 35, 45, 61], questions, 1);
  const diedOnQ3 = crowdRank([60, 70, 31], questions, 1);
  const diedOnQ3Worse = crowdRank([55, 65, 41], questions, 1);
  assert.equal(finishedLow, 85, "finishers send the charge they used up");
  assert.equal(crowdRank([10, 20, 30, 40, 50], questions, 1), 0, "a full battery ranks best");
  assert.ok(diedOnQ5 > finishedLow);
  assert.ok(diedOnQ3 > diedOnQ5);
  assert.equal(diedOnQ3, diedOnQ3Worse, "same question ties");
  assert.ok(crowdRank([100, 100], questions, 1) <= 500, "fits the crowd store's limit");
});

test("a SUPERCHARGED answer recharges the battery by 5%, never above 100%", () => {
  const questions = [10, 20, 30, 40, 50].map(answer => ({ answer }));
  assert.deepEqual(chargeTrack([15, 20, 30], questions, 1), [95, 100, 100], "95 + 5 = 100, then stays full");
  assert.deepEqual(chargeTrack([60, 70, 30], questions, 1), [50, 0, 5], "a supercharge at 0% brings it back to 5%");
  assert.equal(finalCharge([], questions), 100);
  assert.equal(isOutOfCharge([60, 70, 30.4], questions, 1), false, "30.4 is within 0.5, so it recharges instead");
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

test("result colors respect their point-off thresholds", () => {
  assert.equal(scoreColor(5), "green");
  assert.equal(scoreColor(15), "yellow");
  assert.equal(scoreColor(30), "orange");
  assert.equal(scoreColor(30.1), "red");
});

test("finishing alive on 20% or less gets a low-battery tier", () => {
  assert.equal(lowBatteryTier(20.1), null);
  assert.equal(lowBatteryTier(20), "fumes");
  assert.equal(lowBatteryTier(9.9), "clutch");
  assert.equal(lowBatteryTier(0.6), "last-drop");
  assert.equal(lowBatteryTier(0), "zero");
  assert.equal(lowBatteryTier(-3), null, "ran out of charge");
});

test("a finished game earns achievements for its charge, supercharged answers, or running out", () => {
  assert.deepEqual(achievementsForGame({ charge: 55, out: false }), ["first-charge"]);
  assert.deepEqual(achievementsForGame({ charge: 100, out: false, supercharged: 5 }), ["first-charge", "supercharged", "double-surge", "high-voltage", "fully-charged"]);
  assert.deepEqual(achievementsForGame({ charge: 0, out: false }), ["first-charge", "fumes", "clutch", "last-drop", "still-alive"]);
  assert.deepEqual(achievementsForGame({ charge: -8, out: true, supercharged: 1 }), ["first-charge", "supercharged", "blackout"]);
});

test("streak achievements count the longest run of consecutive days", () => {
  const week = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
  assert.equal(longestStreak(week), 7);
  assert.equal(longestStreak(["2026-10-01", "2026-10-03", "2026-10-04"]), 2, "a missed day breaks the run");
  assert.equal(longestStreak(["2026-10-31", "2026-11-01"]), 2, "runs across months");
  assert.deepEqual(streakAchievements(7), ["week-streak"]);
  assert.deepEqual(streakAchievements(6), []);
});

test("the best guess has the fewest points off, with ties going to the guess that was actually closer", () => {
  const questions = [10, 20, 30, 40, 50].map(answer => ({ answer }));
  assert.equal(bestGuessIndex([15, 30, 32, 60, 90], questions), 2, "Q3 was only 2 off");
  assert.equal(bestGuessIndex([10.4, 20.1, 50], questions), 1, "both within 0.5 score 0; Q2 was closer");
  assert.equal(bestGuessIndex([12, 22], questions), 0, "an exact tie keeps the earlier one");
});

test("hard mode drains twice as fast, so 50 points off empties the battery", () => {
  const questions = [10, 20, 30, 40, 50].map(answer => ({ answer }));
  assert.equal(drainRateFor(true), DRAIN_RATE * 2);
  assert.equal(drainRateFor(false), DRAIN_RATE);
  assert.deepEqual(chargeTrack([35, 45], questions, drainRateFor(true)), [50, 0], "25 off twice: 50 points off in total");
  assert.equal(isOutOfCharge([35, 45.1], questions, drainRateFor(true)), true);
});

test("endless mode asks unseen questions first and counts the rounds survived", () => {
  const bank = ["Alpha?", "Bravo?", "Charlie?", "Delta?"].map(text => ({ text, answer: 50 }));
  const seen = [questionKey("Bravo?"), questionKey("delta?")];
  const order = endlessOrder(bank, seen, () => 0.5);
  assert.deepEqual(new Set(order.slice(0, 2)), new Set([questionKey("Alpha?"), questionKey("Charlie?")]), "unseen first");
  assert.equal(order.length, 4, "seen ones still come, after");
  assert.equal(questionKey("Bravo?"), questionKey("BRAVO?"), "keys ignore case");
  const questions = [10, 20, 30, 40].map(answer => ({ answer }));
  assert.equal(roundsSurvived([15, 25, 30], questions, 1), 3, "still alive");
  assert.equal(roundsSurvived([60, 70, 31], questions, 1), 2, "the question that ran it out doesn't count");
});

test("hard mode and endless runs earn their own achievements", () => {
  assert.deepEqual(achievementsForGame({ charge: 60, out: false, supercharged: 1, hard: true }),
    ["first-charge", "supercharged", "devils-deal", "hard-supercharged", "hard-survivor", "hellproof"]);
  assert.deepEqual(achievementsForGame({ charge: -4, out: true, hard: true }), ["first-charge", "devils-deal", "blackout"], "running out isn't surviving");
  assert.deepEqual(streakAchievements(3, 7), ["devils-week"]);
  assert.deepEqual(endlessAchievements({ rounds: 4 }), ["first-run"]);
  assert.deepEqual(endlessAchievements({ rounds: 26, supercharged: 3, betterThan: 92 }), ["first-run", "ten-strong", "unplugged", "overclocked", "top-charger"]);
  assert.deepEqual(endlessAchievements({ rounds: 12, betterThan: 89.9 }), ["first-run", "ten-strong"]);
});

test("endless mode's clock runs from 9 PM through the night, the next day and into night 2", () => {
  assert.deepEqual(endlessClock(0), { hour: 21, time: "9:00 PM", label: "Night 1" });
  assert.equal(endlessClock(3).time, "12:00 AM");
  assert.equal(endlessClock(3).label, "Night 1", "past midnight is still the first night");
  assert.equal(endlessClock(9).time, "6:00 AM");
  assert.equal(endlessClock(9).label, "Day 1", "morning");
  assert.equal(endlessClock(15).time, "12:00 PM");
  assert.equal(endlessClock(21).time, "6:00 PM");
  assert.equal(endlessClock(21).label, "Night 2", "sunset starts the second night");
  assert.equal(endlessClock(1).time, "10:00 PM");
  assert.equal(endlessClock(34).label, "Day 2");
});

test("the moon's phase matches the U.S. Naval Observatory's 2026 phase times", async () => {
  const { moonPhase } = await import("../public/percentle/city.mjs");
  // [UTC moment, expected phase]: new 0, first quarter 0.25, full 0.5, last quarter 0.75.
  const official = [
    ["2026-09-11T03:27Z", 0], ["2026-09-18T20:44Z", 0.25], ["2026-09-26T16:49Z", 0.5], ["2026-10-03T13:25Z", 0.75],
    ["2026-10-10T15:50Z", 0], ["2026-10-18T16:12Z", 0.25], ["2026-10-26T04:12Z", 0.5], ["2026-11-01T20:28Z", 0.75],
    ["2026-11-09T07:02Z", 0], ["2026-12-24T01:28Z", 0.5]
  ];
  for (const [moment, expected] of official) {
    const phase = moonPhase(new Date(moment));
    const gap = Math.min(Math.abs(phase - expected), 1 - Math.abs(phase - expected));
    assert.ok(gap < 0.035, `${moment}: phase ${phase.toFixed(3)}, expected ${expected}`);
  }
});


test("every visitor you own flies, unless you turn it off", () => {
  const wallet = { owned: { "visitor-paper-plane": { date: "2026-11-10" }, "visitor-ufo": { date: "2026-11-10" } }, equipped: { visitors: { id: "visitor-ufo", at: 1 } } };
  assert.deepEqual(activeVisitors(wallet).map(item => item.id), ["visitor-paper-plane", "visitor-ufo"]);
  wallet.equipped["visitor-ufo"] = { id: "visitor-ufo", at: 2, off: true };
  assert.deepEqual(activeVisitors(wallet).map(item => item.id), ["visitor-paper-plane"]);
  assert.deepEqual(activeVisitors({ owned: {}, equipped: {} }), [], "the usual ones aren't market visitors");
});

test("extras are on once bought, until turned off", () => {
  const wallet = { owned: { "extra-aurora": { date: "2026-11-10", price: 1200 } }, equipped: {} };
  assert.equal(hasExtra(wallet, "aurora"), true);
  assert.equal(hasExtra(wallet, "finale"), false);
  wallet.equipped["extra-aurora"] = { id: "extra-aurora", at: 1, off: true };
  assert.equal(hasExtra(wallet, "aurora"), false);
});
