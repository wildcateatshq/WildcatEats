export const PUZZLES_PER_DAY = 5;

// Guesses within this many points of the answer (either side, inclusive) score a perfect 0.
export const PERFECT_MARGIN = 0.5;

export function pointsOff(guess, answer) {
  if (!Number.isFinite(guess) || !Number.isFinite(answer) || guess < 0 || guess > 100 || answer < 0 || answer > 100) {
    throw new RangeError("Guess and answer must be numbers between 0 and 100.");
  }
  // Rounded to tenths so floating-point noise (16.5 - 16 = 0.5000000001) can't push a guess outside the margin.
  const difference = Math.round(Math.abs(guess - answer) * 10) / 10;
  return difference <= PERFECT_MARGIN ? 0 : difference;
}

export function dailyTotal(guesses, questions) {
  if (guesses.length !== questions.length) throw new RangeError("Every question needs one locked guess.");
  return guesses.reduce((total, guess, index) => total + pointsOff(guess, questions[index].answer), 0);
}

export function viewForProgress(progress, questionCount = PUZZLES_PER_DAY) {
  const lockedCount = progress.guesses.length;
  const hasPendingReveal = progress.revealed < lockedCount;
  const index = hasPendingReveal ? progress.revealed : lockedCount;
  if (!hasPendingReveal && index >= questionCount) return { phase: "results", index: questionCount };
  return { phase: hasPendingReveal ? "reveal" : "guess", index };
}

export function scoreColor(points) {
  if (points <= 5) return "green";
  if (points <= 15) return "yellow";
  if (points <= 30) return "orange";
  return "red";
}

export function utcDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Calendar date in New York (EST/EDT); daily puzzles roll over at midnight Eastern.
export function easternDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Typed guesses keep a fixed decimal point: up to two whole digits, then the tenths digit.
// Typing "4", "2", "5" gives 42.5; "." jumps to the tenths early ("7", ".", "5" gives 7.5).
// The first digit after focusing or dragging replaces the current value.
export function guessEntryFrom(value) {
  const [whole, tenth] = Number(value).toFixed(1).split(".");
  return { whole, tenth, inTenths: true, fresh: true };
}

export function applyGuessKey(entry, key) {
  let { whole, tenth, inTenths } = entry;
  const isDigit = /^\d$/.test(key);
  if (entry.fresh && (isDigit || key === "." || key === ",")) {
    whole = "";
    tenth = "";
    inTenths = false;
  }
  if (isDigit) {
    if (inTenths) tenth = key;
    else {
      whole = whole === "0" ? key : whole + key;
      if (whole.length >= 2) inTenths = true;
    }
  } else if (key === "." || key === ",") {
    inTenths = true;
  } else if (key === "Backspace") {
    if (inTenths && tenth) tenth = "";
    else {
      inTenths = false;
      whole = whole.slice(0, -1);
    }
  }
  return { whole, tenth, inTenths, fresh: false };
}

export function guessEntryText(entry) {
  return `${entry.whole || "0"}.${entry.tenth || "0"}`;
}
