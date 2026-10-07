import { applyGuessKey, chargeLeft, closeness, crowdRank, dailyTotal, DRAIN_RATE, reactionFor, easternDate, guessEntryFrom, guessEntryText, isOutOfCharge, pointsOff, utcDate, viewForProgress } from "/percentle/game.mjs";

// The game's name everywhere players see it (title, wordmark, start screen, share text).
const GAME_NAME = "Chargle";
// The charge battery's colour as it drains: green while healthy, through yellow and orange, to red.
// Between two stops the colours blend smoothly.
const CHARGE_COLORS = [
  { at: 60, color: "var(--charge)" },
  { at: 40, color: "var(--charge-yellow)" },
  { at: 20, color: "var(--charge-orange)" },
  { at: 5, color: "var(--negative)" }
];
const PUZZLES_URL = "/api/percentle/puzzles";
// v2: puzzles now come from the daily agent, so v1 progress (from the old bank) no longer matches.
const STORAGE_KEY = "percentle.v2";
const stage = document.querySelector("#questionStage");
const dialog = document.querySelector("#infoDialog");
const toast = document.querySelector("#toast");
// Local testing only: http://localhost:3000/percentle.html?reset clears saved progress and stats.
if (location.hostname === "localhost" && new URLSearchParams(location.search).has("reset")) {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  history.replaceState(null, "", location.pathname);
}
const savedTheme = readPreference("percentle.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.theme = savedTheme;
document.title = `${GAME_NAME} — a little game of big percentages`;
document.querySelectorAll("[data-game-name]").forEach(element => {
  element.textContent = element.dataset.gameName === "lower" ? GAME_NAME.toLowerCase() : GAME_NAME;
});
document.querySelector(".wordmark").setAttribute("aria-label", `${GAME_NAME} home`);
document.querySelectorAll("[data-drain-rule]").forEach(element => { element.innerHTML = drainRule(); });

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
    stage.innerHTML = `<p role="alert">Today's puzzle couldn't load. Check your connection and <button id="retryLoad">try again</button>.</p>`;
    document.querySelector("#retryLoad").addEventListener("click", () => location.reload());
  }
  throw error;
}
const today = todayPuzzle.date;
let state = readState();
let currentDate = today;
let currentNumber = todayPuzzle.number;
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
// Running out of charge: the battery above drains to empty, shows "!" and the alarms go off.
// While they're going, the lights flicker (once, a beat, twice quickly) and go out, and the
// out-of-charge screen comes up. The flicker starts POWER_OUT_DELAY_MS after the guess is locked;
// the other two count from the start of the flicker (1.7s long in percentle.css, with the lights
// going out for good 75% of the way through).
const POWER_OUT_DELAY_MS = 3300;
const LIGHTS_OUT_MS = 1275;
const POWER_OUT_MS = 2660;
let powerOutTimer;
let lightsOutTimer;

// Answers always have exactly one decimal place, even if a puzzle was stored with more.
function withRoundedAnswers(questions) {
  return questions.map(question => ({ ...question, answer: Math.round(question.answer * 10) / 10 }));
}

function readState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!Array.isArray(stored.games)) stored.games = [];
    if (!stored.progress || typeof stored.progress !== "object") stored.progress = {};
    for (const progress of Object.values(stored.progress)) {
      if (!Array.isArray(progress.guesses)) progress.guesses = [];
      if (!Array.isArray(progress.locked)) progress.locked = [];
      if (!Number.isInteger(progress.revealed)) progress.revealed = Math.max(0, progress.guesses.length - 1);
      if (progress.draft === undefined) progress.draft = null;
    }
    return stored;
  } catch (error) {
    console.error("Could not read Percentle save data.", error);
    return { games: [], progress: {} };
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    showToast("Your browser couldn't save this game.");
    console.error("Could not save Percentle progress.", error);
  }
}

// The scoring rule in words, kept in step with DRAIN_RATE.
function drainRule() {
  const amount = DRAIN_RATE === 1 ? "" : DRAIN_RATE === 0.5 ? "half of " : `${DRAIN_RATE}× `;
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
  battery.style.setProperty("--fill", chargeColor(charge));
  battery.querySelectorAll(".battery-value").forEach(value => { value.textContent = formatCharge(charge); });
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

// Drains (or fills) a battery from one charge to another, moving the number with it.
function animateBattery(battery, from, to, duration) {
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
      setBattery(battery, Math.round((from + (to - from) * (1 - Math.pow(1 - ratio, 3))) * 10) / 10);
      if (ratio < 1) requestAnimationFrame(tick);
      else resolve(true);
    }
    requestAnimationFrame(tick);
  });
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
  const key = practiceMode ? `practice:${date}` : date;
  if (!state.progress[key]) state.progress[key] = { guesses: [], locked: [], revealed: 0, draft: null };
  return state.progress[key];
}

function isTodayFinished() {
  return (state.progress[today]?.locked.length || 0) === currentQuestions.length ||
    state.games.some(game => game.date === today);
}

function recordTodayIfComplete(progress) {
  const questions = todayPuzzle.questions;
  const finished = progress.guesses.length === questions.length || isOutOfCharge(progress.guesses, questions);
  if (practiceMode || currentDate !== today || !finished || state.games.some(game => game.date === today)) return;
  const score = Number(dailyTotal(progress.guesses, questions.slice(0, progress.guesses.length)).toFixed(1));
  state.games.push({ date: today, score });
  state.games.sort((a, b) => a.date.localeCompare(b.date));
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
}

function renderDots(index) {
  document.querySelector("#progressDots").innerHTML = currentQuestions.map((_, i) =>
    `<span class="progress-dot ${i < index ? "done" : ""} ${i === index ? "current" : ""}"></span>`
  ).join("");
}

function render() {
  const progress = progressFor();
  const out = isOutOfCharge(progress.guesses, currentQuestions);
  const view = viewForProgress(progress, currentQuestions.length, out);
  const index = view.index;
  clearTimeout(powerOutTimer);
  clearTimeout(lightsOutTimer);
  document.body.classList.remove("power-out", "lights-out");
  document.querySelector(".alarm-lights")?.remove();
  // Only shown while replaying an archived puzzle, so players can leave it at any time.
  document.querySelector("#returnButton").hidden = !practiceMode;
  if (practiceMode) leaveStartScreen();
  document.querySelector("#puzzleNumber").textContent = `NO. ${currentNumber}`;
  document.querySelector("#puzzleDate").textContent = currentDate === today ? "TODAY'S EDITION" : `${currentDate} · PRACTICE`;
  renderDots(Math.min(index, 4));
  const animate = justLocked;
  justLocked = false;
  // Reloading part-way through a power-out goes straight to the out-of-charge screen.
  if (view.phase === "reveal" && out && !animate) {
    progress.revealed = progress.guesses.length;
    save();
    return render();
  }
  document.body.classList.toggle("dead", view.phase === "results" && out);
  renderScoreBox(progress, view, animate);
  if (view.phase === "results") {
    renderResults();
    return;
  }
  const question = currentQuestions[index];
  document.querySelector("#questionCounter").textContent = `QUESTION ${String(index + 1).padStart(2, "0")}`;
  const guess = progress.draft ?? 50;
  stage.innerHTML = `
    <div class="question-body">
      <h2 class="question-text">${escapeHtml(question.text)}</h2>
      <div class="hint-row"><p class="question-hint">0-100%</p>${view.phase === "reveal" ? reactionLine(question, progress.guesses[index]) : ""}</div>
      ${view.phase === "reveal" ? reveal(question, progress.guesses[index], index) : guessForm(guess)}
    </div>`;
  if (view.phase === "guess") bindGuessControls(guess, index);
  else {
    playReveal(animate);
    bindNext(index);
  }
}

// The battery above the card shows the charge left so far. It starts full, and each time a guess
// is revealed it drains by that miss (with a "−X%" chip flying off it).
function renderScoreBox(progress, view, animate) {
  const box = document.querySelector("#scoreBox");
  const battery = document.querySelector("#scoreBattery");
  const chip = document.querySelector("#drainChip");
  const note = document.querySelector("#scoreNote");
  const key = `${practiceMode ? "practice" : "daily"}:${currentDate}`;
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
  const charge = chargeLeft(dailyTotal(progress.guesses, currentQuestions.slice(0, locked)));
  const lastOff = pointsOff(progress.guesses[locked - 1], currentQuestions[locked - 1].answer);
  // Blank while answering; "X% off" pops in with each reveal.
  note.textContent = view.phase === "reveal" ? lastOff === 0 ? "Perfect!" : `${lastOff.toFixed(1)}% off` : "";
  note.classList.remove("pop");
  if (animate && view.phase === "reveal") {
    note.getBoundingClientRect();
    note.classList.add("pop");
    if (lastOff > 0) {
      chip.textContent = `−${(lastOff * DRAIN_RATE).toFixed(1)}%`;
      chip.getBoundingClientRect();
      chip.classList.add("fly");
    }
  }
  // The battery never shows below empty.
  const shown = Math.max(0, charge);
  const from = shownScore?.key === key ? shownScore.value : animate ? chargeLeft(dailyTotal(progress.guesses.slice(0, -1), currentQuestions.slice(0, locked - 1))) : shown;
  shownScore = { key, value: shown };
  // Only the reveal of a guess that runs the battery out sounds the alarm, once it has drained to empty.
  const alarm = animate && view.phase === "reveal" && charge < 0;
  animateBattery(battery, from, shown, 1400).then(finished => { if (finished && alarm) soundAlarm(battery); });
}

function soundAlarm(battery) {
  battery.classList.add("alarm");
  if (!document.querySelector(".alarm-lights")) {
    document.body.insertAdjacentHTML("beforeend", '<div class="alarm-lights" aria-hidden="true"><div class="alarm-glow"></div></div>');
  }
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
  const card = document.querySelector("#gameCard");
  const next = document.querySelector("#nextButton");
  card.classList.remove("thud");
  document.querySelector(".reaction")?.classList.add(animate ? "pop" : "shown");
  clearTimeout(nextButtonTimer);
  if (isOutOfCharge(progressFor().guesses, currentQuestions)) {
    next.remove();
    powerOutTimer = setTimeout(powerOut, POWER_OUT_DELAY_MS);
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
    // The card jolts as the "Perfect Answer!" stamp lands.
    if (row.querySelector(".perfect-stamp")) card.classList.add("thud");
  });
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
  document.body.classList.add("power-out");
  lightsOutTimer = setTimeout(() => document.body.classList.add("lights-out"), LIGHTS_OUT_MS);
  powerOutTimer = setTimeout(() => {
    progress.revealed = progress.guesses.length;
    save();
    render();
  }, POWER_OUT_MS);
}

function guessForm(guess) {
  return `<div class="guess-display"><input class="guess-input" id="guessInput" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${Number(guess).toFixed(1)}" aria-label="Your percentage guess, from 0 to 100"><span class="percent-sign">%</span></div>
    <div class="range-wrap"><div class="battery bar-battery" id="guessBattery" style="--level:${guess}"><div class="battery-cell"><span class="battery-fill"></span>${ZAP}
        <input class="battery-range" id="guessRange" type="range" min="0" max="100" step="0.1" value="${guess}" aria-label="Adjust your percentage guess from 0 to 100"></div></div>
      <div class="range-labels"><span>0%</span><span>50%</span><span>100%</span></div></div>
    <button class="lock-button" id="lockButton">Lock in my guess <span aria-hidden="true">→</span></button>`;
}

function bindGuessControls(initial, index) {
  const input = document.querySelector("#guessInput");
  const range = document.querySelector("#guessRange");
  const battery = document.querySelector("#guessBattery");
  let entry = guessEntryFrom(initial);
  const persistDraft = () => {
    battery.style.setProperty("--level", input.value);
    progressFor().draft = Number(input.value);
    save();
  };
  const showEntry = () => {
    input.value = guessEntryText(entry);
    range.value = input.value;
    input.setSelectionRange(input.value.length, input.value.length);
    persistDraft();
  };
  // Handle typing ourselves so the decimal point stays put (see applyGuessKey).
  input.addEventListener("beforeinput", event => {
    event.preventDefault();
    if (event.inputType.startsWith("delete")) entry = applyGuessKey(entry, "Backspace");
    else if (event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") {
      const pasted = Number.parseFloat(event.data ?? event.dataTransfer?.getData("text") ?? "");
      if (Number.isFinite(pasted)) entry = { ...guessEntryFrom(Math.max(0, Math.min(100, pasted))), fresh: false };
    } else for (const key of event.data ?? "") entry = applyGuessKey(entry, key);
    showEntry();
  });
  input.addEventListener("focus", () => {
    entry = { ...entry, fresh: true };
    requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
  });
  range.addEventListener("input", () => {
    entry = guessEntryFrom(range.value);
    input.value = guessEntryText(entry);
    persistDraft();
  });
  document.querySelector("#lockButton").addEventListener("click", () => {
    const value = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) {
      input.setCustomValidity("Enter a number from 0 to 100.");
      input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    const progress = progressFor();
    progress.guesses[index] = Math.round(value * 10) / 10;
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
  input.value = Number(initial).toFixed(1);
}

function reactionLine(question, guess) {
  const reaction = reactionFor(pointsOff(guess, question.answer), `${currentDate}:${question.text}`);
  return reaction ? `<span class="reaction">${escapeHtml(reaction)}</span>` : "";
}

function reveal(question, guess, index) {
  const off = pointsOff(guess, question.answer);
  const guessX = Math.max(0, Math.min(100, guess));
  const answerX = Math.max(0, Math.min(100, question.answer));
  const left = Math.min(guessX, answerX);
  const width = Math.abs(guessX - answerX);
  const answerHigher = question.answer >= guess;
  const arrow = guess === question.answer ? "=" : answerHigher ? "→" : "←";
  const { tone, strength } = closeness(off);
  const guessColor = `color-mix(in oklab, var(--${tone}) ${(strength * 100).toFixed(1)}%, var(--ink))`;
  return `<div class="reveal-row ${answerHigher ? "" : "lower"}" id="revealRow" aria-label="You guessed ${Number(guess).toFixed(1)} percent. The answer is ${question.answer.toFixed(1)} percent, ${off.toFixed(1)} points off.">
      <span class="reveal-num reveal-guess" style="--closeness:${guessColor}">${Number(guess).toFixed(1)}<small>%</small></span>
      <span class="reveal-arrow" aria-hidden="true">${arrow}</span>
      <span class="reveal-num reveal-answer">${question.answer.toFixed(1)}<small>%</small></span>
      ${off === 0 ? '<span class="perfect-stamp" role="status">Perfect Answer!</span>' : ""}
    </div>
    <div class="comparison ${answerHigher ? "too-low" : "too-high"}" data-answer="${answerX}" aria-hidden="true">
      <div class="battery bar-battery" id="revealBattery" style="--level:${guessX}"><div class="battery-cell">
        <span class="drained" style="left:${left}%;width:${width}%"></span><span class="battery-fill"></span>
        <span class="marker guess" style="left:${guessX}%;--closeness:${guessColor}"><span class="marker-caption">YOU</span></span>
        <span class="marker answer" style="left:${answerX}%"><span class="marker-caption">ANSWER</span></span></div></div>
      <div class="range-labels"><span>0%</span><span>50%</span><span>100%</span></div>
    </div>
    <p class="source-note">${escapeHtml(question.funFact)}</p>
    <button class="next-button" id="nextButton">${index === 4 ? "See my charge" : "Next question"} <span aria-hidden="true">→</span></button>`;
}

function bindNext(index) {
  // There's no Next button after a guess that ran the battery out.
  document.querySelector("#nextButton")?.addEventListener("click", () => {
    const progress = progressFor();
    progress.revealed = index + 1;
    save();
    animateResults = progress.revealed === currentQuestions.length;
    render();
  });
}

// Below the card on the results screen: every question with the player's guess, best to worst.
function renderRecap(progress) {
  const recap = document.querySelector("#recap");
  const rows = currentQuestions.slice(0, progress.guesses.length)
    .map((question, index) => ({ question, guess: progress.guesses[index], off: pointsOff(progress.guesses[index], question.answer) }))
    // Ties (e.g. two "Perfect!" scores) go to whichever guess was actually closer.
    .sort((a, b) => a.off - b.off || Math.abs(a.guess - a.question.answer) - Math.abs(b.guess - b.question.answer));
  recap.innerHTML = rows.map(({ question, guess, off }, rank) => {
    const { tone, strength } = closeness(off);
    const color = `color-mix(in oklab, var(--${tone}) ${(strength * 100).toFixed(1)}%, var(--ink))`;
    return `<article class="recap-item${rank === 0 ? " best" : ""}">
      ${rank === 0 ? '<span class="recap-badge">Best guess</span>' : ""}
      <p class="recap-question">${escapeHtml(question.text)}</p>
      <p class="recap-numbers"><span style="color:${color}">You: ${guess.toFixed(1)}%</span><span>Answer: ${question.answer.toFixed(1)}%</span><span class="recap-off">${off === 0 ? "Perfect!" : `${off.toFixed(1)}% off`}</span></p>
    </article>`;
  }).join("") + currentQuestions.slice(progress.guesses.length).map(question => `<article class="recap-item unreached">
      <span class="recap-badge">Not reached</span>
      <p class="recap-question">${escapeHtml(question.text)}</p>
      <p class="recap-numbers"><span>Answer: ${question.answer.toFixed(1)}%</span></p>
    </article>`).join("");
  recap.hidden = false;
}

function renderResults() {
  const progress = progressFor();
  const answered = progress.guesses.length;
  const out = isOutOfCharge(progress.guesses, currentQuestions);
  const score = Number(dailyTotal(progress.guesses, currentQuestions.slice(0, answered)).toFixed(1));
  const charge = chargeLeft(score);
  const animate = animateResults && !out;
  animateResults = false;
  const headline = out
    ? `<div class="final-score dead-score reveal"><div class="result-battery-wrap">${batteryMarkup("result-battery dead-battery", null, 0)}</div>
      <h2 class="out-title">Out of charge</h2><p class="out-where">Died on question ${answered} of ${currentQuestions.length}</p></div>`
    : `<div class="final-score reveal"><span class="answer-label">${currentDate === today ? "" : "PRACTICE "}CHARGE LEFT</span>
      <div class="result-battery-wrap">${batteryMarkup("result-battery", "resultBattery", animate ? 100 : charge)}</div></div>`;
  stage.innerHTML = `${headline}
    ${practiceMode ? "" : `<section class="crowd-panel" id="crowdPanel" aria-live="polite"><h3 class="crowd-title">How you stack up</h3><p class="crowd-copy">Your charge is added anonymously. Never your guesses, name, or account.</p><p class="crowd-status">Seeing how you stack up…</p></section>`}
    <button class="share-button" id="shareButton">Share ${currentDate === today ? "today's" : "this"} result <span aria-hidden="true">↗</span></button>
    ${practiceMode ? '<button class="next-button secondary-button" id="replayButton">Play this puzzle again</button><button class="next-button secondary-button" id="todayButton">Back to today\'s puzzle</button>' : ""}
    <button class="next-button secondary-button" id="statsInline">Your stats &amp; archives <span aria-hidden="true">→</span></button>`;
  document.querySelector("#questionCounter").textContent = out ? "POWER LOST" : "PUZZLE COMPLETE";
  renderDots(out ? answered : 5);
  document.querySelector(".progress-dot.current")?.classList.remove("current");
  renderRecap(progress);
  document.querySelector("#shareButton").addEventListener("click", () => shareResult(score, progress, out));
  document.querySelector("#replayButton")?.addEventListener("click", () => {
    state.progress[`practice:${currentDate}`] = { guesses: [], locked: [], revealed: 0, draft: null };
    save();
    render();
  });
  document.querySelector("#todayButton")?.addEventListener("click", returnToToday);
  document.querySelector("#statsInline").addEventListener("click", showStats);
  if (!practiceMode) loadCrowd(crowdRank(progress.guesses, currentQuestions), out);
  if (!out) playResultDrain(charge, animate);
}

// The final battery drains from 100% to the charge left.
async function playResultDrain(charge, animate) {
  const battery = document.querySelector("#resultBattery");
  if (animate && !(await animateBattery(battery, 100, charge, 2400))) return;
  setBattery(battery, charge);
}

function returnToToday() {
  currentDate = today;
  currentNumber = todayPuzzle.number;
  currentQuestions = todayPuzzle.questions;
  practiceMode = false;
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

async function loadCrowd(score, out) {
  const panel = document.querySelector("#crowdPanel");
  if (!panel) return;
  try {
    const summary = await crowdRequest("/api/percentle/crowd", {
      method: "POST",
      body: { date: today, score, id: crowdToken() }
    });
    if (out) renderOutOfChargeCrowd(panel, summary);
    else renderCrowdSummary(panel, summary);
  } catch (error) {
    console.error("Could not submit anonymous Percentle score.", error);
    panel.querySelector(".crowd-status").innerHTML = `Today's comparison is temporarily unavailable. <button class="crowd-action" id="crowdRetry">Try again</button>`;
    panel.querySelector("#crowdRetry").addEventListener("click", () => loadCrowd(score, out));
  }
}

// After running out of charge, there's no line: just how many other players ran out too.
function renderOutOfChargeCrowd(panel, summary) {
  const share = summary.alsoRanOut;
  const line = share === null
    ? `Once at least ${summary.minimumComparisonPlayers} other players finish today's puzzle, you'll see how many of them ran out of charge.`
    : share === 0 ? "Nobody else has run out of charge today. Yet."
    : `<strong>${share.toFixed(1)}%</strong> of today's players ran out of charge.`;
  panel.innerHTML = `<h3 class="crowd-title">Today's blackouts</h3><p class="crowd-position">${line}</p>`;
}

function renderCrowdSummary(panel, summary) {
  const linePosition = summary.betterThan;
  const placement = summary.betterThan === null
    ? `<p class="crowd-position">Your marker appears once at least ${summary.minimumComparisonPlayers} other players have finished today's puzzle.</p>`
    : `<p class="crowd-position">You were better than <strong>${summary.betterThan.toFixed(1)}%</strong> of players today.</p>`;
  panel.innerHTML = `<h3 class="crowd-title">How you stack up</h3>
    ${crowdLine(linePosition)}${placement}`;
}

function crowdLine(position) {
  const x = position === null ? null : 12 + position / 100 * 276;
  return `<svg class="crowd-line" viewBox="0 0 300 42" role="img" aria-label="${position === null ? "Line from the lowest charge left today to the highest; your position is not available yet." : `Your marker is ${position.toFixed(1)} percent of the way from the lowest charge to the highest.`}">
      <line class="line-axis" x1="12" y1="31" x2="288" y2="31"/>
      ${x === null ? "" : `<circle class="you-marker" cx="${x}" cy="31" r="6"/><text class="you-label" x="${x}" y="13" text-anchor="middle">YOU</text>`}
    </svg>`;
}

function shareResult(score, progress, out) {
  // The real distance of the best guess (even one that scored a perfect 0), e.g. "0.2% away".
  const closest = Math.min(...progress.guesses.map((guess, i) => Math.abs(guess - currentQuestions[i].answer)));
  const status = out ? `🪫 Out of charge on Q${progress.guesses.length}` : `🔋 ${formatCharge(chargeLeft(score))}`;
  const link = `${location.origin}${location.pathname}`;
  const result = `${GAME_NAME} #${currentNumber}\n${status}\nClosest guess - ${closest.toFixed(1)}% away\n${link}`;
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
      <button class="recent-bar${i === recent.length - 1 ? " selected" : ""}" data-date="${escapeAttr(game.date)}" data-charge="${chargeLabel(game.score)}" aria-label="${longDate(game.date)}: ${chargeLabel(game.score)}">
        <span class="recent-bar-fill${chargeLeft(game.score) < 0 ? " negative" : ""}" style="height:${Math.max(4, Math.min(100, chargeLeft(game.score))).toFixed(1)}%"></span>
        <span class="recent-bar-date">${shortDate(game.date)}</span>
      </button>`).join("")}</div>
    <p class="recent-detail" id="recentDetail" aria-live="polite"></p>`;
}

function chargeLabel(score) {
  const charge = chargeLeft(score);
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
    detail.innerHTML = `${longDate(bar.dataset.date)} · <strong>${bar.dataset.charge}</strong>`;
  };
  bars.forEach(bar => bar.addEventListener("click", () => select(bar)));
  if (bars.length) select(bars.at(-1));
}

function showStats() {
  const games = state.games;
  // A game that ran out of charge counts as 0% left.
  const charges = games.map(game => Math.max(0, chargeLeft(game.score)));
  const average = charges.length ? charges.reduce((a, b) => a + b, 0) / charges.length : null;
  const best = charges.length ? Math.max(...charges) : null;
  openDialog("Your stats", `<div class="stat-cards">
    <div class="stat-card"><span>GAMES PLAYED</span><strong>${games.length}</strong></div>
    <div class="stat-card"><span>AVERAGE CHARGE</span><strong>${average === null ? "—" : formatCharge(average)}</strong></div>
    <div class="stat-card"><span>BEST CHARGE</span><strong>${best === null ? "—" : formatCharge(best)}</strong></div>
    <div class="stat-card"><span>CURRENT STREAK</span><strong>${consecutiveStreak(games)} day${consecutiveStreak(games) === 1 ? "" : "s"}</strong></div></div>
    <h3 class="dialog-subtitle">Recent games</h3>${lastTenGames(games)}
    <h3 class="dialog-title">Past puzzles</h3><p>${isTodayFinished() ? "Replay any of the last 30 daily puzzles." : "Finish today's puzzle to unlock the archive."}</p>
    <div class="archive-list" id="archiveList">${isTodayFinished() ? "<span class='hist-empty'>Loading past puzzles…</span>" : "<span class='hist-empty'>The archive unlocks after today's five questions.</span>"}</div>`);
  bindLastTenGames();
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

// Every visit opens on the rules and a button into today's game, rather than straight onto question 1.
function showStartScreen() {
  const label = isTodayFinished() ? "See today's results"
    : (state.progress[today]?.guesses.length ?? 0) > 0 ? "Continue today's game" : "Play today's game";
  document.querySelector("#startButton").innerHTML = `${label} <span aria-hidden="true">→</span>`;
  const day = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  document.querySelector("#startEdition").textContent = `No. ${todayPuzzle.number} · ${day}`;
  document.body.classList.add("starting");
}

function leaveStartScreen() {
  document.body.classList.remove("starting");
}

function showHowToPlay() {
  openDialog("How to play", `<ul class="rules">
      <li>Guess the percentage for each of 5 questions.</li>
      <li>${drainRule()}</li>
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
document.querySelector("#startButton").addEventListener("click", () => {
  const enterGame = () => {
    leaveStartScreen();
    window.scrollTo({ top: 0 });
    // Coming back to a finished puzzle replays the battery draining to today's charge.
    if (!practiceMode && isTodayFinished()) {
      animateResults = true;
      render();
    }
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return enterGame();
  if (document.querySelector(".charge-flash")) return;
  // The whole screen floods with charge until it's solid. Only then does the game swap in
  // underneath, and once it has painted, the glow fades off it, so the switch is never seen.
  const flash = document.createElement("div");
  flash.className = "charge-flash";
  flash.setAttribute("aria-hidden", "true");
  flash.addEventListener("animationend", () => {
    if (flash.classList.contains("fading")) return flash.remove();
    enterGame();
    requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.add("fading")));
  });
  document.body.append(flash);
});
document.querySelector("#statsButton").addEventListener("click", showStats);
document.querySelector("#returnButton").addEventListener("click", () => {
  returnToToday();
  showStats();
});
document.querySelector("#themeButton").addEventListener("click", () => {
  const root = document.documentElement;
  const theme = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = theme;
  try {
    localStorage.setItem("percentle.theme", theme);
  } catch (error) {
    showToast("Your theme setting couldn't be saved.");
    console.error("Could not save Percentle theme preference.", error);
  }
});
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
if (state.progress[today]) {
  recordTodayIfComplete(state.progress[today]);
  save();
}
render();
showStartScreen();
