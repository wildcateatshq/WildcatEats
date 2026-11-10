import { achievementsForGame, ACHIEVEMENTS, formatValue, fromPosition, roundToScale, scaleDecimals, scaleOf, scaleStep, toPosition, endlessAchievements, applyGuessKey, bestGuessIndex, chargeLeft, chargeTrack, crowdRank, dailyTotal, DRAIN_RATE, drainRateFor, endlessOrder, questionKey, roundsSurvived, statsCharge, easternDate, endlessClock, finalCharge, guessEntryFrom, guessEntryText, isOutOfCharge, litLevel, longestStreak, lowBatteryTier, pointsOff, streakAchievements, utcDate, viewForProgress } from "/percentle/game.mjs";
import { createCity, visitorSvg } from "/percentle/city.mjs";
import { MARKET_CATEGORIES, MARKET_ITEMS, coinBalance, dailyCoins, emptyWallet, endlessCoins, endlessDay, equippedItem, marketItem, activeVisitors, hasExtra, TOGGLE_CATEGORIES } from "/percentle/game.mjs";

// The game's name everywhere players see it (title, wordmark, start screen, share text).
const GAME_NAME = "Chargle";
// What a guess within the perfect margin (no charge lost) is called, in neon on the reveal.
const NO_DRAIN_WORD = "SUPERCHARGED";
// The charge battery's colour as it drains: green while healthy, through yellow and orange, to red.
// Between two stops the colours blend smoothly.
// At or below this charge, the label above the running battery reads "Warning: low battery".
const LOW_BATTERY = 20;
const CHARGE_COLORS = [
  { at: 60, color: "var(--charge)" },
  { at: 40, color: "var(--charge-yellow)" },
  { at: 20, color: "var(--charge-orange)" },
  { at: 5, color: "var(--negative)" }
];
const PUZZLES_URL = "/api/percentle/puzzles";
const ENDLESS_URL = "/api/percentle/endless";
// Drawn icons: arrow and emoji characters show up as emoji on many phones.
const ICONS = {
  right: '<svg class="icon icon-right" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  left: '<svg class="icon icon-left" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  share: '<svg class="icon icon-share" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  devil: '<svg class="icon icon-devil" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4c.5 3 2 4.5 3.5 5.2A6.5 6.5 0 0 0 7 13c0 4 2.2 7 5 7s5-3 5-7a6.5 6.5 0 0 0-1.5-3.8C17 8.5 18.5 7 19 4c-1.6 1.6-3.4 2.4-5 2.6a5 5 0 0 0-4 0C8.4 6.4 6.6 5.6 5 4z" fill="currentColor" stroke="none"/></svg>'
};
// A drawn infinity sign: fonts' ∞ often has uneven loops.
const INFINITY_ICON = '<svg class="inf-icon" viewBox="0 0 24 12" aria-hidden="true"><path d="M12 6C10 3.2 8 2 6 2a4 4 0 0 0 0 8c2 0 4-1.2 6-4s4-4 6-4a4 4 0 0 1 0 8c-2 0-4-1.2-6-4z"/></svg>';
// v2: puzzles now come from the daily agent, so v1 progress (from the old bank) no longer matches.
const STORAGE_KEY = "percentle.v2";
const stage = document.querySelector("#questionStage");
const dialog = document.querySelector("#infoDialog");
const toast = document.querySelector("#toast");
// Local testing only: http://localhost:3000/percentle.html?reset clears saved progress and stats
// (and, logged in to the local test account, that account's save too; see loadAccount).
const LOCAL_RESET = location.hostname === "localhost" && new URLSearchParams(location.search).has("reset");
if (LOCAL_RESET) {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  // Only "reset" goes; other local testing options (?visitor=, ?weather=, ?holiday=) stay.
  const params = new URLSearchParams(location.search);
  params.delete("reset");
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
}
document.title = GAME_NAME.toUpperCase();
document.querySelectorAll("[data-game-name]").forEach(element => {
  element.textContent = element.dataset.gameName === "lower" ? GAME_NAME.toLowerCase() : GAME_NAME;
});
document.querySelector(".wordmark").setAttribute("aria-label", `${GAME_NAME} home`);

// Daily player stats for the editor: a lasting anonymous ID (separate from the crowd IDs, so it's
// never linked to a score), where the visit came from, and whether the player shared or played
// endless. Failures are ignored: stats must never get in the way of the game.
const STATS_URL = "/api/percentle/stats";
let fallbackPlayerId = null;
function playerId() {
  let id = readPreference("percentle.player");
  if (!id && crypto.randomUUID) {
    id = fallbackPlayerId ??= crypto.randomUUID();
    try { localStorage.setItem("percentle.player", id); } catch {}
  }
  return id;
}

function sendStat(path, body) {
  const id = playerId();
  if (!id) return;
  fetch(`${STATS_URL}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...body }), keepalive: true })
    .catch(() => {});
}

// Once per day per device, counted even if today's puzzle is late or fails to load. A "?ref=" tag (chargle.io/?ref=flyer) is noted and then removed from
// the address bar, so links copied from it don't carry it on.
function recordVisit(day) {
  const params = new URLSearchParams(location.search);
  const ref = params.get("ref");
  if (ref !== null) {
    params.delete("ref");
    const rest = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  }
  if (readPreference("percentle.visited") === day) return;
  let referrer = null;
  try {
    const from = new URL(document.referrer);
    if (from.hostname !== location.hostname) referrer = from.hostname;
  } catch {}
  sendStat("visit", { ref, referrer });
  try { localStorage.setItem("percentle.visited", day); } catch {}
}
recordVisit(easternDate());
// The night city behind the game (public/percentle/city.mjs). It follows the main battery.
const city = createCity(document.querySelector("#city"));
// A finish with at least this much charge left sets off fireworks over the city.
const FIREWORKS_AT = 60;
// A guess this close (but not a supercharge) sets off a single small firework.
const CLOSE_FIREWORK_WITHIN = 3;

let todayPuzzle;
try {
  const response = await fetch(`${PUZZLES_URL}/today`);
  const body = await response.json().catch(() => ({}));
  if (response.status === 404 && body.date) {
    document.querySelector("#puzzleNumber").textContent = `NO. ${body.number}`;
    stage.innerHTML = `<div class="question-body"><h2 class="question-text">Today's puzzle is on its way.</h2><p class="question-hint">New questions arrive just after midnight Eastern. This page will check again in a minute.</p></div>`;
    setTimeout(() => location.reload(), 60_000);
    throw new Error(body.error);
  }
  if (!response.ok || !Array.isArray(body.questions)) throw new Error(body.error || `Puzzle request failed (${response.status}).`);
  todayPuzzle = { ...body, questions: withRoundedAnswers(body.questions) };
} catch (error) {
  console.error("Could not load today's Percentle puzzle.", error);
  document.body.classList.remove("starting");
  if (!stage.innerHTML.trim()) {
    // data-nosnippet keeps this message out of Google's description of the site.
    stage.innerHTML = `<div data-nosnippet><p role="alert">Today's puzzle couldn't load. Check your connection and <button id="retryLoad">try again</button>.</p></div>`;
    document.querySelector("#retryLoad").addEventListener("click", () => location.reload());
  }
  throw error;
}
const today = todayPuzzle.date;
let state = readState();
// The logged-in account, if any ({ username, email }; see Accounts below).
let account = (() => {
  try {
    return JSON.parse(localStorage.getItem("percentle.account") || "null");
  } catch {
    return null;
  }
})();
let accountSyncTimer = null;
let currentDate = today;
let currentNumber = todayPuzzle.number;
// Endless mode: playing through the current two-week bank until the battery runs out.
let endlessMode = false;
let endlessBank = null;
// Whether the endless run on screen is a hard-mode run (taken from the switch when it starts).
let endlessHard = false;
// Hard mode as chosen on the start screen. Each puzzle takes it on its first guess and keeps it.
let hardPreferred = readPreference("percentle.hard") === "1";
// A special's title, like "World Series Special" (null on a normal day).
let currentTheme = todayPuzzle.theme || null;
let currentQuestions = todayPuzzle.questions;
let practiceMode = false;
let toastTimer;
// Set just before rendering a freshly locked guess, so only that reveal (not a reload) animates.
let justLocked = false;
// What the score box above the card is showing, so the next update can count up from it.
let shownScore = null;
// Set when the results screen should play its drain animation (not when it's just reloaded).
let animateResults = false;
// The revealed answer finishes fading in about this long after a guess is locked...
const ANSWER_SHOWN_MS = 1450;
// ...and the Next button fades in this long after that.
const NEXT_BUTTON_DELAY_MS = 1000;
let nextButtonTimer;
// Running out of charge: the losing guess is revealed and the battery drains to empty, then the
// whole game fades away (HIDE_GAME_MS from the reveal) so the city is in plain view when its lights
// go out (LIGHTS_OUT_MS) and it blacks out. Then the view drifts slowly up into the night sky
// (city.outOfCharge), and once it's at the top the out-of-charge screen pops up over the sky.
// POWER_OUT_DELAY_MS after the guess was locked is only a safety net, in case the blackout never
// started (say, the battery's drain was cut short).
const DRAIN_MS = 1400;
const HIDE_GAME_MS = 1500;
const LIGHTS_OUT_MS = 2400; // the game takes 1s to fade
const POWER_OUT_DELAY_MS = 16000;
const POWER_OUT_DELAY_REDUCED_MS = 4000;
let powerOutTimer;
let hideGameTimer;
// Now and then something passes over the city while a question is up: one roll with each new
// question, at a random moment, never two close together. Each visitor has its own chance and only
// comes when it fits the sky (shooting stars at night, birds at dawn and dusk in endless, the
// helicopter late at night).
const VISITORS = [
  { name: "plane", chance: 0.25, fits: () => true },
  { name: "shootingStar", chance: 0.15, fits: sky => sky.daylight < 0.3 },
  { name: "blimp", chance: 0.07, fits: () => true },
  { name: "helicopter", chance: 0.08, fits: sky => sky.hour === null || (((sky.hour % 24) + 24) % 24 < 4) },
  { name: "birds", chance: 0.45, fits: sky => sky.hour !== null && [5, 6, 7, 17, 18, 19].includes(Math.floor(((sky.hour % 24) + 24) % 24)) }
];
const VISITOR_GAP_MS = 25000;
// The player's own market visitors come on top of the usual ones, on their own roll with each
// question: about 3 questions in 10, a little more the more of them are on.
const MARKET_VISITOR_CHANCE = 0.3;
const MARKET_VISITOR_EXTRA = 0.04; // per visitor on beyond the first, up to MARKET_VISITOR_MAX
const MARKET_VISITOR_MAX = 0.5;
const MARKET_VISITOR_GAP_MS = 20000;
// Local testing only: http://localhost:3010/?clock=13 starts endless runs that many hours later
// (13 = 10 AM), to see the daytime city without playing through the night.
const CLOCK_SHIFT = location.hostname === "localhost" ? Number(new URLSearchParams(location.search).get("clock")) || 0 : 0;
// Local testing only: http://localhost:3010/?visitor=blimp sends that visitor with every question.
const FORCED_VISITOR = location.hostname === "localhost" ? new URLSearchParams(location.search).get("visitor") : null;
let lastVisitorAt = -VISITOR_GAP_MS;
let lastMarketVisitorAt = -MARKET_VISITOR_GAP_MS;
let visitorTimer, marketVisitorTimer;

// When a visitor crosses: between the bottom of the moon and the top of the question's button.
function flyAfter(delay, fly) {
  return setTimeout(() => {
    const moon = document.querySelector("#city .moon")?.getBoundingClientRect();
    const button = document.querySelector("#questionAction")?.getBoundingClientRect();
    if (!moon || !button || document.body.classList.contains("starting")) return;
    const top = Math.max(16, moon.bottom + 16), bottom = button.top - 30;
    fly(bottom > top ? top + Math.random() * (bottom - top) : top);
  }, delay);
}

function maybeFlyPlane() {
  clearTimeout(visitorTimer);
  clearTimeout(marketVisitorTimer);
  if (document.body.classList.contains("starting")) return;
  maybeFlyMarketVisitor();
  const sky = city.state();
  let visitor = FORCED_VISITOR && !marketItem(`visitor-${FORCED_VISITOR}`) ? FORCED_VISITOR : null;
  if (!visitor) {
    if (FORCED_VISITOR || Date.now() - lastVisitorAt < VISITOR_GAP_MS) return;
    let roll = Math.random();
    visitor = VISITORS.filter(v => v.fits(sky)).find(v => (roll -= v.chance) < 0)?.name;
    if (!visitor) return;
  }
  // Planes, birds and shooting stars cross the sky; the blimp and helicopter stay low over the rooftops.
  visitorTimer = flyAfter(FORCED_VISITOR ? 1200 : 1500 + Math.random() * 6000, y => {
    lastVisitorAt = Date.now();
    if (visitor === "plane") city.plane(y);
    else if (visitor === "shootingStar") city.shootingStar(Math.max(20, y - 60));
    else if (visitor === "birds") city.birds(y);
    else city[visitor]?.();
  });
}

// The player's own visitors (Market), on their own roll: one of those that are on.
function maybeFlyMarketVisitor() {
  let kind = FORCED_VISITOR && marketItem(`visitor-${FORCED_VISITOR}`) ? FORCED_VISITOR : null;
  if (!kind) {
    const mine = activeVisitors(state.wallet);
    if (!mine.length || Date.now() - lastMarketVisitorAt < MARKET_VISITOR_GAP_MS) return;
    const chance = Math.min(MARKET_VISITOR_MAX, MARKET_VISITOR_CHANCE + MARKET_VISITOR_EXTRA * (mine.length - 1));
    if (Math.random() >= chance) return;
    kind = mine[Math.floor(Math.random() * mine.length)].id.replace("visitor-", "");
  }
  marketVisitorTimer = flyAfter(FORCED_VISITOR ? 1200 : 2500 + Math.random() * 7000, y => {
    lastMarketVisitorAt = Date.now();
    city.marketVisitor(kind, y);
  });
}

// The billboard on a rooftop: the player's streak once it's going, otherwise the game's name and
// today's puzzle (or the best endless run).
// The billboard stays clear of the question card. While answering, it also leaves room for a short
// fun fact under the bar; once the answer is shown it only moves if the real fun fact covers it.
let billboardClearOf = null;
function keepBillboardClear() {
  requestAnimationFrame(() => {
    const card = document.querySelector("#gameCard")?.getBoundingClientRect();
    const labels = document.querySelector(".range-labels")?.getBoundingClientRect();
    if (!card || !labels || !card.height) return; // not measurable behind the start screen
    const fact = document.querySelector(".source-note")?.getBoundingClientRect();
    const bottom = fact ? fact.bottom : Math.max(card.bottom, labels.bottom + 60);
    if (fact && billboardClearOf && fact.bottom <= billboardClearOf) return; // the room left was enough
    billboardClearOf = bottom;
    city.avoidForBillboard([{ left: card.left, right: card.right, top: card.top, bottom }]);
  });
}
window.addEventListener("resize", () => { if (document.querySelector("#guessInput")) keepBillboardClear(); });

function updateBillboard() {
  const streak = consecutiveStreak(state.games);
  const top = streak >= 2 ? `${streak} DAY STREAK` : "CHARGLE";
  const bottom = endlessMode ? `BEST ${Math.max(state.endless.allTime, state.endless.hardAllTime || 0)}` : `NO. ${currentNumber}`;
  city.setBillboard([top, bottom]);
}

// Holidays on the city: Halloween (Oct 27-31), lights all December, fireworks on New Year's
// (Dec 31-Jan 1) and the Fourth of July (Jul 3-5). By the Eastern date, like the puzzles.
function holidayOn(date) {
  const md = date.slice(5);
  if (md >= "10-27" && md <= "10-31") return "halloween";
  if (md === "12-31" || md === "01-01") return "newyear";
  if (md >= "12-01" && md <= "12-30") return "december";
  if (md >= "07-03" && md <= "07-05") return "july4";
  return null;
}

// Weather on the city: today's real forecast for Villanova (percentle/sky.js); clear if it can't load.
let weatherNow = null;
let weatherHigh = null; // today's high in Villanova (°F), when the forecast loaded
async function loadWeather() {
  // Local testing only: ?weather=rain, snow, fog or clear.
  const forced = location.hostname === "localhost" ? new URLSearchParams(location.search).get("weather") : null;
  if (forced) return forced === "clear" ? null : forced;
  try {
    const response = await fetch("/api/percentle/weather");
    if (!response.ok) return null;
    const { weather, high } = await response.json();
    weatherHigh = Number.isFinite(high) ? high : null;
    return ["rain", "snow", "fog"].includes(weather) ? weather : null;
  } catch {
    return null;
  }
}

// Snow on the roofs: settled whenever it's snowing; in endless runs from December to February it
// also falls and piles up round by round, on days cold enough for snow.
function updateSnow(round = 0) {
  const month = Number(easternDate().slice(5, 7));
  const winter = month === 12 || month <= 2;
  if (weatherNow === "snow") city.setSnow(1, true);
  else if (endlessMode && winter && weatherHigh !== null && weatherHigh <= 40) city.setSnow(Math.min(1, round / 12), true);
  else city.setSnow(0, false);
}

// Local testing only: ?holiday=december (or halloween, newyear, july4, none).
const forcedHoliday = location.hostname === "localhost" ? new URLSearchParams(location.search).get("holiday") : null;
city.setHoliday(forcedHoliday ? (forcedHoliday === "none" ? null : forcedHoliday) : holidayOn(easternDate()));
loadWeather().then(kind => { weatherNow = kind; city.setWeather(kind); updateSnow(endlessMode ? progressFor().guesses.length : 0); });

// Answers always have exactly one decimal place, even if a puzzle was stored with more.
// Answers rounded the way they're shown. A question with its own scale (game.mjs scaleOf) is
// played by position along its bar: its answer becomes a position from 0 to 100, and the real
// answer is kept as realAnswer for showing.
function withRoundedAnswers(questions) {
  return questions.map(question => {
    if (!question.scale) return { ...question, answer: Math.round(question.answer * 10) / 10 };
    const realAnswer = roundToScale(question.answer, scaleOf(question));
    return { ...question, realAnswer, answer: toPosition(realAnswer, scaleOf(question)) };
  });
}

// A guess (a position along the bar) or a question's answer in the question's own units.
const guessValue = (question, position) => fromPosition(position, scaleOf(question));
const answerValue = question => question.realAnswer ?? question.answer;

// A value as big digits with a small unit, for the guess and answer numbers on the reveal.
function valueHtml(question, value) {
  const scale = scaleOf(question);
  const unit = scale.unit || "";
  const word = /^\p{L}/u.test(unit) ? ' class="word"' : "";
  return `${scale.prefix ? `<small class="prefix">${escapeHtml(scale.prefix)}</small>` : ""}${formatValue(value, scale, { withUnit: false })}${unit ? `<small${word}>${escapeHtml(unit)}</small>` : ""}`;
}

// How far a guess was from the answer, in the question's units: "12.4% off", "$12,000 off",
// "2.5 points off". A unit like "/10" is left off ("1.25 off").
function distanceText(question, guess) {
  const scale = scaleOf(question);
  const distance = roundToScale(Math.abs(guessValue(question, guess) - answerValue(question)), scale);
  const keepUnit = scale.unit === "%" || /^\p{L}/u.test(scale.unit || "");
  return formatValue(distance, keepUnit ? scale : { ...scale, unit: "" });
}

// A scale's number kept short: no trailing zeros ("36", "7.5"), and thousands as K or millions as M
// on big scales ("$90K").
function shortNumber(value, scale) {
  if (scale.max >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  if (scale.max >= 10_000) return `${Number((value / 1000).toFixed(1))}K`;
  return String(Number(value.toFixed(scaleDecimals(scale))));
}

// The range under the question: "0-100%", "$40,000–$140,000", "1–36 points", "5–10 (out of 10)".
function scaleHint(question) {
  if (!question?.scale) return "0-100%";
  const scale = scaleOf(question);
  const unit = scale.unit || "";
  const phrase = unit.startsWith("/") ? ` (out of ${unit.slice(1)})` : /^\p{L}/u.test(unit) ? ` ${unit}` : unit;
  const number = value => `${scale.prefix || ""}${formatValue(value, scale, { withUnit: false }).replace(/\.0+$/, "")}`;
  return `${number(scale.min)}–${number(scale.max)}${phrase}`;
}

// The labels under a question's bar, kept short so they don't run into the markers: its min,
// middle and max ("0% 50% 100%", "$40K $90K $140K", "1 18.5 36"). The hint above gives the unit.
function rangeLabels(question) {
  const scale = scaleOf(question);
  const label = position => `${scale.prefix || ""}${shortNumber(fromPosition(position, scale), scale)}${scale.unit === "%" ? "%" : ""}`;
  return `<div class="range-labels">${[0, 50, 100].map(position => `<span>${escapeHtml(label(position))}</span>`).join("")}</div>`;
}

function readState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch (error) {
    console.error("Could not read Percentle save data.", error);
    return { games: [], progress: {}, achievements: {}, endless: { best: {}, allTime: 0, runs: 0, hardBest: {}, hardAllTime: 0 } };
  }
}

// Fills in anything a save is missing (an older save, or one merged with an account's).
function normalizeState(stored) {
  if (!Array.isArray(stored.games)) stored.games = [];
  if (!stored.progress || typeof stored.progress !== "object") stored.progress = {};
  if (!stored.achievements || typeof stored.achievements !== "object") stored.achievements = {};
  if (!stored.endless || typeof stored.endless !== "object") stored.endless = { best: {}, allTime: 0, runs: 0 };
  stored.endless.best ??= {};
  if (!stored.wallet || typeof stored.wallet !== "object") stored.wallet = emptyWallet();
  for (const key of ["endless", "owned", "equipped", "pending"]) if (!stored.wallet[key] || typeof stored.wallet[key] !== "object") stored.wallet[key] = {};
  stored.endless.hardBest ??= {};
  stored.endless.hardAllTime ??= 0;
  for (const progress of Object.values(stored.progress)) {
    if (!Array.isArray(progress.guesses)) progress.guesses = [];
    if (!Array.isArray(progress.locked)) progress.locked = [];
    if (!Number.isInteger(progress.revealed)) progress.revealed = Math.max(0, progress.guesses.length - 1);
    if (progress.draft === undefined) progress.draft = null;
  }
  return stored;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    showToast("Your browser couldn't save this game.");
    console.error("Could not save Percentle progress.", error);
  }
  if (account) scheduleAccountSync();
}

// ---------- Accounts ----------
// Logging in (email, username, password) keeps a player's stats on every device: the browser keeps
// its save as always, and while logged in also sends it to the account (a moment after each change),
// where it's merged with what the account has from other devices. An endless run that's under way
// stays on its own device (its question order is large); its bests and run counts are shared.
const ACCOUNTS_URL = "/api/percentle/accounts";
// Who's logged in, remembered so the page knows before asking the server. The session itself is
// a cookie the page can't read.
const ACCOUNT_KEY = "percentle.account"; // also read where `account` is declared, at the top
const ACCOUNT_SYNC_DELAY_MS = 1500;
// Finished endless runs kept for the server to check (as many as it will look at).
const MAX_PENDING_RUNS = 30;

const isEndlessKey = key => key.startsWith("endless");

function rememberAccount(next) {
  account = next;
  try {
    if (next) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(next));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // Without storage the page just asks the server again next time.
  }
  // Log in until the player is logged in; then the market instead. Never both.
  document.querySelector("#loginButton").hidden = Boolean(next);
  document.querySelector("#marketButton").hidden = !next;
  // Logging in from the results swaps the note for the coin total.
  const nudge = document.querySelector("#loginNudge");
  if (nudge && next) nudge.outerHTML = coinTotalMarkup(0);
}

// Takes the account's checked numbers from the server (percentle/verify.js): its games, endless
// runs, and owned items. Games and runs the server hasn't seen yet (still on their way) stay, so
// nothing flickers; the server never counts them until it has checked them.
function takeVerified(verified) {
  const games = new Map(state.games.map(game => [game.date, game]));
  for (const game of verified.games || []) games.set(game.date, game);
  state.games = [...games.values()].sort((a, b) => a.date.localeCompare(b.date));
  const checked = verified.wallet?.endless || {};
  state.wallet.endless = { ...Object.fromEntries(Object.entries(state.wallet.endless).filter(([id]) => state.wallet.pending[id])), ...checked };
  for (const id of Object.keys(checked)) delete state.wallet.pending[id];
  state.wallet.owned = verified.wallet?.owned || {};
  if (verified.endless) Object.assign(state.endless, verified.endless);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function scheduleAccountSync() {
  clearTimeout(accountSyncTimer);
  accountSyncTimer = setTimeout(() => syncAccount(), ACCOUNT_SYNC_DELAY_MS);
}

// Sends this browser's save to the account and returns the merged save (null if it couldn't).
// `apply` replaces this browser's save with the merged one, as on logging in or opening the page.
async function syncAccount({ apply = false, keepalive = false } = {}) {
  clearTimeout(accountSyncTimer);
  accountSyncTimer = null;
  const outgoing = { ...state, progress: Object.fromEntries(Object.entries(state.progress).filter(([key]) => !isEndlessKey(key))) };
  try {
    const response = await fetch(`${ACCOUNTS_URL}/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: outgoing }),
      keepalive
    });
    if (response.status === 401) {
      rememberAccount(null);
      return null;
    }
    if (!response.ok) throw new Error(`Account sync failed (${response.status}).`);
    const body = await response.json();
    if (apply) {
      const endlessRuns = Object.fromEntries(Object.entries(state.progress).filter(([key]) => isEndlessKey(key)));
      state = normalizeState({ ...body.state, progress: { ...body.state.progress, ...endlessRuns } });
      applyCosmetics();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (error) {
        console.error("Could not save Percentle progress.", error);
      }
    } else takeVerified(body.state);
    return body.state;
  } catch (error) {
    console.error("Could not sync with the Chargle account.", error);
    return null;
  }
}

// On opening the page: if this browser is logged in, bring in what the account has from other
// devices (and redraw while the start screen is still up, where nothing is mid-animation).
async function loadAccount() {
  try {
    const response = await fetch(`${ACCOUNTS_URL}/me`);
    if (!response.ok) throw new Error(`Account check failed (${response.status}).`);
    rememberAccount((await response.json()).account);
    // Local testing on a server started with CHARGLE_DEV=1: log in to the local test account, and
    // let ?reset start it over too.
    if (location.hostname === "localhost") {
      if (!account) {
        const login = await fetch(`${ACCOUNTS_URL}/dev-login`, { method: "POST" });
        if (login.ok) rememberAccount((await login.json()).account);
      }
      if (account && LOCAL_RESET) await fetch(`${ACCOUNTS_URL}/dev-reset`, { method: "POST" });
    }
    if (!account) return;
  } catch {
    // Offline: carry on with this browser's save; it syncs on the next change.
    rememberAccount(account);
    return;
  }
  if (await syncAccount({ apply: true }) && document.body.classList.contains("starting")) {
    render();
    // Players already logged in see a changed privacy note once, on the start screen.
    if (!dialog.open) showPrivacyOnce();
  }
}

function showLogin(mode = "login") {
  const signup = mode === "signup";
  openDialog(signup ? "Create an account" : "Log in", `<div class="account-tabs" role="tablist">
      <button type="button" role="tab" data-mode="login" aria-selected="${!signup}">Log in</button>
      <button type="button" role="tab" data-mode="signup" aria-selected="${signup}">Create account</button></div>
    <form class="account-form" id="accountForm" novalidate>
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      ${signup ? `<label>Username<input name="username" autocomplete="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" required></label>` : ""}
      <label>Password<input type="password" name="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="${signup ? 8 : 1}" required></label>
      ${signup ? `<label class="account-agree"><input type="checkbox" name="agreed" required> <span>I'm 13 or older and agree to the <button type="button" class="link-button" id="termsLink">Terms</button> and <button type="button" class="link-button" id="privacyAgreeLink">Privacy note</button>.</span></label>` : ""}
      <p class="account-error" role="alert"></p>
      <button class="share-button" type="submit">${signup ? "Create account" : "Log in"}</button>
      ${signup ? "" : `<button type="button" class="link-button account-forgot" id="forgotButton">Forgot password?</button>`}
      <p class="account-note">${signup ? "Usernames are 3 to 20 letters, numbers, or underscores. Passwords need at least 8 characters. " : ""}Your stats and daily games follow you to any device you log in on. <button type="button" class="link-button" id="privacyLink">Privacy</button> · <button type="button" class="link-button" id="termsNoteLink">Terms</button></p>
    </form>`);
  dialog.querySelectorAll("[data-mode]").forEach(tab => tab.addEventListener("click", () => showLogin(tab.dataset.mode)));
  dialog.querySelector("#forgotButton")?.addEventListener("click", () => showForgot(dialog.querySelector('input[name="email"]').value));
  // The Terms and Privacy links come back to this form (the fields start over).
  const back = () => showLogin(mode);
  for (const id of ["#privacyLink", "#privacyAgreeLink"]) dialog.querySelector(id)?.addEventListener("click", () => showPrivacy({ back }));
  for (const id of ["#termsLink", "#termsNoteLink"]) dialog.querySelector(id)?.addEventListener("click", () => showTerms({ back }));
  const form = dialog.querySelector("#accountForm");
  form.querySelector("input").focus();
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const error = form.querySelector(".account-error");
    const button = form.querySelector("button[type=submit]");
    const fields = Object.fromEntries(new FormData(form));
    if (signup) {
      fields.agreed = form.elements.agreed.checked;
      if (!fields.agreed) {
        error.textContent = "Please confirm you're 13 or older and agree to the Terms.";
        return;
      }
    }
    button.disabled = true;
    error.textContent = "";
    try {
      const response = await fetch(`${ACCOUNTS_URL}/${signup ? "signup" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "That didn't work. Try again.");
      rememberAccount(body.account);
      await syncAccount({ apply: true });
      dialog.close();
      render();
      showToast(signup ? `Welcome, ${body.account.username}! Your stats are saved to your account.` : `Logged in as ${body.account.username}.`);
      showPrivacyOnce();
    } catch (problem) {
      error.textContent = problem.message === "Failed to fetch" ? "Couldn't reach Chargle. Check your connection and try again." : problem.message;
      button.disabled = false;
    }
  });
}

async function logOut() {
  if (accountSyncTimer) await syncAccount();
  await fetch(`${ACCOUNTS_URL}/logout`, { method: "POST" }).catch(() => {});
  rememberAccount(null);
  dialog.close();
  showToast("Logged out. Your stats stay on this device too.");
}

// What Chargle keeps and why. Shown once to everyone who logs in or creates an account (the
// "seen" mark is saved with their stats, so it's once across all their devices), and from the
// Privacy links in the log-in box and the stats dialog.
// Kept in step with what the game actually collects and who it goes to: if a new service or a new
// kind of data is added, say so here.
const PRIVACY_HTML = `<ul class="rules">
    <li><strong>What we collect.</strong> If you create an account, Chargle keeps your <strong>email</strong>, your <strong>username</strong>, and your <strong>game data</strong>: your guesses, scores, achievements, coins, and Market items. Your password is stored scrambled, so no one can read it, including us.</li>
    <li><strong>Without an account</strong>, your stats stay in your browser. Chargle still collects some usage data: a random ID for your device (not linked to your name), your daily visits, which site or link brought you here, and your finished games' results, which are used for the "how you stack up" comparisons and to see how the game is doing.</li>
    <li><strong>How your email is used.</strong> Only to log you in and to send a password reset link when you ask for one. No newsletters, no ads, and your data is never sold.</li>
    <li><strong>AI.</strong> Chargle's questions are written and fact-checked by an AI (Anthropic's Claude), with a person reviewing them. The AI never sees your account or your game data.</li>
    <li><strong>Other companies involved.</strong> Render hosts the site and its database, where the data above is stored, and keeps standard server logs such as IP addresses. An email delivery service sends password reset emails, so it receives your email address when you ask for one. There are no ad or tracking networks.</li>
    <li><strong>Deleting your data.</strong> Delete your account any time from <strong>Your stats → Delete account</strong>. That removes your email, username, and saved game data from Chargle's server. Usage counts that were never linked to you stay.</li>
    <li><strong>Questions?</strong> Email <a href="mailto:playchargle@gmail.com">playchargle@gmail.com</a> about your data or this note.</li>
  </ul>`;

// The rules for using Chargle. Linked from the log-in box (where signing up means agreeing to
// them) and the stats dialog.
const TERMS_HTML = `<ul class="rules">
    <li><strong>Who can play.</strong> Anyone can play. To create an account you must be <strong>13 or older</strong>.</li>
    <li><strong>As is.</strong> Chargle is a free game provided as is, with no promise that it will always be available, error-free, or unchanged. As far as the law allows, Chargle isn't responsible for any loss or damage from using it.</li>
    <li><strong>The questions.</strong> Questions are written by an AI and checked against the sources named with them, but they can still contain mistakes. They're for fun, not advice.</li>
    <li><strong>Coins and the Market.</strong> Coins and Market items are only part of the game: they have no cash value and can't be bought, sold, or transferred. They may change or be reset if the game changes.</li>
    <li><strong>Play fair.</strong> Don't cheat, use scripts or bots, interfere with the site, or pick an offensive username. Accounts that do may be removed.</li>
    <li><strong>Changes.</strong> These terms may be updated; playing after an update means you accept it. Questions: <a href="mailto:playchargle@gmail.com">playchargle@gmail.com</a>.</li>
  </ul>`;

function showTerms({ back = null } = {}) {
  openDialog("Terms of use", `${TERMS_HTML}<button class="share-button" id="termsDone">${back ? "Back" : "Got it"}</button>`);
  dialog.querySelector("#termsDone").addEventListener("click", () => (back ? back() : dialog.close()));
}

function showPrivacy({ back = null, onDone = null } = {}) {
  openDialog("Your privacy", `${PRIVACY_HTML}<button class="share-button" id="privacyDone">${back ? "Back" : "Got it"}</button>`);
  dialog.querySelector("#privacyDone").addEventListener("click", () => {
    if (back) back();
    else dialog.close();
    onDone?.();
  });
}

// When the privacy note last changed: anyone who saw an older version is shown it once more.
const PRIVACY_UPDATED = "2026-11-09";

function showPrivacyOnce() {
  if (state.privacyNoticeSeen >= PRIVACY_UPDATED) return;
  showPrivacy({ onDone: () => {
    state.privacyNoticeSeen = easternDate();
    save();
  } });
}

// Forgot password: asks for the email and sends a one-time reset link to it.
function showForgot(email = "") {
  openDialog("Reset your password", `<form class="account-form" id="forgotForm" novalidate>
      <p class="account-note">Enter your account's email and we'll send you a link to choose a new password.</p>
      <label>Email<input type="email" name="email" autocomplete="email" required value="${escapeAttr(email)}"></label>
      <p class="account-error" role="alert"></p>
      <button class="share-button" type="submit">Send reset link</button>
      <button type="button" class="link-button account-forgot" id="backToLogin">Back to log in</button>
    </form>`);
  dialog.querySelector("#backToLogin").addEventListener("click", () => showLogin());
  const form = dialog.querySelector("#forgotForm");
  form.querySelector("input").focus();
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const error = form.querySelector(".account-error");
    const button = form.querySelector("button[type=submit]");
    const email = form.email.value.trim();
    button.disabled = true;
    error.textContent = "";
    try {
      const response = await fetch(`${ACCOUNTS_URL}/forgot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "That didn't work. Try again.");
      form.innerHTML = `<p class="account-note">If <strong>${escapeHtml(email)}</strong> has a Chargle account, a reset link is on its way. It works once, for the next hour. Check your spam folder if it doesn't show up in a few minutes.</p>
        <button type="button" class="share-button" id="forgotDone">Done</button>`;
      form.querySelector("#forgotDone").addEventListener("click", () => dialog.close());
    } catch (problem) {
      error.textContent = problem.message === "Failed to fetch" ? "Couldn't reach Chargle. Check your connection and try again." : problem.message;
      button.disabled = false;
    }
  });
}

// Opened from a reset email's link (?password-token=...): choose a new password, then log in.
function showResetPassword(token) {
  openDialog("Choose a new password", `<form class="account-form" id="resetForm" novalidate>
      <label>New password<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
      <p class="account-note">At least 8 characters. Saving it logs your account out on your other devices.</p>
      <p class="account-error" role="alert"></p>
      <button class="share-button" type="submit">Save password</button>
    </form>`);
  const form = dialog.querySelector("#resetForm");
  form.querySelector("input").focus();
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const error = form.querySelector(".account-error");
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    error.textContent = "";
    try {
      const response = await fetch(`${ACCOUNTS_URL}/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: form.password.value })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "That didn't work. Try again.");
      rememberAccount(body.account);
      await syncAccount({ apply: true });
      dialog.close();
      render();
      showToast(`Password changed. You're logged in as ${body.account.username}.`);
      showPrivacyOnce();
    } catch (problem) {
      error.textContent = problem.message === "Failed to fetch" ? "Couldn't reach Chargle. Check your connection and try again." : problem.message;
      button.disabled = false;
    }
  });
}

// Deleting the account (after the password is confirmed). The stats stay in this browser.
function showDeleteAccount() {
  openDialog("Delete your account?", `<form class="account-form" id="deleteForm" novalidate>
      <p class="account-note">This removes your email, username, and saved stats from Chargle's server, for good. Your stats stay on this device.</p>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      <p class="account-error" role="alert"></p>
      <button class="share-button danger-button" type="submit">Delete my account</button>
      <button type="button" class="link-button account-forgot" id="keepAccount">Keep my account</button>
    </form>`);
  dialog.querySelector("#keepAccount").addEventListener("click", showStats);
  const form = dialog.querySelector("#deleteForm");
  form.querySelector("input").focus();
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const error = form.querySelector(".account-error");
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    error.textContent = "";
    try {
      const response = await fetch(`${ACCOUNTS_URL}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: form.password.value })
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "That didn't work. Try again.");
      clearTimeout(accountSyncTimer);
      accountSyncTimer = null;
      rememberAccount(null);
      delete state.privacyNoticeSeen;
      save();
      dialog.close();
      showToast("Your account is deleted.");
    } catch (problem) {
      error.textContent = problem.message === "Failed to fetch" ? "Couldn't reach Chargle. Check your connection and try again." : problem.message;
      button.disabled = false;
    }
  });
}

// ---------- Market ----------
// Looks bought with coins (game.mjs MARKET_ITEMS), for logged-in players: the Market button sits
// where Log in was. A category's tabs sit at the top; buying an item puts it to use straight away.
function applyCosmetics() {
  const pick = category => equippedItem(state.wallet, category).id.split("-").slice(1).join("-");
  const color = pick("colors"), lightning = pick("lightning");
  if (color === "gold") delete document.body.dataset.color;
  else document.body.dataset.color = color;
  if (lightning === "gold") delete document.body.dataset.lightning;
  else document.body.dataset.lightning = lightning;
  city.setAurora(hasExtra(state.wallet, "aurora"));
}

function marketPreview(item) {
  if (item.category === "visitors") {
    const kind = item.id.replace("visitor-", "");
    return kind === "none" ? '<span class="market-none">Planes, birds and blimps as usual</span>' : visitorSvg(kind, 2);
  }
  if (item.category === "extras") return visitorSvg(item.id.replace("extra-", ""), 2);
  if (item.category === "lightning") return `<span class="market-bolt" style="background:${item.swatch}"></span>`;
  return `<span class="market-swatch" style="background:${item.swatch};color:${item.swatch}"></span>`;
}

function showMarket(category = MARKET_CATEGORIES[0].id) {
  const { balance } = coinBalance(state);
  const wallet = state.wallet;
  // Visitors and extras are each on or off (the usual visitors always come); colors and lightning
  // are one at a time.
  const toggles = TOGGLE_CATEGORIES.includes(category);
  const inUse = toggles ? null : equippedItem(wallet, category);
  const about = MARKET_CATEGORIES.find(group => group.id === category);
  const cards = MARKET_ITEMS.filter(item => item.category === category).map(item => {
    const owned = item.price === 0 || Boolean(wallet.owned[item.id]);
    const on = toggles && (item.price === 0 || (owned && !wallet.equipped[item.id]?.off));
    const using = toggles ? on : inUse.id === item.id;
    const button = toggles && item.price === 0 ? '<button type="button" disabled>Always on</button>'
      : toggles && owned ? `<button type="button" class="${on ? "toggle-on" : ""}" data-toggle="${item.id}" aria-pressed="${on}">${on ? "On" : "Off"}</button>`
      : using ? '<button type="button" disabled>In use</button>'
      : owned ? `<button type="button" data-use="${item.id}">Use</button>`
      : item.price <= balance ? `<button type="button" class="buy" data-buy="${item.id}">Buy · ${item.price}</button>`
      : `<button type="button" disabled>${item.price} coins</button>`;
    return `<article class="market-item${using ? " equipped" : ""}"><div class="market-preview">${marketPreview(item)}</div>
        <span class="market-name">${escapeHtml(item.name)}</span>${button}</article>`;
  }).join("");
  openDialog("Market", `<p class="market-balance"><span class="coin" aria-hidden="true"></span>${balance} coins</p>
    <p class="account-note">Earn coins by playing: a daily puzzle pays the charge you finish with (60% pays 60), and an endless run pays more the farther you get: 10 rounds pay 40, 20 pay 100, 30 pay 180. Endless pays up to 150 a day, or your best run that day if it pays more.</p>
    <div class="market-tabs" role="tablist">${MARKET_CATEGORIES.map(group => `<button type="button" role="tab" data-tab="${group.id}" aria-selected="${group.id === category}">${group.name}</button>`).join("")}</div>
    <p class="market-blurb">${escapeHtml(about.blurb)}</p>
    <div class="market-grid">${cards}</div>`);
  dialog.querySelectorAll("[data-tab]").forEach(tab => tab.addEventListener("click", () => showMarket(tab.dataset.tab)));
  const use = id => {
    wallet.equipped[marketItem(id).category] = { id, at: Date.now() };
    applyCosmetics();
    save();
  };
  dialog.querySelectorAll("[data-use]").forEach(button => button.addEventListener("click", () => {
    use(button.dataset.use);
    showMarket(category);
  }));
  dialog.querySelectorAll("[data-toggle]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.toggle;
    wallet.equipped[id] = { id, at: Date.now(), off: !wallet.equipped[id]?.off };
    applyCosmetics();
    save();
    showMarket(category);
  }));
  // Purchases go through the server, which pays for them from the account's checked coins.
  dialog.querySelectorAll("[data-buy]").forEach(button => button.addEventListener("click", async () => {
    const item = marketItem(button.dataset.buy);
    if (!item || coinBalance(state).balance < item.price) return;
    button.disabled = true;
    try {
      await syncAccount();
      const response = await fetch(`${ACCOUNTS_URL}/buy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id })
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) rememberAccount(null);
      if (!response.ok) throw new Error(body.error || "That didn't go through. Try again.");
      takeVerified(body.state);
      state.wallet.equipped = body.state.wallet?.equipped || state.wallet.equipped;
      applyCosmetics();
      save();
      showToast(`${item.name} is yours!`);
    } catch (error) {
      showToast(error.message === "Failed to fetch" ? "Couldn't reach Chargle. Check your connection and try again." : error.message);
    }
    if (dialog.open && account) showMarket(category);
    refreshCoinTotal();
  }));
}

// The coin total for the corner of the results: what it was before this game, counting up to now.
// Without an account there are no coins: a note instead, swaying gently, with an arrow aimed at the
// Log in button.
function coinTotalMarkup(earned) {
  if (!account) {
    requestAnimationFrame(aimLoginNudge);
    return `<button type="button" class="login-nudge" id="loginNudge"><svg class="nudge-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h15M12 5l7 7-7 7"/></svg><span>Log in to unlock the market with cool cosmetics!</span></button>`;
  }
  const { balance } = coinBalance(state);
  return `<button type="button" class="coin-total" id="coinTotal" data-from="${balance - earned}" data-to="${balance}" aria-label="${balance} coins${earned ? `, ${earned} from this game` : ""}">
      <span class="coin" aria-hidden="true"></span><span class="coin-count">${balance}</span>${earned ? `<small>+${earned}</small>` : ""}</button>`;
}

// Points the note's arrow at the Log in button, wherever the two are on screen.
function aimLoginNudge() {
  const arrow = document.querySelector("#loginNudge .nudge-arrow");
  const login = document.querySelector("#loginButton");
  if (!arrow || !login || login.hidden) return;
  const from = arrow.getBoundingClientRect(), to = login.getBoundingClientRect();
  const angle = Math.atan2(to.top + to.height / 2 - (from.top + from.height / 2), to.left + to.width / 2 - (from.left + from.width / 2));
  arrow.style.setProperty("--aim", `${angle.toFixed(3)}rad`);
}
window.addEventListener("resize", aimLoginNudge);
window.addEventListener("scroll", aimLoginNudge, { passive: true });
document.addEventListener("click", event => { if (event.target.closest("#loginNudge")) showLogin(); });

// After a purchase, the results' coin total drops to the new balance.
function refreshCoinTotal() {
  const total = document.querySelector("#coinTotal");
  if (!total) return;
  const { balance } = coinBalance(state);
  total.dataset.to = balance;
  total.querySelector(".coin-count").textContent = balance;
  total.setAttribute("aria-label", `${balance} coins`);
  total.querySelector("small")?.remove();
}

function countUpCoins(animate) {
  const total = document.querySelector("#coinTotal");
  if (!total) return;
  total.addEventListener("click", () => (account ? showMarket() : showLogin()));
  const from = Number(total.dataset.from), to = Number(total.dataset.to);
  const count = total.querySelector(".coin-count");
  if (!animate || from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  count.textContent = from;
  setTimeout(() => {
    total.classList.add("counting");
    const start = performance.now(), duration = Math.min(1600, 500 + (to - from) * 6);
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      count.textContent = Math.round(from + (to - from) * (1 - (1 - t) ** 3));
      if (t < 1) requestAnimationFrame(step);
      else total.classList.remove("counting");
    };
    requestAnimationFrame(step);
  }, 700);
}

// The account line at the top of the stats dialog: who's logged in, or an invitation to.
function accountLine() {
  return account
    ? `<div class="account-line"><p>Logged in as <strong>${escapeHtml(account.username)}</strong></p>
        <p class="account-links"><button type="button" class="link-button" id="logoutButton">Log out</button><button type="button" class="link-button" id="privacyStatsLink">Privacy</button><button type="button" class="link-button" id="termsStatsLink">Terms</button><button type="button" class="link-button danger-link" id="deleteAccountButton">Delete account</button></p></div>`
    : `<p class="account-line">Keep your stats on every device: <button type="button" class="link-button" id="statsLoginButton">Log in or create an account</button></p>`;
}

// The scoring rule in words, kept in step with the drain rate (hard mode's is double).
function drainRule(rate = DRAIN_RATE) {
  const amount = rate === 1 ? "" : rate === 2 ? "twice " : rate === 0.5 ? "half of " : `${rate}× `;
  return `Every miss drains your battery by ${amount}how far off you were. <strong>Finish with as much charge as you can.</strong>`;
}

function formatCharge(charge) {
  return `${charge < 0 ? "−" : ""}${Math.abs(charge).toFixed(1)}%`;
}

// A battery: an outline with a nub, a green fill set by --level (0–100), the charge written on
// top (a second, dark copy is clipped to the fill so it stays readable on green).
function batteryMarkup(className, id, charge = 100) {
  return `<div class="battery ${className}"${id ? ` id="${id}"` : ""} style="--level:${Math.max(0, Math.min(100, charge))}">
      <div class="battery-cell"><span class="battery-fill"></span>
        <strong class="battery-value">${formatCharge(charge)}</strong><strong class="battery-value lit" aria-hidden="true">${formatCharge(charge)}</strong></div>
    </div>`;
}

function setBattery(battery, charge) {
  battery.style.setProperty("--level", Math.max(0, Math.min(100, charge)));
  if (battery.id === "scoreBattery" || battery.id === "resultBattery") city.setLevel(charge);
  battery.style.setProperty("--fill", chargeColor(charge));
  battery.querySelectorAll(".battery-value").forEach(value => { value.textContent = formatCharge(charge); });
  // The running battery's label takes its colour, and turns into a warning once the charge is low.
  const label = battery.id === "scoreBattery" ? document.querySelector("#scoreLabel") : null;
  if (label) {
    const charging = battery.classList.contains("charging");
    label.style.color = charging ? "" : chargeColor(charge);
    label.textContent = charging ? "CHARGING" : charge <= LOW_BATTERY ? "WARNING: LOW BATTERY" : "YOUR CHARGE";
  }
  // The results battery's "CHARGE LEFT" label takes its colour too (its wording stays the same).
  if (battery.id === "resultBattery") {
    const resultLabel = document.querySelector("#resultLabel");
    if (resultLabel) resultLabel.style.color = chargeColor(charge);
  }
}

function chargeColor(charge) {
  if (charge >= CHARGE_COLORS[0].at) return CHARGE_COLORS[0].color;
  for (let i = 1; i < CHARGE_COLORS.length; i++) {
    const upper = CHARGE_COLORS[i - 1];
    const lower = CHARGE_COLORS[i];
    if (charge >= lower.at) {
      const share = ((charge - lower.at) / (upper.at - lower.at) * 100).toFixed(1);
      return `color-mix(in oklab, ${upper.color} ${share}%, ${lower.color})`;
    }
  }
  return CHARGE_COLORS.at(-1).color;
}

const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Drains (or fills) a battery from one charge to another, moving the number with it.
function animateBattery(battery, from, to, duration, ease = easeOut) {
  const run = (battery.drainRun = (battery.drainRun || 0) + 1);
  return new Promise(resolve => {
    if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setBattery(battery, to);
      resolve(run === battery.drainRun);
      return;
    }
    const start = performance.now();
    function tick(now) {
      if (run !== battery.drainRun) return resolve(false);
      const ratio = Math.min(1, (now - start) / duration);
      setBattery(battery, Math.round((from + (to - from) * ease(ratio)) * 10) / 10);
      if (ratio < 1) requestAnimationFrame(tick);
      else resolve(true);
    }
    requestAnimationFrame(tick);
  });
}

// Whether a puzzle is (or will be) played in hard mode: locked in once it has a guess.
function isHard(progress = progressFor()) {
  if (endlessMode) return endlessHard;
  return progress.guesses.length ? Boolean(progress.hard) : hardPreferred;
}

function rateOf(progress = progressFor()) {
  return drainRateFor(isHard(progress));
}

function readPreference(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.error(`Could not read the ${key} preference.`, error);
    return null;
  }
}

function progressFor(date = currentDate) {
  const key = endlessMode ? endlessKey(endlessBank.startsOn) : practiceMode ? `practice:${date}` : date;
  if (!state.progress[key]) state.progress[key] = { guesses: [], locked: [], revealed: 0, draft: null };
  return state.progress[key];
}

function isTodayFinished() {
  return (state.progress[today]?.locked.length || 0) === currentQuestions.length ||
    state.games.some(game => game.date === today);
}

// Whether today's game was just finished (its coins count up when the results first show).
let freshDaily = false;

function recordTodayIfComplete(progress, notify = true) {
  // Only the daily puzzle counts here; endless runs keep their own records.
  if (endlessMode) return;
  const questions = todayPuzzle.questions;
  const rate = rateOf(progress);
  const finished = progress.guesses.length === questions.length || isOutOfCharge(progress.guesses, questions, rate);
  if (practiceMode || currentDate !== today || !finished || state.games.some(game => game.date === today)) return;
  const score = Number(dailyTotal(progress.guesses, questions.slice(0, progress.guesses.length)).toFixed(1));
  const charge = finalCharge(progress.guesses, questions, rate);
  state.games.push({ date: today, score, charge, ...(progress.hard ? { hard: true } : {}) });
  state.games.sort((a, b) => a.date.localeCompare(b.date));
  freshDaily = notify;
  const supercharged = progress.guesses.filter((guess, i) => pointsOff(guess, questions[i].answer) === 0).length;
  unlockAchievements([
    ...achievementsForGame({ charge, out: charge < 0, supercharged, hard: Boolean(progress.hard) }),
    ...streakAchievements(...gameStreaks())
  ], notify);
}

// Achievements earned in this visit that haven't been announced yet; they pop up once the
// results are on screen.
const unannouncedAchievements = [];

// A saved game's final charge. Games saved before supercharges recharged the battery only have
// their total points off, so their charge is worked out from that.
function gameCharge(game) {
  return game.charge ?? chargeLeft(game.score);
}

// The longest run of daily games on consecutive days, and of hard-mode games.
function gameStreaks() {
  return [longestStreak(state.games.map(game => game.date)), longestStreak(state.games.filter(game => game.hard).map(game => game.date))];
}

function unlockAchievements(ids, notify) {
  for (const id of ids) {
    if (state.achievements[id]) continue;
    state.achievements[id] = today;
    if (notify) unannouncedAchievements.push(id);
  }
}

// Games from before achievements existed (or saved by an older version) still count. Their
// supercharged answers aren't known, so only charge, running out, and streaks are credited.
function creditPastAchievements() {
  for (const game of state.games) {
    const charge = gameCharge(game);
    unlockAchievements(achievementsForGame({ charge, out: charge < 0, hard: Boolean(game.hard) }), false);
  }
  unlockAchievements(streakAchievements(...gameStreaks()), false);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
}

// Above each question: its number, big and outlined, with how many there are ("01 /5"; endless
// runs show just the number). Results screens show a short label instead.
function setQuestionNumber(index) {
  const counter = document.querySelector("#questionCounter");
  const number = String(index + 1).padStart(2, "0");
  // Moving on to the next question, the number rolls like an odometer: each digit that changes
  // rolls up and away while the new one rolls up from below. Reloads just show the number.
  // Only rolls when moving on by exactly one (not on reloads, new runs, or switching puzzles).
  const previous = counter.dataset.number;
  const rolling = previous !== undefined && Number(previous) + 1 === index + 1 && previous.length === number.length;
  const digits = [...number].map((digit, i) => {
    const before = rolling ? previous[i] : null;
    return before !== null && before !== digit
      ? `<span class="q-digit"><span class="q-roll"><span>${before}</span><span>${digit}</span></span></span>`
      : `<span class="q-digit"><span>${digit}</span></span>`;
  }).join("");
  counter.innerHTML = `<span class="q-num" aria-hidden="true">${digits}</span>${endlessMode ? "" : `<span class="q-of" aria-hidden="true">/${currentQuestions.length}</span>`}`;
  counter.dataset.number = number;
  counter.setAttribute("aria-label", endlessMode ? `Round ${index + 1}` : `Question ${index + 1} of ${currentQuestions.length}`);
}

function setCounterLabel(text) {
  const counter = document.querySelector("#questionCounter");
  counter.innerHTML = `<span class="q-label">${text}</span>`;
  delete counter.dataset.number;
  counter.removeAttribute("aria-label");
}

function render() {
  // A height kept from the previous question (see bindNext) only holds until the next screen change.
  document.querySelector("#gameCard").style.minHeight = "";
  const progress = progressFor();
  const out = isOutOfCharge(progress.guesses, currentQuestions, rateOf(progress));
  const view = viewForProgress(progress, currentQuestions.length, out);
  applyHardLook();
  const index = view.index;
  clearTimeout(powerOutTimer);
  clearTimeout(hideGameTimer);
  document.body.classList.remove("ascending");
  // Only shown while replaying an archived puzzle, so players can leave it at any time.
  document.querySelector("#returnButton").hidden = !practiceMode;
  if (practiceMode || endlessMode) leaveStartScreen();
  document.querySelector("#puzzleNumber").innerHTML = endlessMode ? INFINITY_ICON : `NO. ${currentNumber}`;
  // Endless runs keep a clock: 9 PM at the start, an hour on with each round. The results stay at
  // the time of the round the run ended on.
  const round = view.phase === "results" ? Math.max(0, progress.guesses.length - 1) : view.index;
  const clock = endlessMode ? endlessClock(round + CLOCK_SHIFT) : null;
  city.setTime(clock ? clock.hour : null);
  updateBillboard();
  updateSnow(endlessMode ? round : 0);
  document.querySelector("#puzzleDate").textContent = endlessMode ? `${endlessHard ? "HARD · " : ""}${clock.label} · ${clock.time}`.toUpperCase() : currentDate === today ? (currentTheme || "Today's edition").toUpperCase() : `${currentDate} · PRACTICE`;
  setAction("");
  const animate = justLocked;
  justLocked = false;
  // Reloading part-way through a power-out goes straight to the out-of-charge screen.
  if (view.phase === "reveal" && out && !animate) {
    progress.revealed = progress.guesses.length;
    save();
    return render();
  }
  const wasDead = document.body.classList.contains("dead");
  document.body.classList.toggle("dead", view.phase === "results" && out);
  // Once the out-of-charge screen is up, a UFO glides across the open sky just under the top bar.
  if (!wasDead && document.body.classList.contains("dead")) {
    setTimeout(() => {
      if (document.body.classList.contains("dead")) city.ufo((document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 60) + 14);
    }, 1200);
  }
  renderScoreBox(progress, view, animate);
  if (view.phase === "results") {
    renderResults();
    return;
  }
  const question = currentQuestions[index];
  setQuestionNumber(index);
  const guess = progress.draft ?? 50;
  stage.innerHTML = `
    <div class="question-body">
      <div class="question-head"><h2 class="question-text">${escapeHtml(question.text)}</h2>
        <div class="hint-row"><p class="question-hint">${escapeHtml(scaleHint(question))}</p></div></div>
      ${view.phase === "reveal" ? reveal(question, progress.guesses[index], index) : guessForm(guess, question)}
    </div>`;
  if (view.phase === "guess") maybeFlyPlane();
  setAction(view.phase === "reveal"
    ? actionButton("next-button", "nextButton", index === currentQuestions.length - 1 ? ["Battery report", "Report"] : ["Next question", "Next"])
    : actionButton("lock-button", "lockButton", ["Lock in my guess", "Lock in"]));
  if (view.phase === "guess") {
    bindGuessControls(guess, index);
    billboardClearOf = null;
    keepBillboardClear();
  } else {
    playReveal(animate);
    bindNext(index);
    setTimeout(keepBillboardClear, 1500); // once the fun fact has faded in
  }
}

// The question's main button (Lock in, or Next) sits at the top right, on the line with the big
// question number, so the bottom of the screen is left to the city. Very narrow phones get the
// short label.
function actionButton(className, id, [long, short]) {
  return `<button class="${className}" id="${id}"><span class="label-long">${long}</span><span class="label-short">${short}</span> ${ICONS.right}</button>`;
}

function setAction(html) {
  document.querySelector("#questionAction").innerHTML = html;
}

// The battery above the card shows the charge left so far. It starts full, and each time a guess
// is revealed it drains by that miss (with a "−X%" chip flying off it).
function renderScoreBox(progress, view, animate) {
  const box = document.querySelector("#scoreBox");
  const battery = document.querySelector("#scoreBattery");
  const chip = document.querySelector("#drainChip");
  const note = document.querySelector("#scoreNote");
  const key = endlessMode ? `${endlessKey(endlessBank.startsOn)}:${state.endless.runs}` : `${practiceMode ? "practice" : "daily"}:${currentDate}`;
  const locked = progress.guesses.length;
  // The results screen shows the final battery inside the card, so the box above it steps aside.
  box.hidden = view.phase === "results";
  if (view.phase !== "results") document.querySelector("#recap").hidden = true;
  chip.classList.remove("fly");
  battery.classList.remove("alarm");
  if (!locked) {
    shownScore = { key, value: 100 };
    battery.drainRun = (battery.drainRun || 0) + 1;
    setBattery(battery, 100);
    note.textContent = "";
    return;
  }
  const rate = rateOf(progress);
  const charge = finalCharge(progress.guesses, currentQuestions, rate);
  const previous = finalCharge(progress.guesses.slice(0, -1), currentQuestions, rate);
  const lastOff = pointsOff(progress.guesses[locked - 1], currentQuestions[locked - 1].answer);
  // What a supercharge added (nothing if the battery was already full).
  const gain = Math.round((charge - previous) * 10) / 10;
  // Blank while answering; "X% off" (or the recharge) pops in with each reveal.
  note.textContent = view.phase === "reveal"
    ? lastOff === 0 ? gain > 0 ? `+${gain.toFixed(1)}% CHARGE!` : "NO CHARGE LOST!" : `${distanceText(currentQuestions[locked - 1], progress.guesses[locked - 1])} off`
    : "";
  note.classList.remove("pop");
  if (animate && view.phase === "reveal") {
    note.getBoundingClientRect();
    note.classList.add("pop");
    // A supercharge recharges the battery, so a green "+5%" chip pops off instead.
    chip.classList.toggle("no-drain", lastOff === 0);
    chip.textContent = lastOff === 0 ? gain > 0 ? `+${gain.toFixed(1)}%` : "FULL" : `−${(lastOff * rate).toFixed(1)}%`;
    chip.getBoundingClientRect();
    chip.classList.add("fly");
  }
  // The battery never shows below empty.
  const shown = Math.max(0, charge);
  const from = shownScore?.key === key ? shownScore.value : animate ? Math.max(0, previous) : shown;
  shownScore = { key, value: shown };
  // Only the reveal of a guess that runs the battery out starts the blackout, once it has drained to empty.
  const alarm = animate && view.phase === "reveal" && charge < 0;
  if (animate && view.phase === "reveal" && lastOff > 0) city.wave("down");
  if (alarm) soundAlarm();
  animateBattery(battery, from, shown, DRAIN_MS);
}

function soundAlarm() {
  city.outOfCharge(powerOut, LIGHTS_OUT_MS);
  hideGameTimer = setTimeout(() => document.body.classList.add("ascending"), HIDE_GAME_MS);
}

// Slides the guess sideways away from the answer, then fades in the arrow and the real answer.
// On the battery, a guess that was too high drains back to the answer, leaving gray where the
// charge was; a guess that was too low grows a gray stretch from the guess out to the answer.
function playReveal(animate) {
  const row = document.querySelector("#revealRow");
  const comparison = document.querySelector(".comparison");
  const battery = document.querySelector("#revealBattery");
  // When the guess was too high, the green drains back to end at the answer.
  const drainTo = comparison.classList.contains("too-high") ? comparison.dataset.answer : null;
  const next = document.querySelector("#nextButton");
  const card = document.querySelector("#gameCard");
  card.classList.remove("struck");
  clearTimeout(nextButtonTimer);
  if (isOutOfCharge(progressFor().guesses, currentQuestions, rateOf())) {
    next.remove();
    powerOutTimer = setTimeout(powerOut, matchMedia("(prefers-reduced-motion: reduce)").matches ? POWER_OUT_DELAY_REDUCED_MS : POWER_OUT_DELAY_MS);
  }
  if (!animate) {
    row.classList.add("instant", "go");
    comparison.classList.add("instant", "answered");
    if (drainTo !== null) battery.style.setProperty("--level", drainTo);
    next.classList.add("shown");
    return;
  }
  const delay = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ANSWER_SHOWN_MS + NEXT_BUTTON_DELAY_MS;
  nextButtonTimer = setTimeout(() => next.classList.add("shown"), delay);
  const guessEl = row.querySelector(".reveal-guess");
  const rowBox = row.getBoundingClientRect();
  const guessBox = guessEl.getBoundingClientRect();
  const fromCenter = rowBox.left + rowBox.width / 2 - (guessBox.left + guessBox.width / 2);
  guessEl.style.transform = `translateX(${fromCenter}px)`;
  guessEl.getBoundingClientRect();
  requestAnimationFrame(() => {
    guessEl.style.transition = "transform .9s cubic-bezier(.2,.8,.2,1)";
    guessEl.style.transform = "translateX(0)";
    row.classList.add("go");
    comparison.classList.add("answered");
    if (drainTo !== null) battery.style.setProperty("--level", drainTo);
    if (row.classList.contains("struck")) card.classList.add("struck");
  });
  // A supercharge strikes the city with lightning as the reveal lands; a perfect answer (exact to
  // the tenth) gets the big, branching strike.
  if (row.classList.contains("struck")) {
    const progress = progressFor();
    const last = progress.guesses.length - 1;
    const perfect = progress.guesses[last] === currentQuestions[last].answer;
    setTimeout(() => city.strike({ perfect }), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1300);
    // The Market's fireworks finale (Extras): a full show after the strike.
    if (hasExtra(state.wallet, "finale")) setTimeout(city.finale, 1900);
  } else if (animate) {
    // A very close guess sets off one small firework.
    const progress = progressFor();
    const last = progress.guesses.length - 1;
    if (pointsOff(progress.guesses[last], currentQuestions[last].answer) <= CLOSE_FIREWORK_WITHIN) setTimeout(city.firework, 1300);
  }
}

// The electric end of the guess bar. The fill's own edge is jagged and snaps between three
// shapes, each with a bright "hot" line along it.
const ZAP_EDGES = [
  "10,0 14,5 8,11 15,17 9,23 16,29 10,35 14,41 9,48",
  "12,0 8,6 15,12 9,18 14,24 8,30 15,36 9,42 12,48",
  "9,0 15,7 10,13 13,19 7,25 14,31 9,37 16,43 10,48"
];
const ZAP = `<svg class="zap" viewBox="0 0 26 48" preserveAspectRatio="none" aria-hidden="true">${ZAP_EDGES.map((edge, i) =>
  `<g class="zap-frame zap-${i + 1}"><polygon points="0,0 ${edge} 0,48"/><polyline points="${edge}"/></g>`).join("")}</svg>`;

function powerOut() {
  const progress = progressFor();
  if (progress.revealed >= progress.guesses.length) return; // already showing the results
  progress.revealed = progress.guesses.length;
  save();
  window.scrollTo({ top: 0 });
  render();
}

// The guess as typed in the box: big scales get thousands separators ("70,000"), and reading it
// back ignores them.
const groupedEntry = (text, scale) => (scale.max >= 10_000 ? text.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : text);
const enteredValue = input => Number(input.value.replace(/,/g, ""));

// `guess` is a position along the bar (0–100); the box shows it in the question's own units.
function guessForm(guess, question) {
  const scale = scaleOf(question);
  const percent = !question?.scale;
  const shown = formatValue(fromPosition(guess, scale), scale, { withUnit: false });
  const widest = formatValue(scale.max, scale, { withUnit: false }).length;
  const width = widest > 4 ? ` style="width:calc(${widest}ch + 34px)"` : "";
  const label = percent ? "Your percentage guess, from 0 to 100" : `Your guess, from ${formatValue(scale.min, scale)} to ${formatValue(scale.max, scale)}`;
  const step = (scaleStep(scale) / (scale.max - scale.min)) * 100;
  const unit = scale.unit || "";
  return `<div class="guess-display">${scale.prefix ? `<span class="percent-sign">${escapeHtml(scale.prefix)}</span>` : ""}<input class="guess-input" id="guessInput" type="text" inputmode="${scaleDecimals(scale) ? "decimal" : "numeric"}" autocomplete="off" spellcheck="false" value="${shown}"${width} aria-label="${escapeAttr(label)}">${unit ? `<span class="percent-sign">${escapeHtml(unit)}</span>` : ""}</div>
    <div class="range-wrap"><div class="battery bar-battery" id="guessBattery" style="--level:${guess}"><div class="battery-cell"><span class="battery-fill"></span>${ZAP}
        <input class="battery-range" id="guessRange" type="range" min="0" max="100" step="${Number(step.toFixed(6))}" value="${guess}" aria-label="${escapeAttr(label.replace("Your", "Adjust your"))}"></div></div>
      ${rangeLabels(question)}</div>`;
}

function bindGuessControls(initial, index) {
  const input = document.querySelector("#guessInput");
  const range = document.querySelector("#guessRange");
  const battery = document.querySelector("#guessBattery");
  const scale = scaleOf(currentQuestions[index]);
  const position = () => Math.max(0, Math.min(100, toPosition(enteredValue(input), scale)));
  let entry = guessEntryFrom(fromPosition(initial, scale), scale);
  const persistDraft = () => {
    battery.style.setProperty("--level", position());
    progressFor().draft = position();
    save();
  };
  const showEntry = () => {
    input.value = groupedEntry(guessEntryText(entry), scale);
    range.value = position();
    input.setSelectionRange(input.value.length, input.value.length);
    persistDraft();
  };
  // Handle typing ourselves so the decimal point stays put (see applyGuessKey).
  input.addEventListener("beforeinput", event => {
    event.preventDefault();
    if (event.inputType.startsWith("delete")) entry = applyGuessKey(entry, "Backspace");
    else if (event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") {
      const pasted = Number.parseFloat(event.data ?? event.dataTransfer?.getData("text") ?? "");
      if (Number.isFinite(pasted)) entry = { ...guessEntryFrom(roundToScale(Math.max(scale.min, Math.min(scale.max, pasted)), scale), scale), fresh: false };
    } else for (const key of event.data ?? "") entry = applyGuessKey(entry, key);
    showEntry();
  });
  input.addEventListener("focus", () => {
    entry = { ...entry, fresh: true };
    requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
  });
  range.addEventListener("input", () => {
    entry = guessEntryFrom(fromPosition(Number(range.value), scale), scale);
    input.value = groupedEntry(guessEntryText(entry), scale);
    persistDraft();
  });
  document.querySelector("#lockButton").addEventListener("click", () => {
    const value = enteredValue(input);
    if (input.value.trim() === "" || !Number.isFinite(value) || value < scale.min || value > scale.max) {
      input.setCustomValidity(`Enter a number from ${formatValue(scale.min, scale, { withUnit: false })} to ${formatValue(scale.max, scale, { withUnit: false })}.`);
      input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    const progress = progressFor();
    if (!progress.guesses.length) progress.hard = hardPreferred;
    if (endlessMode) markEndlessSeen(currentQuestions[index]);
    // Saved as a position along the bar (for a percentage, the guess itself).
    progress.guesses[index] = Math.round(toPosition(value, scale) * 1000) / 1000;
    progress.locked.push(true);
    progress.draft = null;
    recordTodayIfComplete(progress);
    save();
    justLocked = true;
    render();
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") document.querySelector("#lockButton").click();
  });
  input.value = groupedEntry(guessEntryText(entry), scale);
}

// A guess's number glows like it's charged: bright and glowing when close, dimming toward a
// drained gray the further off it is (litLevel in game.mjs).
function litStyle(off) {
  const lit = (litLevel(off) * 100).toFixed(1);
  return {
    color: `color-mix(in oklab, var(--lit) ${lit}%, var(--unlit))`,
    glow: `0 0 ${(lit * 0.16).toFixed(1)}px color-mix(in srgb, var(--charge) ${lit}%, transparent)`
  };
}

// "Supercharged!": the short note for a guess that cost no charge.
function noDrainNote() {
  return `${NO_DRAIN_WORD.charAt(0)}${NO_DRAIN_WORD.slice(1).toLowerCase()}!`;
}

function reveal(question, guess, index) {
  const off = pointsOff(guess, question.answer);
  const guessX = Math.max(0, Math.min(100, guess));
  const answerX = Math.max(0, Math.min(100, question.answer));
  const left = Math.min(guessX, answerX);
  const width = Math.abs(guessX - answerX);
  const answerHigher = question.answer >= guess;
  const arrow = guess === question.answer ? "=" : answerHigher ? ICONS.right : ICONS.left;
  const lit = litStyle(off);
  const scale = scaleOf(question);
  const guessShown = formatValue(guessValue(question, guess), scale), answerShown = formatValue(answerValue(question), scale);
  // Long numbers ("$120,000") get a smaller size so both fit side by side on a phone.
  const long = Math.max(guessShown.length, answerShown.length) > 7 ? " long" : "";
  return `<div class="reveal-row ${answerHigher ? "" : "lower"}${off === 0 ? " struck" : ""}${long}" id="revealRow" aria-label="You guessed ${escapeAttr(guessShown)}. The answer is ${escapeAttr(answerShown)}, ${escapeAttr(distanceText(question, guess))} off.">
      <span class="reveal-num reveal-guess" style="--lit-color:${lit.color};--lit-glow:${lit.glow}">${valueHtml(question, guessValue(question, guess))}</span>
      <span class="reveal-arrow" aria-hidden="true">${arrow}</span>
      <span class="reveal-num reveal-answer">${valueHtml(question, answerValue(question))}</span>
      ${off === 0 ? `<span class="supercharged" role="status">${NO_DRAIN_WORD}</span>` : ""}
    </div>
    <div class="comparison ${answerHigher ? "too-low" : "too-high"}" data-answer="${answerX}" aria-hidden="true">
      <div class="battery bar-battery" id="revealBattery" style="--level:${guessX}"><div class="battery-cell">
        <span class="drained" style="left:${left}%;width:${width}%"></span><span class="battery-fill"></span>
        <span class="marker guess" style="left:${guessX}%;--lit-color:${lit.color};--lit-glow:${lit.glow}"><span class="marker-caption">YOU</span></span>
        <span class="marker answer" style="left:${answerX}%"><span class="marker-caption">ANSWER</span></span></div></div>
      ${rangeLabels(question)}
    </div>
    <p class="source-note">${escapeHtml(question.funFact)}</p>`;
}

function bindNext(index) {
  // There's no Next button after a guess that ran the battery out.
  document.querySelector("#nextButton")?.addEventListener("click", () => {
    const progress = progressFor();
    progress.revealed = index + 1;
    save();
    animateResults = progress.revealed === currentQuestions.length;
    // Moving on, the page stays where the player is: the game area keeps its height (so the
    // shorter next question doesn't pull the page up) and the scroll position is put back.
    const card = document.querySelector("#gameCard");
    const scrolled = window.scrollY;
    const height = card.offsetHeight;
    render();
    card.style.minHeight = `${height}px`;
    window.scrollTo({ top: scrolled });
  });
}

// Below the card on the results screen: "Drain by question". A graph shows the battery stepping
// down question by question, like a phone's battery-usage chart, and under it one box shows a
// single question with a mini version of its reveal bar. It starts on the best guess (marked as
// such); tapping a step on the graph switches the box to that question.
function renderRecap(progress) {
  const recap = document.querySelector("#recap");
  const offs = progress.guesses.map((guess, i) => pointsOff(guess, currentQuestions[i].answer));
  const charges = chargeTrack(progress.guesses, currentQuestions, rateOf(progress));
  const best = bestGuessIndex(progress.guesses, currentQuestions);
  recap.innerHTML = `<section class="log" aria-label="Drain by question: your charge after each question">
      <h3 class="log-title">Drain by question</h3>
      ${dischargeGraph(charges, endlessMode ? Math.max(charges.length, 1) : currentQuestions.length)}
    </section>
    <div id="logDetail" aria-live="polite"></div>`;
  recap.hidden = false;
  const detail = recap.querySelector("#logDetail");
  const show = step => {
    recap.querySelectorAll(".log-step").forEach(button => {
      button.classList.toggle("selected", Number(button.dataset.step) === step);
      button.setAttribute("aria-pressed", Number(button.dataset.step) === step);
    });
    const question = currentQuestions[step];
    detail.innerHTML = step < progress.guesses.length ? logRow(question, progress.guesses[step], offs[step], step, step === best, charges[step] - (step ? charges[step - 1] : 100), rateOf(progress)) : `<article class="recap-item log-row unreached">
      <div class="log-row-head"><span class="log-q">Q${step + 1}</span><span class="recap-badge">Not reached</span></div>
      <p class="recap-question">${escapeHtml(question.text)}</p>
      <p class="recap-numbers"><span>Answer: ${escapeHtml(formatValue(answerValue(question), scaleOf(question)))}</span></p>
    </article>`;
  };
  recap.querySelectorAll(".log-step").forEach(button => button.addEventListener("click", () => show(Number(button.dataset.step))));
  show(best);
}

// The stepped line: flat at the charge going into each question, then a drop at the question to
// the charge after it. The battery never shows below empty; any questions after it ran out are a
// dashed "not reached" stretch.
function dischargeGraph(charges, count = currentQuestions.length) {
  const x = step => 6 + step * (288 / count);
  const y = charge => 8 + (100 - Math.max(0, Math.min(100, charge))) * 1.04;
  let line = `M${x(0)},${y(100)}`;
  charges.forEach((charge, i) => {
    line += ` H${x(i + 1) - 10} L${x(i + 1)},${y(charge)}`;
  });
  const lastX = x(charges.length);
  const area = `${line} V${y(0)} H${x(0)} Z`;
  const unreached = charges.length < count
    ? `<path class="log-unreached" d="M${lastX},${y(0)} H${x(count)}"/>` : "";
  const at = (step, charge) => `left:${(x(step + 1) / 300 * 100).toFixed(2)}%;top:${(y(charge) / 120 * 100).toFixed(2)}%`;
  const steps = charges.map((charge, i) => `<button class="log-step" data-step="${i}" style="${at(i, charge)};--fill:${chargeColor(charge)}" aria-label="Question ${i + 1}: ${charge < 0 ? "out of charge" : `${formatCharge(charge)} left`}">${i + 1}</button>`).join("") +
    Array.from({ length: count - charges.length }, (_, n) => `<button class="log-step unreached-step" data-step="${charges.length + n}" style="${at(charges.length + n, 0)}" aria-label="Question ${charges.length + n + 1}: not reached">${charges.length + n + 1}</button>`).join("");
  return `<div class="log-graph">
      <svg viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="logFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--charge)" stop-opacity=".35"/><stop offset="1" stop-color="var(--charge)" stop-opacity="0"/></linearGradient></defs>
        ${[100, 50, 0].map(charge => `<line class="log-grid" x1="0" x2="300" y1="${y(charge)}" y2="${y(charge)}"/>`).join("")}
        <path class="log-area" d="${area}"/>
        <path class="log-line" d="${line}"/>
        ${unreached}
      </svg>
      <span class="log-axis" style="top:${(y(100) / 120 * 100).toFixed(2)}%">100%</span><span class="log-axis" style="top:${(y(0) / 120 * 100).toFixed(2)}%">0%</span>
      ${steps}
    </div>`;
}

// One answered question: what it cost, the question, a mini reveal bar (green up to the lower of
// guess and answer, gray across the gap, a YOU tick and an ANSWER tick), and the two numbers.
function logRow(question, guess, off, i, isBest, change, rate) {
  const lit = litStyle(off);
  const guessX = Math.max(0, Math.min(100, guess));
  const answerX = Math.max(0, Math.min(100, question.answer));
  const low = Math.min(guessX, answerX);
  return `<article class="recap-item log-row">
      <div class="log-row-head"><span class="log-q">Q${i + 1}</span>${isBest ? '<span class="recap-badge">Best guess</span>' : ""}<span class="log-cost">${off === 0 ? `${noDrainNote()}${change > 0 ? ` +${change.toFixed(1)}%` : ""}` : `−${(off * rate).toFixed(1)}%`}</span></div>
      <p class="recap-question">${escapeHtml(question.text)}</p>
      <div class="mini-bar" aria-hidden="true"><span class="mini-fill" style="width:${low}%"></span><span class="mini-gap" style="left:${low}%;width:${Math.abs(guessX - answerX)}%"></span>
        <span class="mini-tick" style="left:${guessX}%;background:${lit.color};box-shadow:${lit.glow}"></span><span class="mini-tick answer" style="left:${answerX}%"></span></div>
      <p class="recap-numbers"><span style="color:${lit.color};text-shadow:${lit.glow}">You: ${escapeHtml(formatValue(guessValue(question, guess), scaleOf(question)))}</span><span>Answer: ${escapeHtml(formatValue(answerValue(question), scaleOf(question)))}</span></p>
    </article>`;
}

function renderResults() {
  if (endlessMode) return renderEndlessResults();
  const progress = progressFor();
  const answered = progress.guesses.length;
  const rate = rateOf(progress);
  const hard = isHard(progress);
  const out = isOutOfCharge(progress.guesses, currentQuestions, rate);
  const charge = finalCharge(progress.guesses, currentQuestions, rate);
  const animate = animateResults && !out;
  // The coins count up on the first showing after the game, out of charge or not.
  const animateCoins = freshDaily;
  freshDaily = false;
  animateResults = false;
  // Today's game pays its charge in coins (practice replays don't).
  const todaysGame = !practiceMode && state.games.find(game => game.date === currentDate);
  const coins = coinTotalMarkup(todaysGame ? dailyCoins(todaysGame) : 0);
  const headline = out
    ? `<div class="final-score dead-score reveal">${coins}<div class="result-battery-wrap">${batteryMarkup("result-battery dead-battery", null, 0)}</div>
      <h2 class="out-title">Out of charge</h2><p class="out-where">Died on question ${answered} of ${currentQuestions.length}</p></div>`
    : `<div class="final-score reveal">${coins}<span class="answer-label" id="resultLabel">${hard ? "HARD MODE · " : ""}${currentDate === today ? "" : "PRACTICE "}CHARGE LEFT</span>
      <div class="result-battery-wrap">${batteryMarkup("result-battery", "resultBattery", animate ? 100 : charge)}</div></div>`;
  stage.innerHTML = `${headline}
    ${practiceMode ? "" : `<section class="crowd-panel" id="crowdPanel" aria-live="polite"><h3 class="crowd-title">How you stack up${hard ? " · Hard mode" : ""}</h3><p class="crowd-copy">Your charge is added anonymously. Never your guesses, name, or account.</p><p class="crowd-status">Seeing how you stack up…</p></section>`}
    <button class="share-button" id="shareButton">Share ${currentDate === today ? "today's" : "this"} result ${ICONS.share}</button>
    ${practiceMode ? '<button class="next-button secondary-button" id="replayButton">Play this puzzle again</button><button class="next-button secondary-button" id="todayButton">Back to today\'s puzzle</button>' : ""}
    <button class="next-button secondary-button" id="statsInline">Your stats &amp; archives ${ICONS.right}</button>`;
  setCounterLabel(out ? "Power lost" : "Puzzle complete");
  renderRecap(progress);
  countUpCoins(animateCoins);
  document.querySelector("#shareButton").addEventListener("click", () => {
    sendStat("event", { kind: "share" });
    shareResult(charge, progress, out);
  });
  document.querySelector("#replayButton")?.addEventListener("click", () => {
    state.progress[`practice:${currentDate}`] = { guesses: [], locked: [], revealed: 0, draft: null };
    save();
    render();
  });
  document.querySelector("#todayButton")?.addEventListener("click", returnToToday);
  document.querySelector("#statsInline").addEventListener("click", showStats);
  if (!practiceMode) loadCrowd(crowdRank(progress.guesses, currentQuestions, rate), out, hard);
  if (out) setTimeout(announceAchievements, 1200);
  else playResultDrain(charge, animate).then(finished => {
    if (!finished) return;
    if (animate && charge >= FIREWORKS_AT) city.fireworks();
    // A perfect game (every answer supercharged) gets searchlights sweeping the sky.
    if (animate && progress.guesses.every((guess, i) => pointsOff(guess, currentQuestions[i].answer) === 0)) city.searchlights();
    if (animate && lowBatteryTier(charge)) showLowBatteryAlert(charge, announceAchievements);
    else announceAchievements();
  });
}

// The final battery drains from 100% to the charge left. Resolves false if it was interrupted.
async function playResultDrain(charge, animate) {
  const battery = document.querySelector("#resultBattery");
  if (animate && !(await animateBattery(battery, 100, charge, 2400))) return false;
  setBattery(battery, charge);
  return true;
}

// Finishing alive on a low battery: a pop-up like a phone's "Low Battery" warning.
const LOW_BATTERY_LINES = {
  fumes: "Running on fumes.",
  clutch: "Clutch.",
  "last-drop": "That was the last drop.",
  zero: "Still alive."
};

function showLowBatteryAlert(charge, onClose) {
  const color = chargeColor(charge);
  document.body.insertAdjacentHTML("beforeend", `<div class="low-alert-backdrop">
      <div class="low-alert" role="alertdialog" aria-labelledby="lowAlertTitle" aria-describedby="lowAlertText">
        <span class="low-alert-battery" style="--level:${Math.max(4, charge)};--fill:${color}" aria-hidden="true"></span>
        <h3 id="lowAlertTitle">Low Battery</h3>
        <p id="lowAlertText">${formatCharge(charge)} battery remaining. <strong style="color:${color}">${LOW_BATTERY_LINES[lowBatteryTier(charge)]}</strong></p>
        <button type="button">Close</button>
      </div>
    </div>`);
  const backdrop = document.querySelector(".low-alert-backdrop");
  const close = backdrop.querySelector("button");
  close.focus();
  close.addEventListener("click", () => {
    backdrop.remove();
    onClose();
  });
}

// New achievements slide in from the top one after another.
let announcing = false;

function announceAchievements() {
  if (announcing) return;
  const id = unannouncedAchievements.shift();
  if (!id) return;
  announcing = true;
  const achievement = ACHIEVEMENTS.find(item => item.id === id);
  document.body.insertAdjacentHTML("beforeend", `<div class="ach-toast" role="status">${achievementBadge(achievement)}
      <span><small>Achievement unlocked</small><strong>${escapeHtml(achievement.name)}</strong></span></div>`);
  const toast = document.body.lastElementChild;
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("shown")));
  setTimeout(() => {
    toast.classList.remove("shown");
    setTimeout(() => {
      toast.remove();
      announcing = false;
      announceAchievements();
    }, 450);
  }, 3200);
}

function achievementBadge(achievement) {
  return `<span class="ach-badge" aria-hidden="true">${achievement.badge === "bolt" ? '<span class="ach-bolt"></span>' : achievement.badge === "infinity" ? INFINITY_ICON : escapeHtml(achievement.badge)}</span>`;
}

function showAchievements() {
  const unlocked = ACHIEVEMENTS.filter(achievement => state.achievements[achievement.id]).length;
  const streak = consecutiveStreak(state.games);
  const hardStreak = consecutiveStreak(state.games.filter(game => game.hard));
  const groups = [...new Set(ACHIEVEMENTS.map(achievement => achievement.group))];
  openDialog("Achievements", `<p class="ach-count">${unlocked} of ${ACHIEVEMENTS.length} unlocked</p>
    ${groups.map(group => `<h3 class="dialog-subtitle ach-group">${group}</h3><div class="ach-list">${ACHIEVEMENTS.filter(achievement => achievement.group === group).map(achievement => {
      const date = state.achievements[achievement.id];
      const meta = date ? `Unlocked ${longDate(date)}`
        : achievement.streak ? `Current streak: ${Math.min(streak, achievement.streak)} / ${achievement.streak}`
        : achievement.hardStreak ? `Current hard streak: ${Math.min(hardStreak, achievement.hardStreak)} / ${achievement.hardStreak}`
        : "Locked";
      return `<div class="ach ${date ? "unlocked" : "locked"}">${achievementBadge(achievement)}
        <div><strong>${escapeHtml(achievement.name)}</strong><p>${escapeHtml(achievement.description)}</p><span class="ach-meta">${meta}</span></div></div>`;
    }).join("")}</div>`).join("")}`);
}

function returnToToday() {
  currentDate = today;
  currentNumber = todayPuzzle.number;
  currentTheme = todayPuzzle.theme || null;
  currentQuestions = todayPuzzle.questions;
  practiceMode = false;
  endlessMode = false;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function crowdRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Crowd comparison failed (${response.status}).`);
  return body;
}

function crowdToken() {
  const key = `percentle.crowd.${today}`;
  const current = readPreference(key);
  if (current) return current;
  if (!crypto.randomUUID) throw new Error("This browser cannot create an anonymous comparison ID.");
  fallbackCrowdId ??= crypto.randomUUID();
  try {
    localStorage.setItem(key, fallbackCrowdId);
  } catch (error) {
    console.error("Could not save the anonymous Percentle ID.", error);
  }
  return fallbackCrowdId;
}
// Used only when localStorage is unavailable, so retries in this tab reuse one ID.
let fallbackCrowdId = null;

async function loadCrowd(score, out, hard) {
  const panel = document.querySelector("#crowdPanel");
  if (!panel) return;
  try {
    const summary = await crowdRequest("/api/percentle/crowd", {
      method: "POST",
      body: { date: today, score, id: crowdToken(), mode: hard ? "hard" : "normal" }
    });
    if (out) renderOutOfChargeCrowd(panel, summary, hard);
    else renderCrowdSummary(panel, summary, hard);
  } catch (error) {
    console.error("Could not submit anonymous Percentle score.", error);
    panel.querySelector(".crowd-status").innerHTML = `Today's comparison is temporarily unavailable. <button class="crowd-action" id="crowdRetry">Try again</button>`;
    panel.querySelector("#crowdRetry").addEventListener("click", () => loadCrowd(score, out, hard));
  }
}

// After running out of charge, there's no line: just how many other players ran out too.
function renderOutOfChargeCrowd(panel, summary, hard) {
  const share = summary.alsoRanOut;
  const line = share === null
    ? `Once at least ${summary.minimumComparisonPlayers} other players finish today's puzzle, you'll see how many of them ran out of charge.`
    : share === 0 ? "Nobody else has run out of charge today. Yet."
    : `<strong>${share.toFixed(1)}%</strong> of today's players ran out of charge.`;
  panel.innerHTML = `<h3 class="crowd-title">Today's blackouts${hard ? " · Hard mode" : ""}</h3><p class="crowd-position">${line}</p>`;
}

function renderCrowdSummary(panel, summary, hard) {
  const linePosition = summary.betterThan;
  const placement = summary.betterThan === null
    ? `<p class="crowd-position">Your marker appears once at least ${summary.minimumComparisonPlayers} other players have finished today's puzzle.</p>`
    : `<p class="crowd-position">You were better than <strong>${summary.betterThan.toFixed(1)}%</strong> of players today.</p>`;
  panel.innerHTML = `<h3 class="crowd-title">How you stack up${hard ? " · Hard mode" : ""}</h3>
    ${crowdLine(linePosition)}${placement}`;
}

function crowdLine(position) {
  const x = position === null ? null : 12 + position / 100 * 276;
  return `<svg class="crowd-line" viewBox="0 0 300 42" role="img" aria-label="${position === null ? "Line from the lowest charge left today to the highest; your position is not available yet." : `Your marker is ${position.toFixed(1)} percent of the way from the lowest charge to the highest.`}">
      <line class="line-axis" x1="12" y1="31" x2="288" y2="31"/>
      ${x === null ? "" : `<circle class="you-marker" cx="${x}" cy="31" r="6"/><text class="you-label" x="${x}" y="13" text-anchor="middle">YOU</text>`}
    </svg>`;
}

function shareResult(charge, progress, out) {
  // The real distance of the best guess (even one that scored a perfect 0), e.g. "0.2% away", in
  // that question's units ("$1,200 away"). The closest is measured along the bar, so scales compare.
  const gaps = progress.guesses.map((guess, i) => Math.abs(guess - currentQuestions[i].answer));
  const nearest = gaps.indexOf(Math.min(...gaps));
  const closest = distanceText(currentQuestions[nearest], progress.guesses[nearest]);
  const status = out ? `🪫 Out of charge on Q${progress.guesses.length}` : lowBatteryTier(charge) ? `🪫 Survived on ${formatCharge(charge)}` : `🔋 ${formatCharge(charge)}`;
  const link = `${location.origin}${location.pathname}`;
  const result = `${GAME_NAME} #${currentNumber}${currentTheme ? ` · ${currentTheme}` : ""}${isHard(progress) ? " · Hard mode 😈" : ""}\n${status}\nClosest guess - ${closest} away\n${link}`;
  if (navigator.share) {
    navigator.share({ text: result }).catch(error => {
      if (error.name !== "AbortError") copyResult(result);
    });
  } else copyResult(result);
}

async function copyResult(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Spoiler-free result copied!");
  } catch (error) {
    console.error("Could not copy Percentle result.", error);
    showToast("Clipboard unavailable — try sharing from your browser.");
  }
}

function consecutiveStreak(games) {
  const dates = new Set(games.map(game => game.date));
  let cursor = new Date(`${today}T00:00:00Z`);
  if (!dates.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (dates.has(utcDate(cursor))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

// Bars for the 10 most recent games, oldest to newest. Taller bars mean more charge left.
// Clicking a bar shows that game's date and charge underneath.
function lastTenGames(games) {
  const recent = games.slice(-10);
  if (!recent.length) return "<p class=\"hist-empty\">Finish today's puzzle to start your history.</p>";
  const shortDate = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  return `<div class="recent-games" role="group" aria-label="Your recent games, oldest to newest">${recent.map((game, i) => `
      <button class="recent-bar${i === recent.length - 1 ? " selected" : ""}" data-date="${escapeAttr(game.date)}" data-charge="${chargeLabel(game)}"${game.hard ? " data-hard" : ""} aria-label="${longDate(game.date)}: ${chargeLabel(game.score)}">
        <span class="recent-bar-fill${gameCharge(game) < 0 ? " negative" : game.hard ? " hard" : ""}" style="height:${Math.max(4, Math.min(100, gameCharge(game))).toFixed(1)}%"></span>
        <span class="recent-bar-date">${shortDate(game.date)}</span>
      </button>`).join("")}</div>
    <p class="recent-detail" id="recentDetail" aria-live="polite"></p>`;
}

function chargeLabel(game) {
  const charge = gameCharge(game);
  return charge < 0 ? "Out of charge" : `${formatCharge(charge)} charge left`;
}

function longDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function bindLastTenGames() {
  const detail = dialog.querySelector("#recentDetail");
  const bars = [...dialog.querySelectorAll(".recent-bar")];
  const select = bar => {
    bars.forEach(other => other.classList.toggle("selected", other === bar));
    detail.innerHTML = `${longDate(bar.dataset.date)} · <strong>${bar.dataset.charge}</strong>${"hard" in bar.dataset ? ` · Hard mode ${ICONS.devil}` : ""}`;
  };
  bars.forEach(bar => bar.addEventListener("click", () => select(bar)));
  if (bars.length) select(bars.at(-1));
}

function showStats() {
  const games = state.games;
  // A game that ran out of charge counts as 0% left; a hard game counts as its regular-mode
  // equivalent, so playing hard doesn't pull the average down.
  const charges = games.map(game => Math.max(0, statsCharge(gameCharge(game), game.hard)));
  const average = charges.length ? charges.reduce((a, b) => a + b, 0) / charges.length : null;
  const best = charges.length ? Math.max(...charges) : null;
  openDialog("Your stats", `${accountLine()}<div class="stat-cards">
    <div class="stat-card"><span>GAMES PLAYED</span><strong>${games.length}</strong></div>
    <div class="stat-card"><span>AVERAGE CHARGE</span><strong>${average === null ? "—" : formatCharge(average)}</strong></div>
    <div class="stat-card"><span>BEST CHARGE</span><strong>${best === null ? "—" : formatCharge(best)}</strong></div>
    <div class="stat-card"><span>CURRENT STREAK</span><strong>${consecutiveStreak(games)} day${consecutiveStreak(games) === 1 ? "" : "s"}</strong></div>
    <div class="stat-card"><span>ENDLESS BEST</span><strong>${state.endless.allTime} round${state.endless.allTime === 1 ? "" : "s"}</strong></div>
    <div class="stat-card"><span>ENDLESS RUNS</span><strong>${state.endless.runs}</strong></div>${state.endless.hardAllTime ? `
    <div class="stat-card"><span>ENDLESS BEST · HARD</span><strong>${state.endless.hardAllTime} round${state.endless.hardAllTime === 1 ? "" : "s"}</strong></div>` : ""}</div>${games.some(game => game.hard) ? `
    <p class="stat-note">Hard games count as the charge the same guesses would leave in regular mode (40% hard counts as 70%).</p>` : ""}
    <h3 class="dialog-subtitle">Recent games</h3>${lastTenGames(games)}
    <h3 class="dialog-title">Past puzzles</h3><p>${isTodayFinished() ? "Replay any of the last 30 daily puzzles." : "Finish today's puzzle to unlock the archive."}</p>
    <div class="archive-list" id="archiveList">${isTodayFinished() ? "<span class='hist-empty'>Loading past puzzles…</span>" : "<span class='hist-empty'>The archive unlocks after today's five questions.</span>"}</div>`);
  bindLastTenGames();
  dialog.querySelector("#logoutButton")?.addEventListener("click", logOut);
  dialog.querySelector("#privacyStatsLink")?.addEventListener("click", () => showPrivacy({ back: showStats }));
  dialog.querySelector("#termsStatsLink")?.addEventListener("click", () => showTerms({ back: showStats }));
  dialog.querySelector("#deleteAccountButton")?.addEventListener("click", showDeleteAccount);
  dialog.querySelector("#statsLoginButton")?.addEventListener("click", () => showLogin());
  if (isTodayFinished()) loadArchive();
}

async function loadArchive() {
  const list = dialog.querySelector("#archiveList");
  try {
    const response = await fetch(`${PUZZLES_URL}/archive`);
    if (!response.ok) throw new Error(`Archive request failed (${response.status}).`);
    const { puzzles } = await response.json();
    list.innerHTML = puzzles.map(puzzle => `<button class="archive-chip" data-archive="${escapeAttr(puzzle.date)}">${puzzle.date} · #${puzzle.number}</button>`).join("") ||
      "<span class='hist-empty'>No earlier puzzles yet. Check back tomorrow.</span>";
  } catch (error) {
    console.error("Could not load the Percentle archive.", error);
    list.innerHTML = "<span class='hist-empty'>Past puzzles couldn't load right now.</span>";
    return;
  }
  list.querySelectorAll("[data-archive]").forEach(button => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const response = await fetch(`${PUZZLES_URL}/${encodeURIComponent(button.dataset.archive)}`);
      const puzzle = await response.json();
      if (!response.ok) throw new Error(puzzle.error || `Puzzle request failed (${response.status}).`);
      currentDate = puzzle.date;
      currentNumber = puzzle.number;
      currentTheme = puzzle.theme || null;
      currentQuestions = withRoundedAnswers(puzzle.questions);
      practiceMode = true;
      dialog.close();
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      console.error("Could not load that Percentle puzzle.", error);
      showToast("That puzzle couldn't load. Try again.");
      button.disabled = false;
    }
  }));
}

// ---------- Endless mode ----------
// Questions this browser has already been asked from a period's bank, so new runs ask fresh ones first.
function endlessSeenKey(startsOn) {
  return `percentle.endlessSeen.${startsOn}`;
}

function markEndlessSeen(question) {
  try {
    const key = endlessSeenKey(endlessBank.startsOn);
    const seen = new Set(JSON.parse(localStorage.getItem(key) || "[]"));
    seen.add(questionKey(question.text));
    localStorage.setItem(key, JSON.stringify([...seen]));
  } catch (error) {
    console.error("Could not save seen endless questions.", error);
  }
}

// Normal and hard-mode endless runs are saved separately, so each mode keeps its own unfinished run.
function endlessKey(startsOn, hard = endlessHard) {
  return `${hard ? "endless-hard" : "endless"}:${startsOn}`;
}

// Starts an endless run (or carries on an unfinished one) from the live bank, in the mode the
// start screen's hard switch is set to.
async function startEndless() {
  let bank;
  try {
    const response = await fetch(`${ENDLESS_URL}/bank`);
    bank = await response.json();
    if (response.status === 404) return showToast("Endless mode is warming up. Check back soon!");
    if (!response.ok) throw new Error(bank.error || `Endless bank request failed (${response.status}).`);
  } catch (error) {
    console.error("Could not load the endless bank.", error);
    return showToast("Endless mode couldn't load. Try again.");
  }
  endlessBank = { startsOn: bank.startsOn, questions: withRoundedAnswers(bank.questions) };
  const byKey = new Map(endlessBank.questions.map(question => [questionKey(question.text), question]));
  const key = endlessKey(bank.startsOn, hardPreferred);
  let run = state.progress[key];
  const finished = run && (run.recorded || run.revealed >= (run.order?.length ?? 0));
  if (!run || finished || !Array.isArray(run.order)) {
    let seen = [];
    try {
      seen = JSON.parse(localStorage.getItem(endlessSeenKey(bank.startsOn)) || "[]");
    } catch {}
    run = state.progress[key] = { guesses: [], locked: [], revealed: 0, draft: null, order: endlessOrder(endlessBank.questions, seen), hard: hardPreferred };
    save();
  }
  // Questions removed from the bank since the run started are skipped.
  currentQuestions = run.order.map(key => byKey.get(key)).filter(Boolean);
  endlessMode = true;
  endlessHard = hardPreferred;
  practiceMode = false;
  currentDate = today;
  currentTheme = null;
  return true;
}

// Whether the endless run just ended (its coins count up on this showing).
let freshRun = false;

// End of a run: rounds survived, personal bests, and how the best compares this period.
function renderEndlessResults() {
  const progress = progressFor();
  const rate = rateOf(progress);
  const out = isOutOfCharge(progress.guesses, currentQuestions, rate);
  const rounds = roundsSurvived(progress.guesses, currentQuestions, rate);
  const period = endlessBank.startsOn;
  // Hard-mode runs keep their own personal bests.
  const bests = endlessHard ? state.endless.hardBest : state.endless.best;
  const previousBest = bests[period] ?? 0;
  if (!progress.recorded) {
    // The run's coins: more the farther it got, up to the day's endless limit (150, or the day's
    // best run if that's more: game.mjs endlessCoins).
    const date = easternDate();
    const coins = endlessCoins(rounds, endlessDay(state.wallet, date));
    const runId = crypto.randomUUID();
    state.wallet.endless[runId] = { date, coins, rounds };
    // For an account, the server checks the run itself (percentle/verify.js): the questions asked,
    // in order, and the guesses. It's kept here until the server has it.
    state.wallet.pending[runId] = {
      date, startsOn: period, hard: endlessHard,
      questions: currentQuestions.slice(0, progress.guesses.length).map(question => questionKey(question.text)),
      guesses: [...progress.guesses]
    };
    const waiting = Object.keys(state.wallet.pending);
    for (const old of waiting.slice(0, Math.max(0, waiting.length - MAX_PENDING_RUNS))) delete state.wallet.pending[old];
    progress.recorded = { rounds, newBest: rounds > previousBest, coins };
    freshRun = true;
    state.endless.runs++;
    sendStat("event", { kind: "endless" });
    bests[period] = Math.max(previousBest, rounds);
    if (endlessHard) state.endless.hardAllTime = Math.max(state.endless.hardAllTime, rounds);
    else state.endless.allTime = Math.max(state.endless.allTime, rounds);
    const supercharged = progress.guesses.filter((guess, i) => pointsOff(guess, currentQuestions[i].answer) === 0).length;
    unlockAchievements(endlessAchievements({ rounds, supercharged }), true);
    save();
  }
  const { newBest } = progress.recorded;
  const best = bests[period];
  const countCoins = freshRun;
  freshRun = false;
  const modeLabel = endlessHard ? " · Hard mode" : "";
  const inHard = endlessHard ? " in hard mode" : "";
  stage.innerHTML = `<div class="final-score dead-score reveal">${coinTotalMarkup(progress.recorded.coins ?? 0)}<div class="result-battery-wrap">${batteryMarkup("result-battery dead-battery", null, 0)}</div>
      <h2 class="out-title">${out ? "Run over" : "Bank cleared"}</h2><p class="out-where">Survived ${rounds} round${rounds === 1 ? "" : "s"}</p>
      <p class="endless-best${newBest ? " new" : ""}">${newBest ? `New personal best${inHard}!` : `Personal best${inHard} this period: ${best}`}</p></div>
    <section class="crowd-panel" id="crowdPanel" aria-live="polite"><h3 class="crowd-title">How you stack up · Endless${modeLabel}</h3><p class="crowd-status">Comparing your best run…</p></section>
    <button class="lock-button" id="againButton">Play again ${INFINITY_ICON}</button>
    <button class="next-button secondary-button" id="shareButton">Share this run ${ICONS.share}</button>
    <button class="next-button secondary-button" id="todayButton">Back to today's puzzle</button>`;
  setCounterLabel("Run over");
  renderRecap(progress);
  countUpCoins(countCoins);
  document.querySelector("#againButton").addEventListener("click", async () => {
    if (await startEndless()) render();
  });
  document.querySelector("#shareButton").addEventListener("click", () => {
    sendStat("event", { kind: "share" });
    const text = `${GAME_NAME} Endless${endlessHard ? " · Hard mode 😈" : ""}\n⚡ Survived ${rounds} round${rounds === 1 ? "" : "s"}${newBest ? " (new best!)" : ""}\n${location.origin}${location.pathname}`;
    if (navigator.share) navigator.share({ text }).catch(error => { if (error.name !== "AbortError") copyResult(text); });
    else copyResult(text);
  });
  document.querySelector("#todayButton").addEventListener("click", returnToToday);
  loadEndlessCrowd(period, best, endlessHard);
  setTimeout(announceAchievements, 1200);
}

// One anonymous ID per period and mode, so a player's best run counts once on each line.
function endlessRunId(startsOn, hard) {
  const key = `percentle.endlessId${hard ? "Hard" : ""}.${startsOn}`;
  let id = readPreference(key);
  if (!id && crypto.randomUUID) {
    id = crypto.randomUUID();
    try {
      localStorage.setItem(key, id);
    } catch {}
  }
  return id;
}

async function loadEndlessCrowd(startsOn, best, hard) {
  const panel = document.querySelector("#crowdPanel");
  const players = hard ? "hard-mode players" : "players";
  try {
    const summary = await crowdRequest(`${ENDLESS_URL}/runs`, { method: "POST", body: { startsOn, id: endlessRunId(startsOn, hard), best, mode: hard ? "hard" : "normal" } });
    const line = summary.betterThan === null
      ? `Once at least ${summary.minimumComparisonPlayers} other ${players} have finished a run this period, you'll see how your best compares.`
      : `Your best run (${best} round${best === 1 ? "" : "s"}) beats <strong>${summary.betterThan.toFixed(1)}%</strong> of ${players} this period.`;
    panel.innerHTML = `<h3 class="crowd-title">How you stack up · Endless${hard ? " · Hard mode" : ""}</h3><p class="crowd-position">${line}</p>`;
    // "Top Charger": the best run beats most of this period's players.
    if (summary.betterThan !== null) {
      unlockAchievements(endlessAchievements({ rounds: best, betterThan: summary.betterThan }), true);
      save();
      announceAchievements();
    }
  } catch (error) {
    console.error("Could not submit the endless run.", error);
    panel.querySelector(".crowd-status").textContent = "The endless comparison is temporarily unavailable.";
  }
}

// Every visit opens on the rules and a button into today's game, rather than straight onto question 1.
function showStartScreen() {
  const label = isTodayFinished() ? "See today's results"
    : (state.progress[today]?.guesses.length ?? 0) > 0 ? "Continue today's game" : "Play today's game";
  document.querySelector("#startButton").innerHTML = `${label} ${ICONS.right}`;
  const day = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  document.querySelector("#startEdition").textContent = `No. ${todayPuzzle.number} · ${day}`;
  const special = document.querySelector("#startSpecial");
  special.hidden = !todayPuzzle.theme;
  special.querySelector("span").textContent = todayPuzzle.theme || "";
  updateHardSwitch();
  updateEndlessButton();
  document.body.classList.add("starting");
}

// Until the first endless bank is big enough, the button shows as "coming soon" and can't be pressed.
async function updateEndlessButton() {
  const button = document.querySelector("#endlessButton");
  try {
    const { live } = await (await fetch(`${ENDLESS_URL}/availability`)).json();
    button.disabled = !live;
    button.classList.toggle("coming-soon", !live);
    button.innerHTML = live ? `Endless mode ${INFINITY_ICON}` : "Endless mode · Coming soon";
  } catch (error) {
    console.error("Could not check whether endless mode is live.", error);
  }
}

// Hard mode turns every green purple.
function applyHardLook() {
  document.body.classList.toggle("hard", isHard());
}

// While today's puzzle is under way the switch is locked to its mode. Before it starts it sets the
// mode for today's puzzle and endless runs; once it's finished it only sets the mode for endless.
function hardSwitchLocked() {
  return Boolean(state.progress[today]?.guesses.length) && !isTodayFinished();
}

function updateHardSwitch() {
  const todays = state.progress[today];
  const locked = hardSwitchLocked();
  const on = locked ? Boolean(todays.hard) : hardPreferred;
  const button = document.querySelector("#hardSwitch");
  button.setAttribute("aria-checked", String(on));
  button.disabled = locked;
  button.title = locked ? "Locked for today's puzzle" : "";
  document.querySelectorAll("[data-drain-rule]").forEach(element => { element.innerHTML = drainRule(drainRateFor(on)); });
  document.body.classList.toggle("hard", on);
}

// Switching modes floods the screen: purple with a black devil going into hard mode, green coming
// back out. The look changes while the screen is covered.
const DEVIL = `<svg class="devil" viewBox="0 0 200 150" aria-hidden="true"><path fill="#000" d="M8,22 L30,30 L38,18 L46,30 L58,20 L62,32 L76,30 L96,54 L70,58 L44,50 L24,38 Z M192,22 L170,30 L162,18 L154,30 L142,20 L138,32 L124,30 L104,54 L130,58 L156,50 L176,38 Z M12,58 L19.3,55.8 L26.7,69 L34,62.5 L41.3,78 L48.7,67.8 L56,85 L63.3,71.8 L70.7,90 L78,74.5 L85.3,93 L92.7,75.8 L100,94 L107.3,75.8 L114.7,93 L122,74.5 L129.3,90 L136.7,71.8 L144,85 L151.3,67.8 L158.7,78 L166,62.5 L173.3,69 L180.7,55.8 L188,58 L188,58 L184.3,70.7 L177,92.8 L169.7,87.6 L162.3,113.9 L155,101.3 L147.7,130.5 L140.3,111.8 L133,142.8 L125.7,119.1 L118.3,150.5 L111,123.1 L103.7,153.9 L96.3,123.9 L89,152.8 L81.7,121.5 L74.3,147.2 L67,115.8 L59.7,137.2 L52.3,107 L45,122.8 L37.7,94.9 L30.3,103.9 L23,79.6 L15.7,80.5 Z"/></svg>`;

function toggleHardMode() {
  if (document.querySelector(".mode-flash") || hardSwitchLocked()) return;
  hardPreferred = !hardPreferred;
  try {
    localStorage.setItem("percentle.hard", hardPreferred ? "1" : "0");
  } catch (error) {
    console.error("Could not save the hard mode setting.", error);
  }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return updateHardSwitch();
  const flash = document.createElement("div");
  flash.className = `mode-flash ${hardPreferred ? "to-hard" : "to-normal"}`;
  flash.setAttribute("aria-hidden", "true");
  flash.innerHTML = hardPreferred ? DEVIL : "";
  flash.addEventListener("animationend", event => {
    if (event.target !== flash) return;
    if (flash.classList.contains("fading")) return flash.remove();
    updateHardSwitch();
    setTimeout(() => flash.classList.add("fading"), hardPreferred ? 650 : 80);
  });
  document.body.append(flash);
}

function leaveStartScreen() {
  document.body.classList.remove("starting");
  if (document.querySelector("#guessInput")) keepBillboardClear();
  // The first question was drawn behind the start screen, so its chance of a plane comes now.
  if (progressFor().guesses.length === viewForProgress(progressFor(), currentQuestions.length).index && !isTodayFinished()) maybeFlyPlane();
}

// Going into a game, the battery charges up from empty (with "CHARGING" above it) and the city's
// lights come on block by block as it fills, since the city runs on the battery.
const CHARGE_UP_MS = 2200;
const CHARGE_UP_DELAY_MS = 180;
function chargeUp() {
  const battery = document.querySelector("#scoreBattery");
  if (document.querySelector("#scoreBox").hidden) return;
  const target = shownScore?.value ?? 100;
  battery.classList.add("charging");
  setBattery(battery, 0);
  const run = (battery.drainRun = (battery.drainRun || 0) + 1);
  setTimeout(() => {
    if (run !== battery.drainRun) return;
    animateBattery(battery, 0, target, CHARGE_UP_MS, easeInOut).then(finished => {
      battery.classList.remove("charging");
      setBattery(battery, target);
      if (finished) city.wave("up");
    });
  }, CHARGE_UP_DELAY_MS);
}

// Pressing Play (or Endless): the start screen fades and lifts away over the dark city, then the
// game rises into place and its battery charges up, lighting the city. No motion when the player
// prefers less.
const START_EXIT_MS = 340;
function enterFromStart(enter) {
  const body = document.body;
  if (body.classList.contains("leaving")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return enter();
  city.setLevel(0); // the city stays dark until the battery starts charging
  body.classList.add("leaving");
  setTimeout(() => {
    enter();
    body.classList.remove("leaving");
    body.classList.add("entering");
    setTimeout(() => body.classList.remove("entering"), 700);
  }, START_EXIT_MS);
}

function showHowToPlay() {
  openDialog("How to play", `<ul class="rules">
      <li>Guess the answer to each of 5 questions, from percentages to prices and ratings.</li>
      <li>${drainRule(rateOf())}</li>
      <li>A new puzzle arrives every day at midnight Eastern.</li>
    </ul>
    <button class="share-button" data-close>Let's play</button>`);
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
}

function openDialog(title, content) {
  document.querySelector("#dialogTitle").textContent = title;
  document.querySelector("#dialogContent").innerHTML = content;
  dialog.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => dialog.close()));
  dialog.showModal();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function escapeAttr(value) { return escapeHtml(value); }

document.querySelector("#howButton").addEventListener("click", showHowToPlay);
document.querySelector("#endlessButton").addEventListener("click", async () => {
  if (!(await startEndless())) return;
  enterFromStart(() => {
    leaveStartScreen();
    window.scrollTo({ top: 0 });
    render();
    chargeUp();
  });
});
document.querySelector("#startButton").addEventListener("click", () => {
  const enterGame = () => {
    leaveStartScreen();
    window.scrollTo({ top: 0 });
    // Coming back to a finished puzzle replays the battery draining to today's charge.
    if (!practiceMode && isTodayFinished()) {
      animateResults = true;
      render();
    } else chargeUp();
  };
  enterFromStart(enterGame);
});

document.querySelector("#statsButton").addEventListener("click", showStats);
document.querySelector("#returnButton").addEventListener("click", () => {
  returnToToday();
  showStats();
});
document.querySelector("#achievementsButton").addEventListener("click", showAchievements);
document.querySelector("#loginButton").addEventListener("click", () => showLogin());
document.querySelector("#marketButton").addEventListener("click", () => showMarket());
// A change still waiting to go to the account goes before the page closes.
window.addEventListener("pagehide", () => { if (accountSyncTimer) syncAccount({ keepalive: true }); });
document.querySelector("#hardSwitch").addEventListener("click", toggleHardMode);
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => dialog.close()));
dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
// Anonymous crowd IDs (and consent flags from older versions) are per-day; drop earlier days' so they can't accumulate.
try {
  for (const key of Object.keys(localStorage)) {
    const match = key.match(/^percentle\.crowd(?:Consent)?\.(\d{4}-\d{2}-\d{2})$/);
    if (match && match[1] !== today) localStorage.removeItem(key);
  }
} catch (error) {
  console.error("Could not clear old Percentle crowd IDs.", error);
}
// A tab left open past midnight Eastern should move on to the new puzzle.
const reloadIfNewDay = () => { if (easternDate() > today) location.reload(); };
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reloadIfNewDay(); });
setInterval(reloadIfNewDay, 60_000);
// Count a finished daily puzzle that a previous version of the page failed to record.
if (state.progress[today]) recordTodayIfComplete(state.progress[today], false);
creditPastAchievements();
save();
render();
showStartScreen();
rememberAccount(account);
applyCosmetics();
// A password-reset email's link: take the token out of the address bar and ask for the new password.
const passwordToken = new URLSearchParams(location.search).get("password-token");
if (passwordToken) {
  const url = new URL(location.href);
  url.searchParams.delete("password-token");
  history.replaceState(null, "", url);
  showResetPassword(passwordToken);
}
loadAccount();
