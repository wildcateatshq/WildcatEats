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

// The score is the battery charge left: it starts at 100% and every point off drains DRAIN_RATE
// of a percent. 0.5 = half (200 points off empties the battery); 1 = full (100 off empties it).
// Games are saved as total points off, so changing this re-scores every past game consistently.
export const DRAIN_RATE = 1;

export function chargeLeft(totalOff, rate = DRAIN_RATE) {
  return Math.round((100 - totalOff * rate) * 10) / 10;
}

// Dropping below zero charge ends the game early. Landing on exactly 0.0% survives.
export function isOutOfCharge(guesses, questions, rate = DRAIN_RATE) {
  return chargeLeft(dailyTotal(guesses, questions.slice(0, guesses.length)), rate) < 0;
}

// The number sent to today's crowd line, where lower ranks better. Players who finished send
// their points off (at most 100 / rate, so keep DRAIN_RATE above 0.25). Players who ran out send
// OUT_OF_CHARGE_RANK plus a little more the earlier they ran out, so they rank below every
// finisher, later deaths rank above earlier ones, and the server (percentle/crowd.js) can count
// who ran out.
export const OUT_OF_CHARGE_RANK = 400;

export function crowdRank(guesses, questions, rate = DRAIN_RATE) {
  const total = dailyTotal(guesses, questions.slice(0, guesses.length));
  if (!isOutOfCharge(guesses, questions, rate)) return Number(total.toFixed(1));
  return OUT_OF_CHARGE_RANK + (questions.length - guesses.length + 1) * 10;
}

// outOfCharge: the locked guesses have drained the battery below zero, so once the last of
// them has been revealed, the game goes straight to results.
export function viewForProgress(progress, questionCount = PUZZLES_PER_DAY, outOfCharge = false) {
  const lockedCount = progress.guesses.length;
  const hasPendingReveal = progress.revealed < lockedCount;
  const index = hasPendingReveal ? progress.revealed : lockedCount;
  if (!hasPendingReveal && (index >= questionCount || outOfCharge)) return { phase: "results", index: questionCount };
  return { phase: hasPendingReveal ? "reveal" : "guess", index };
}

// How "charged" a guess looks: 1 (fully lit) for a guess within the perfect margin, fading
// evenly to 0 (drained) at DRAINED_OFF points off or more. Every tenth of a point moves it a little.
export const DRAINED_OFF = 50;

export function litLevel(off) {
  if (off <= PERFECT_MARGIN) return 1;
  return Math.max(0, 1 - off / DRAINED_OFF);
}

// Short reactions shown after each reveal, from closest to farthest. A guess within the perfect
// margin gets the neon "SUPERCHARGED" instead, so it has no entry here.
export const REACTIONS = [
  { upTo: 3, lines: ["Fantastic!", "So close!", "Incredible!", "What a guess!", "Razor sharp!"] },
  { upTo: 8, lines: ["Great guess!", "Really close!", "Nice one!", "Sharp instincts!", "Well played!"] },
  { upTo: 15, lines: ["Not bad!", "Solid guess!", "In the ballpark!", "Pretty close!", "Good read!"] },
  { upTo: 30, lines: ["Good try!", "Not too far off!", "Decent guess!", "Close-ish!", "Keep it up!"] },
  { upTo: Infinity, lines: ["You'll get it next time!", "Tough one!", "That one was sneaky!", "Shake it off!", "Bounce back!"] }
];

// Picks a reaction for how far off a guess was. The same seed (e.g. the question text) always
// gives the same reaction, so reloading the page doesn't change it.
export function reactionFor(off, seed = "") {
  if (off === 0) return "";
  const { lines } = REACTIONS.find(tier => off <= tier.upTo);
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return lines[hash % lines.length];
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

// Finishing alive on a low battery (this much charge or less) earns a phone-style "Low Battery"
// alert, worded by how close it was.
export const LOW_BATTERY_FINISH = 20;

export function lowBatteryTier(charge) {
  if (charge < 0 || charge > LOW_BATTERY_FINISH) return null;
  if (charge === 0) return "zero";
  if (charge < 1) return "last-drop";
  if (charge < 10) return "clutch";
  return "fumes";
}

// Achievements, in the order they're listed. badge is the short text on the round badge
// ("bolt" draws a lightning bolt instead).
export const ACHIEVEMENTS = [
  { id: "first-charge", name: "First Charge", description: "Finish your first daily puzzle.", badge: "1ST" },
  { id: "supercharged", name: "Supercharged", description: "Get a SUPERCHARGED answer.", badge: "bolt" },
  { id: "double-surge", name: "Double Surge", description: "Get two SUPERCHARGED answers in one puzzle.", badge: "x2" },
  { id: "high-voltage", name: "High Voltage", description: "Finish with 90% charge or more.", badge: "90+" },
  { id: "fully-charged", name: "Fully Charged", description: "Finish with 100% charge.", badge: "100" },
  { id: "fumes", name: "Running on Fumes", description: "Finish with 20% charge or less.", badge: "20" },
  { id: "clutch", name: "Clutch", description: "Finish below 10% charge.", badge: "<10" },
  { id: "last-drop", name: "Last Drop", description: "Finish below 1% charge.", badge: "<1" },
  { id: "still-alive", name: "Still Alive", description: "Finish on exactly 0.0% charge.", badge: "0.0" },
  { id: "blackout", name: "Blackout", description: "Run out of charge.", badge: "!" },
  { id: "week-streak", name: "Week Streak", description: "Play 7 days in a row.", badge: "7", streak: 7 },
  { id: "month-streak", name: "Month Streak", description: "Play 30 days in a row.", badge: "30", streak: 30 }
];

// The achievements one finished daily game earns: its final charge, whether it ran out of
// charge, and how many SUPERCHARGED answers it had.
export function achievementsForGame({ charge, out, supercharged = 0 }) {
  const earned = ["first-charge"];
  if (supercharged >= 1) earned.push("supercharged");
  if (supercharged >= 2) earned.push("double-surge");
  if (out) return [...earned, "blackout"];
  if (charge >= 90) earned.push("high-voltage");
  if (charge >= 100) earned.push("fully-charged");
  if (charge <= LOW_BATTERY_FINISH) earned.push("fumes");
  if (charge < 10) earned.push("clutch");
  if (charge < 1) earned.push("last-drop");
  if (charge === 0) earned.push("still-alive");
  return earned;
}

// The most days in a row with a daily game, from a list of YYYY-MM-DD dates.
export function longestStreak(dates) {
  const days = [...new Set(dates)].sort().map(date => Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  let longest = 0;
  let run = 0;
  days.forEach((day, i) => {
    run = i > 0 && day - days[i - 1] === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  });
  return longest;
}

export function streakAchievements(streak) {
  return ACHIEVEMENTS.filter(achievement => achievement.streak && streak >= achievement.streak).map(achievement => achievement.id);
}
