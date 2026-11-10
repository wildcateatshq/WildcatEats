"use strict";

// Keeps logged-in players honest. A browser's save is the player's own data, so anything in it
// could have been edited. Coins, Market purchases, and stats are therefore worked out here from
// what the player actually guessed, checked against the real answers, and never taken from the
// numbers a browser sends.
//
// Each account's save holds a `verified` record that browsers can't write:
//   verified.daily        { date: { score, charge, hard?, unpaid? } }  daily games re-scored from their guesses
//   verified.endless      { runId: { date, coins, base, rounds } }     endless runs re-scored against their bank
//   verified.owned        { itemId: { date, price } }          Market items, bought only through the server
//   verified.endlessStats { best, hardBest, allTime, hardAllTime, runs }
// What a save had before this was added is kept as it was (seedVerified), so nobody loses anything.
//
// Only games and runs from today or yesterday (for play that syncs after midnight) pay coins, as the
// page itself only pays for today's puzzle. Older ones, such as days played before logging in,
// still count in stats but pay nothing, so nobody can collect coins for every past puzzle.

const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { addDays, easternDate, isCalendarDate } = require("./puzzles");
const { PERIOD_DAYS, periodStart } = require("./endless");

// The game's own rules (public/percentle/game.mjs), so scores here always match the page's.
let gameModule;
const loadGame = () => (gameModule ??= import(pathToFileURL(path.join(__dirname, "..", "public", "percentle", "game.mjs")).href));

// Finished endless runs waiting to be checked, kept by the browser until the server has them. A
// run longer than this many rounds isn't believable, and a save holds at most this many waiting.
const MAX_RUN_ROUNDS = 600;
const MAX_PENDING_RUNS = 30;

// The earliest day whose games and runs still pay coins when they reach the server.
const payingFrom = today => addDays(today, -1);

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// The verified record for a save made before verification existed: everything it already had.
function seedVerified(saved) {
  const state = isObject(saved) ? saved : {};
  const wallet = isObject(state.wallet) ? state.wallet : {};
  const endless = isObject(state.endless) ? state.endless : {};
  const daily = {};
  for (const game of Array.isArray(state.games) ? state.games : []) {
    if (!isObject(game) || !isCalendarDate(game.date) || !Number.isFinite(game.score)) continue;
    daily[game.date] = { score: game.score, ...(Number.isFinite(game.charge) ? { charge: game.charge } : {}), ...(game.hard ? { hard: true } : {}) };
  }
  const runs = {};
  for (const [id, run] of Object.entries(isObject(wallet.endless) ? wallet.endless : {})) {
    if (isObject(run) && isCalendarDate(run.date) && Number.isFinite(run.coins)) runs[id] = { date: run.date, coins: Math.max(0, run.coins) };
  }
  const owned = {};
  for (const [id, bought] of Object.entries(isObject(wallet.owned) ? wallet.owned : {})) {
    if (isObject(bought)) owned[id] = { date: bought.date, ...(Number.isFinite(bought.price) ? { price: bought.price } : {}) };
  }
  const numbers = value => Object.fromEntries(Object.entries(isObject(value) ? value : {}).filter(([, best]) => Number.isFinite(best)));
  return {
    daily,
    endless: runs,
    owned,
    endlessStats: {
      best: numbers(endless.best),
      hardBest: numbers(endless.hardBest),
      allTime: finiteOr(endless.allTime, 0),
      hardAllTime: finiteOr(endless.hardAllTime, 0),
      runs: finiteOr(endless.runs, 0)
    }
  };
}

// Questions as the page plays them: a custom-scale answer becomes its position along the bar.
function asPlayed(game, questions) {
  return questions.map(question => {
    if (!question.scale) return { ...question, answer: Math.round(question.answer * 10) / 10 };
    const scale = game.scaleOf(question);
    return { ...question, answer: game.toPosition(game.roundToScale(question.answer, scale), scale) };
  });
}

// The guesses of a finished game or run, if they're believable: positions from 0 to 100, and none
// after the battery ran out. Returns the charge after each guess, or null.
function checkGuesses(game, guesses, questions, rate) {
  if (!Array.isArray(guesses) || !guesses.length || guesses.length > questions.length) return null;
  if (!guesses.every(guess => Number.isFinite(guess) && guess >= 0 && guess <= 100)) return null;
  const track = game.chargeTrack(guesses, questions, rate);
  if (track.slice(0, -1).some(charge => charge < 0)) return null;
  return track;
}

// Re-scores a daily game from its guesses. Null if it isn't finished or doesn't add up.
function scoreDaily(game, progress, questions) {
  const rate = game.drainRateFor(Boolean(progress.hard));
  const track = checkGuesses(game, progress.guesses, questions, rate);
  if (!track) return null;
  const charge = track.at(-1);
  if (progress.guesses.length < questions.length && charge >= 0) return null;
  const score = Number(game.dailyTotal(progress.guesses, questions.slice(0, progress.guesses.length)).toFixed(1));
  return { score, charge, ...(progress.hard ? { hard: true } : {}) };
}

// Re-scores a finished endless run against its period's bank: the questions it was asked (by key,
// in order) and the guesses. Null if the run doesn't add up.
async function scoreRun(game, run, { endless, today }) {
  if (!isObject(run) || !isCalendarDate(run.date) || run.date > today || !Array.isArray(run.questions)) return null;
  // A period's bank stays in use until the next one has enough questions, so a run may be on the
  // bank before the one for its date.
  const period = periodStart(run.date);
  if (run.startsOn !== period && run.startsOn !== addDays(period, -PERIOD_DAYS)) return null;
  if (run.questions.length > MAX_RUN_ROUNDS || new Set(run.questions).size !== run.questions.length) return null;
  const bank = new Map((await endless.getBank(run.startsOn)).map(question => [game.questionKey(question.text), question]));
  const asked = run.questions.map(key => bank.get(key));
  if (!asked.length || asked.some(question => !question)) return null;
  const questions = asPlayed(game, asked);
  const rate = game.drainRateFor(Boolean(run.hard));
  if (!checkGuesses(game, run.guesses, questions, rate) || run.guesses.length !== questions.length) return null;
  // A run ends when the battery runs out or the bank is used up.
  if (!game.isOutOfCharge(run.guesses, questions, rate) && questions.length < bank.size) return null;
  return { rounds: game.roundsSurvived(run.guesses, questions, rate), hard: Boolean(run.hard), startsOn: run.startsOn };
}

// What the verified record pays and has spent.
function balanceOf(game, verified) {
  const earned = Object.values(verified.daily).reduce((sum, played) => sum + (played.unpaid ? 0 : game.dailyCoins(played)), 0) +
    Object.values(verified.endless).reduce((sum, run) => sum + run.coins, 0);
  const spent = Object.values(verified.owned).reduce((sum, bought) => sum + finiteOr(bought.price, 0), 0);
  return earned - spent;
}

// Checks what's new in a merged save (finished daily games and endless runs) and returns the save
// as the account should have it: games, endless runs, bests, and owned items all from the verified
// record. `saved` is what the account had before this change (for its verified record).
async function verifyState(saved, merged, { puzzles, endless, owner = false, today = easternDate() }) {
  const game = await loadGame();
  const verified = isObject(saved?.verified) ? structuredClone(saved.verified) : seedVerified(saved);

  for (const [date, progress] of Object.entries(isObject(merged.progress) ? merged.progress : {})) {
    if (!isCalendarDate(date) || date > today || verified.daily[date] || !isObject(progress) || !progress.guesses?.length) continue;
    const questions = await puzzles.get(date);
    if (!questions) continue;
    const played = scoreDaily(game, progress, asPlayed(game, questions));
    if (played) verified.daily[date] = date >= payingFrom(today) ? played : { ...played, unpaid: true };
  }

  const pending = isObject(merged.wallet?.pending) ? Object.entries(merged.wallet.pending).slice(-MAX_PENDING_RUNS) : [];
  for (const [id, run] of pending) {
    if (verified.endless[id]) continue;
    const scored = await scoreRun(game, run, { endless, today });
    if (!scored) continue;
    // The day's limit counts base pay only; the multiplier bonus for going far is on top.
    const baseToday = game.endlessCoinsOn({ endless: verified.endless }, run.date);
    const pay = run.date >= payingFrom(today) ? game.endlessPay(scored.rounds, baseToday) : { coins: 0, base: 0 };
    verified.endless[id] = { date: run.date, coins: pay.coins, base: pay.base, rounds: scored.rounds };
    const stats = verified.endlessStats;
    const bests = scored.hard ? stats.hardBest : stats.best;
    bests[scored.startsOn] = Math.max(bests[scored.startsOn] ?? 0, scored.rounds);
    if (scored.hard) stats.hardAllTime = Math.max(stats.hardAllTime, scored.rounds);
    else stats.allTime = Math.max(stats.allTime, scored.rounds);
    stats.runs += 1;
  }

  return { ...present(game, merged, verified, owner), verified };
}

// A save as the browser sees it, built from the verified record (which itself stays on the server).
function present(game, state, verified, owner) {
  const owned = { ...verified.owned };
  // The game's owner has every item, at no cost.
  if (owner) for (const item of game.MARKET_ITEMS) if (item.price > 0 && !owned[item.id]) owned[item.id] = { date: "owner", price: 0 };
  const wallet = isObject(state.wallet) ? state.wallet : {};
  const stats = verified.endlessStats;
  return {
    ...state,
    games: Object.entries(verified.daily).sort(([a], [b]) => a.localeCompare(b)).map(([date, played]) => ({ date, ...played })),
    wallet: {
      endless: Object.fromEntries(Object.entries(verified.endless).map(([id, run]) => [id, { date: run.date, coins: run.coins, ...(Number.isFinite(run.base) ? { base: run.base } : {}) }])),
      owned,
      equipped: isObject(wallet.equipped) ? wallet.equipped : {},
      pending: {}
    },
    endless: { ...(isObject(state.endless) ? state.endless : {}), best: stats.best, hardBest: stats.hardBest, allTime: stats.allTime, hardAllTime: stats.hardAllTime, runs: stats.runs }
  };
}

// Buys a Market item with verified coins. Throws a RangeError the player can read if it can't.
async function buyItem(saved, id, { owner = false, today = easternDate(), now = Date.now() } = {}) {
  const game = await loadGame();
  const item = game.marketItem(id);
  if (!item || item.price === 0) throw new RangeError("That item isn't for sale.");
  const verified = isObject(saved?.verified) ? structuredClone(saved.verified) : seedVerified(saved);
  if (verified.owned[id] || owner) throw new RangeError("You already have that.");
  if (balanceOf(game, verified) < item.price) throw new RangeError("You don't have enough coins for that yet.");
  verified.owned[id] = { date: today, price: item.price };
  const state = isObject(saved) ? saved : {};
  const wallet = isObject(state.wallet) ? state.wallet : {};
  const withPick = { ...state, wallet: { ...wallet, equipped: { ...(isObject(wallet.equipped) ? wallet.equipped : {}), [item.category]: { id, at: now } } } };
  return { ...present(game, withPick, verified, owner), verified };
}

// The save as sent to a browser: without the verified record.
function forBrowser(state) {
  const { verified, ...rest } = state;
  return rest;
}

module.exports = { buyItem, forBrowser, seedVerified, verifyState };
