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

// Hard mode drains twice as fast, so 50 points off in total empties the battery.
export const HARD_DRAIN_RATE = DRAIN_RATE * 2;

export function drainRateFor(hard) {
  return hard ? HARD_DRAIN_RATE : DRAIN_RATE;
}

export function chargeLeft(totalOff, rate = DRAIN_RATE) {
  return Math.round((100 - totalOff * rate) * 10) / 10;
}

// A SUPERCHARGED answer (within the perfect margin) recharges the battery by this much, never
// above 100%.
export const SUPERCHARGE_BONUS = 5;

// The charge after each answered question, in order: a miss drains its points off times the
// rate, and a SUPERCHARGED answer adds SUPERCHARGE_BONUS (capped at 100). Because of the cap the
// order matters, so charge is worked out step by step rather than from the total points off.
export function chargeTrack(guesses, questions, rate = DRAIN_RATE) {
  let charge = 100;
  return guesses.map((guess, i) => {
    const off = pointsOff(guess, questions[i].answer);
    charge = off === 0 ? Math.min(100, charge + SUPERCHARGE_BONUS) : Math.round((charge - off * rate) * 10) / 10;
    return charge;
  });
}

export function finalCharge(guesses, questions, rate = DRAIN_RATE) {
  return chargeTrack(guesses, questions, rate).at(-1) ?? 100;
}

// Dropping below zero charge ends the game early. Landing on exactly 0.0% survives.
export function isOutOfCharge(guesses, questions, rate = DRAIN_RATE) {
  return finalCharge(guesses, questions, rate) < 0;
}

// The number sent to today's crowd line, where lower ranks better. Players who finished send
// the charge they used up (100 minus their final charge, so 0 to 100). Players who ran out send
// OUT_OF_CHARGE_RANK plus a little more the earlier they ran out, so they rank below every
// finisher, later deaths rank above earlier ones, and the server (percentle/crowd.js) can count
// who ran out.
export const OUT_OF_CHARGE_RANK = 400;

export function crowdRank(guesses, questions, rate = DRAIN_RATE) {
  const charge = finalCharge(guesses, questions, rate);
  if (charge >= 0) return Number((100 - charge).toFixed(1));
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

// Achievements, in the order they're listed, grouped into Daily, Hard mode, and Endless. badge is
// the short text on the round badge ("bolt" and "infinity" draw an icon instead).
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
  { id: "month-streak", name: "Month Streak", description: "Play 30 days in a row.", badge: "30", streak: 30 },
  { id: "devils-deal", group: "Hard mode", name: "Devil's Deal", description: "Play a puzzle in hard mode.", badge: "H" },
  { id: "hard-survivor", group: "Hard mode", name: "Hard Survivor", description: "Finish a hard mode puzzle without running out of charge.", badge: "H5" },
  { id: "hellproof", group: "Hard mode", name: "Hellproof", description: "Finish hard mode with 50% charge or more.", badge: "50+" },
  { id: "hard-supercharged", group: "Hard mode", name: "Supercharged in Hell", description: "Get a SUPERCHARGED answer in hard mode.", badge: "bolt" },
  { id: "devils-week", group: "Hard mode", name: "Devil's Week", description: "Play hard mode 7 days in a row.", badge: "7H", hardStreak: 7 },
  { id: "first-run", group: "Endless", name: "First Run", description: "Finish an endless run.", badge: "infinity" },
  { id: "ten-strong", group: "Endless", name: "Ten Strong", description: "Survive 10 rounds in one endless run.", badge: "10" },
  { id: "unplugged", group: "Endless", name: "Unplugged", description: "Survive 25 rounds in one endless run.", badge: "25" },
  { id: "overclocked", group: "Endless", name: "Overclocked", description: "Get 3 SUPERCHARGED answers in one endless run.", badge: "x3" },
  { id: "top-charger", group: "Endless", name: "Top Charger", description: "Have a best endless run that beats 90% of players in its two-week period.", badge: "90%" }
];
for (const achievement of ACHIEVEMENTS) achievement.group ??= "Daily";

// The achievements one finished daily game earns: its final charge, whether it ran out of
// charge, how many SUPERCHARGED answers it had, and whether it was played in hard mode.
export function achievementsForGame({ charge, out, supercharged = 0, hard = false }) {
  const earned = ["first-charge"];
  if (supercharged >= 1) earned.push("supercharged");
  if (supercharged >= 2) earned.push("double-surge");
  if (hard) {
    earned.push("devils-deal");
    if (supercharged >= 1) earned.push("hard-supercharged");
    if (!out) earned.push("hard-survivor");
    if (!out && charge >= 50) earned.push("hellproof");
  }
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

export function streakAchievements(streak, hardStreak = 0) {
  return ACHIEVEMENTS.filter(achievement => (achievement.streak && streak >= achievement.streak) ||
    (achievement.hardStreak && hardStreak >= achievement.hardStreak)).map(achievement => achievement.id);
}

// The achievements one finished endless run earns, and "Top Charger" once the player's best run
// beats this share of players in its period.
export const TOP_CHARGER_PERCENT = 90;

export function endlessAchievements({ rounds, supercharged = 0, betterThan = null }) {
  const earned = ["first-run"];
  if (rounds >= 10) earned.push("ten-strong");
  if (rounds >= 25) earned.push("unplugged");
  if (supercharged >= 3) earned.push("overclocked");
  if (betterThan !== null && betterThan >= TOP_CHARGER_PERCENT) earned.push("top-charger");
  return earned;
}

// Which answered question was the player's best guess: the fewest points off, with ties (e.g.
// two SUPERCHARGED answers) going to the guess that was actually closer, then the earlier one.
export function bestGuessIndex(guesses, questions) {
  let best = 0;
  guesses.forEach((guess, i) => {
    const off = pointsOff(guess, questions[i].answer);
    const bestOff = pointsOff(guesses[best], questions[best].answer);
    const closer = Math.abs(guess - questions[i].answer) < Math.abs(guesses[best] - questions[best].answer);
    if (off < bestOff || (off === bestOff && closer)) best = i;
  });
  return best;
}

// Endless mode: a short, stable key for a question (so a player's seen questions survive the bank
// changing order), the order to ask a bank's questions in (unseen ones first, each group shuffled),
// and how many rounds a run survived (the question that ran the battery out doesn't count).
export function questionKey(text) {
  let hash = 5381;
  for (const character of text.toLowerCase()) hash = ((hash * 33) ^ character.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

export function endlessOrder(questions, seenKeys, random = Math.random) {
  const shuffle = items => {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };
  const seen = new Set(seenKeys);
  const keys = questions.map(question => questionKey(question.text));
  return [...shuffle(keys.filter(key => !seen.has(key))), ...shuffle(keys.filter(key => seen.has(key)))];
}

export function roundsSurvived(guesses, questions, rate = DRAIN_RATE) {
  return isOutOfCharge(guesses, questions, rate) ? guesses.length - 1 : guesses.length;
}

// Endless mode's clock: a run starts at 9 PM and every round moves time on an hour, so a long run
// reaches morning (round 9), noon (round 15), and sunset, where night 2 starts (round 21).
export const ENDLESS_START_HOUR = 21;
export const ENDLESS_MINUTES_PER_ROUND = 60;

export function endlessClock(round) {
  const total = ENDLESS_START_HOUR + (round * ENDLESS_MINUTES_PER_ROUND) / 60;
  const hour = total % 24;
  const daysPassed = Math.floor(total / 24);
  const isNight = hour >= 18 || hour < 6;
  const count = isNight ? (hour >= 18 ? daysPassed + 1 : daysPassed) : daysPassed;
  const minutes = Math.round((hour % 1) * 60);
  const shown = Math.floor(hour) % 12 || 12;
  const time = `${shown}:${String(minutes).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  return { hour, time, label: `${isNight ? "Night" : "Day"} ${count}` };
}

// Weather on the city (rain, snow or fog): one roll per day, seeded by the date so everyone sees the
// same sky all day, with odds that suit the season. Never rain in winter, never snow in summer.
//   [snow, rain, fog] chances by month (January = 1).
const WEATHER_ODDS = {
  12: [0.3, 0, 0.1], 1: [0.3, 0, 0.1], 2: [0.3, 0, 0.1],
  3: [0.05, 0.3, 0.1], 4: [0, 0.3, 0.1], 5: [0, 0.3, 0.1],
  6: [0, 0.2, 0.03], 7: [0, 0.2, 0.03], 8: [0, 0.2, 0.03],
  9: [0, 0.22, 0.15], 10: [0, 0.22, 0.15], 11: [0.05, 0.22, 0.15]
};
export function weatherForDay(date) {
  // A steady number from 0 to 1 for the date, so a day's weather never changes.
  let hash = 2166136261;
  for (const char of `weather:${date}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  // Scramble it (MurmurHash3's finalizer) so neighbouring dates don't get similar rolls.
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16;
  let roll = (hash >>> 0) / 4294967296;
  const [snow, rain, fog] = WEATHER_ODDS[Number(date.slice(5, 7))];
  for (const [kind, chance] of [["snow", snow], ["rain", rain], ["fog", fog]]) {
    if ((roll -= chance) < 0) return kind;
  }
  return null;
}
