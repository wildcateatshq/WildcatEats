import { applyGuessKey, closeness, dailyTotal, reactionFor, easternDate, guessEntryFrom, guessEntryText, pointsOff, scoreColor, utcDate, viewForProgress } from "/percentle/game.mjs";

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
let countUpRun = 0;

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
  if (currentDate !== today || progress.locked.length !== todayPuzzle.length || state.games.some(game => game.date === today)) return;
  const score = Number(dailyTotal(progress.guesses, todayPuzzle).toFixed(1));
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
  const view = viewForProgress(progress, currentQuestions.length);
  const index = view.index;
  document.querySelector("#puzzleNumber").textContent = `NO. ${currentNumber}`;
  document.querySelector("#puzzleDate").textContent = currentDate === today ? "TODAY'S EDITION" : `${currentDate} · PRACTICE`;
  renderDots(Math.min(index, 4));
  const animate = justLocked;
  justLocked = false;
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

// The box above the card shows the running total (points off so far). It stays empty until the
// first answer, then counts up to the new total each time a guess is revealed.
function renderScoreBox(progress, view, animate) {
  const box = document.querySelector("#scoreBox");
  const value = document.querySelector("#scoreValue");
  const note = document.querySelector("#scoreNote");
  const key = `${practiceMode ? "practice" : "daily"}:${currentDate}`;
  const locked = progress.guesses.length;
  if (!locked) {
    box.classList.remove("active");
    shownScore = { key, value: 0 };
    value.textContent = "0.0";
    note.textContent = "";
    return;
  }
  const total = Number(dailyTotal(progress.guesses, currentQuestions.slice(0, locked)).toFixed(1));
  const lastOff = pointsOff(progress.guesses[locked - 1], currentQuestions[locked - 1].answer);
  box.classList.add("active");
  // Blank while answering; "You were X pts off" pops in with each reveal.
  note.textContent = view.phase === "reveal"
    ? lastOff === 0 ? "Perfect!" : `${lastOff.toFixed(1)}% off`
    : view.phase === "results" ? "Final score · lower is better" : "";
  note.classList.remove("pop");
  if (animate && view.phase === "reveal") {
    note.getBoundingClientRect();
    note.classList.add("pop");
  }
  const from = shownScore?.key === key ? shownScore.value : animate ? total - lastOff : total;
  shownScore = { key, value: total };
  countUp(value, from, total);
}

function countUp(element, from, to) {
  const run = ++countUpRun;
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.textContent = to.toFixed(1);
    return;
  }
  const start = performance.now();
  function tick(now) {
    if (run !== countUpRun) return;
    const ratio = Math.min(1, (now - start) / 1400);
    element.textContent = (from + (to - from) * (1 - Math.pow(1 - ratio, 3))).toFixed(1);
    if (ratio < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Slides the guess sideways away from the answer, then fades in the arrow and the real answer,
// while the line on the track grows from the guess dot to the answer dot.
function playReveal(animate) {
  const row = document.querySelector("#revealRow");
  const comparison = document.querySelector(".comparison");
  const card = document.querySelector("#gameCard");
  card.classList.remove("thud");
  document.querySelector(".reaction")?.classList.add(animate ? "pop" : "shown");
  if (!animate) {
    row.classList.add("instant", "go");
    comparison.classList.add("instant", "answered");
    return;
  }
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
    // The card jolts as the "Perfect Answer!" stamp lands.
    if (row.querySelector(".perfect-stamp")) card.classList.add("thud");
  });
}

function guessForm(guess) {
  return `<div class="guess-display"><input class="guess-input" id="guessInput" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${Number(guess).toFixed(1)}" aria-label="Your percentage guess, from 0 to 100"><span class="percent-sign">%</span></div>
    <div class="range-wrap"><input id="guessRange" type="range" min="0" max="100" step="0.1" value="${guess}" aria-label="Adjust your percentage guess from 0 to 100"><div class="range-labels"><span>0%</span><span>50%</span><span>100%</span></div></div>
    <button class="lock-button" id="lockButton">Lock in my guess <span aria-hidden="true">→</span></button>`;
}

function bindGuessControls(initial, index) {
  const input = document.querySelector("#guessInput");
  const range = document.querySelector("#guessRange");
  let entry = guessEntryFrom(initial);
  const persistDraft = () => {
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
    <div class="comparison" aria-hidden="true">
      <div class="compare-track"><div class="compare-gap" style="left:${left}%;width:${width}%;transform-origin:${answerHigher ? "left" : "right"}"></div>
        <span class="marker guess" style="left:${guessX}%;--closeness:${guessColor}"><span class="marker-caption">YOU</span></span>
        <span class="marker answer" style="left:${answerX}%"><span class="marker-caption">ANSWER</span></span></div>
      <div class="range-labels"><span>0%</span><span>50%</span><span>100%</span></div>
    </div>
    <p class="source-note">${escapeHtml(question.funFact)}</p>
    <button class="next-button" id="nextButton">${index === 4 ? "See my score" : "Next question"} <span aria-hidden="true">→</span></button>`;
}

function bindNext(index) {
  document.querySelector("#nextButton").addEventListener("click", () => {
    const progress = progressFor();
    progress.revealed = index + 1;
    save();
    render();
  });
}

function renderResults() {
  const progress = progressFor();
  const score = Number(dailyTotal(progress.guesses, currentQuestions).toFixed(1));
  stage.innerHTML = `<div class="final-score reveal"><span class="answer-label">YOUR ${currentDate === today ? "DAILY" : "PRACTICE"} SCORE</span><div class="score-number">${score.toFixed(1)}</div><p>The lower, the lovelier. Here's how each guess landed.</p></div>
    ${practiceMode ? "" : `<section class="crowd-panel" id="crowdPanel" aria-live="polite"><h3 class="crowd-title">Today's score line</h3><p class="crowd-copy">Your total is added anonymously. Never your guesses, name, or account.</p><p class="crowd-status">Placing you on today's score line…</p></section>`}
    <button class="share-button" id="shareButton">Share ${currentDate === today ? "today's" : "this"} result <span aria-hidden="true">↗</span></button>
    ${practiceMode ? '<button class="next-button" id="replayButton" style="margin-top:9px;background:var(--paper);color:var(--ink)">Play this puzzle again</button><button class="next-button" id="todayButton" style="margin-top:9px;background:var(--paper);color:var(--ink)">Back to today\'s puzzle</button>' : ""}
    <button class="next-button" id="statsInline" style="margin-top:9px;background:var(--paper);color:var(--ink)">Your stats <span aria-hidden="true">→</span></button>`;
  document.querySelector("#questionCounter").textContent = "PUZZLE COMPLETE";
  renderDots(5);
  document.querySelector("#shareButton").addEventListener("click", () => shareResult(score, progress));
  document.querySelector("#replayButton")?.addEventListener("click", () => {
    state.progress[`practice:${currentDate}`] = { guesses: [], locked: [], revealed: 0, draft: null };
    save();
    render();
  });
  document.querySelector("#todayButton")?.addEventListener("click", returnToToday);
  document.querySelector("#statsInline").addEventListener("click", showStats);
  if (!practiceMode) loadCrowd(score);
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

async function loadCrowd(score) {
  const panel = document.querySelector("#crowdPanel");
  if (!panel) return;
  try {
    const summary = await crowdRequest("/api/percentle/crowd", {
      method: "POST",
      body: { date: today, score, id: crowdToken() }
    });
    renderCrowdSummary(panel, summary);
  } catch (error) {
    console.error("Could not submit anonymous Percentle score.", error);
    panel.querySelector(".crowd-status").innerHTML = `Today's score line is temporarily unavailable. <button class="crowd-action" id="crowdRetry">Try again</button>`;
    panel.querySelector("#crowdRetry").addEventListener("click", () => loadCrowd(score));
  }
}

function renderCrowdSummary(panel, summary) {
  const linePosition = summary.betterThan === null ? null : 100 - summary.betterThan;
  const placement = summary.betterThan === null
    ? `<p class="crowd-position">Your marker appears once at least ${summary.minimumComparisonPlayers} other players have finished today's puzzle.</p>`
    : `<p class="crowd-position">You were better than <strong>${summary.betterThan.toFixed(1)}%</strong> of players today.</p>`;
  panel.innerHTML = `<h3 class="crowd-title">Where you sit on today's line</h3>
    ${crowdLine(linePosition)}${placement}`;
}

function crowdLine(position) {
  const x = position === null ? null : 12 + position / 100 * 276;
  return `<svg class="crowd-line" viewBox="0 0 300 64" role="img" aria-label="${position === null ? "Line from best daily scores to worst daily scores; your position is not available yet." : `Your marker is ${position.toFixed(1)} percent of the way from best to worst.`}">
      <line class="line-axis" x1="12" y1="31" x2="288" y2="31"/>
      ${x === null ? "" : `<circle class="you-marker" cx="${x}" cy="31" r="6"/><text class="you-label" x="${x}" y="13" text-anchor="middle">YOU</text>`}
      <text x="12" y="55" text-anchor="start">BEST</text><text x="288" y="55" text-anchor="end">WORST</text>
    </svg>`;
}

function shareResult(score, progress) {
  const squares = currentQuestions.map((question, i) => {
    const color = scoreColor(pointsOff(progress.guesses[i], question.answer));
    return { green: "🟩", yellow: "🟨", orange: "🟧", red: "🟥" }[color];
  }).join("");
  const result = `Percentle #${currentNumber}\nScore: ${score.toFixed(1)}\n${squares}`;
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

function showStats() {
  const games = state.games;
  const scores = games.map(game => game.score);
  const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const best = scores.length ? Math.min(...scores) : null;
  const bins = Array.from({ length: 10 }, (_, i) => scores.filter(score => Math.min(9, Math.floor(score / 50)) === i).length);
  const maxBin = Math.max(1, ...bins);
  openDialog("Your stats", `<div class="stat-cards">
    <div class="stat-card"><span>GAMES PLAYED</span><strong>${games.length}</strong></div>
    <div class="stat-card"><span>AVERAGE SCORE</span><strong>${average === null ? "—" : average.toFixed(1)}</strong></div>
    <div class="stat-card"><span>BEST SCORE</span><strong>${best === null ? "—" : best.toFixed(1)}</strong></div>
    <div class="stat-card"><span>CURRENT STREAK</span><strong>${consecutiveStreak(games)} day${consecutiveStreak(games) === 1 ? "" : "s"}</strong></div></div>
    <p>Score history · 0–500 points</p>${games.length ? `<div class="histogram" role="img" aria-label="Score histogram with scores grouped in 50-point ranges">${bins.map((count, i) => `<span class="hist-bar ${i === Math.min(9, Math.floor((games.at(-1)?.score || 0) / 50)) ? "today" : ""}" style="height:${Math.max(4, count / maxBin * 74)}%" title="${i * 50}–${(i + 1) * 50}: ${count} games"></span>`).join("")}</div><p>Your ${games.length} game${games.length === 1 ? "" : "s"}, grouped into 50-point score ranges. Your latest is highlighted.</p>` : `<p class="hist-empty">Finish today's puzzle to start your score history.</p>`}
    <h3 class="dialog-title">Past puzzles</h3><p>${isTodayFinished() ? "Replay any of the last 30 daily puzzles." : "Finish today's puzzle to unlock the archive."}</p>
    <div class="archive-list" id="archiveList">${isTodayFinished() ? "<span class='hist-empty'>Loading past puzzles…</span>" : "<span class='hist-empty'>The archive unlocks after today's five questions.</span>"}</div>`);
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

function showHowToPlay() {
  openDialog("How to play", `<ul class="rules">
      <li>Guess the percentage for each of 5 questions.</li>
      <li>Your score is how far off you were, added up. <strong>Lower is better</strong>, and within 0.5 counts as perfect.</li>
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
document.querySelector("#statsButton").addEventListener("click", showStats);
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
render();
if (!readPreference("percentle.seenHow")) {
  showHowToPlay();
  try {
    localStorage.setItem("percentle.seenHow", "1");
  } catch (error) {
    console.error("Could not save the first-visit preference.", error);
  }
}
