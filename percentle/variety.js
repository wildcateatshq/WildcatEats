"use strict";

// Keeps the agent's questions varied. The agent is asked not to repeat itself, but it can't reliably
// spot "the same stat, worded differently" in hundreds of past questions, and it drifts toward the
// kinds of questions that are quickest to check. These checks run on the server whenever it
// publishes a daily puzzle or adds to an endless bank, and turn those habits into rejections it has
// to fix:
//   - too similar to an earlier question (same stat, maybe a different season or wording);
//   - the same question shape over and over ("what percentage of [player]'s points came from free
//     throws?" with a new player each time);
//   - the same team, person, film, or place again too soon;
//   - one category crowding out the others.

const STOPWORDS = new Set(`a an the of in on at to for by and or but nor what which who whom whose how
percentage percent share was were is are be been being did do does done had has have his her hers
their theirs its it they them he she him this that these those as from with into onto than then per
about all any each every through during after before over under up down out off own same so such
there here when where while whether if also only just more most less least very s t one ever made
make said says say`.split(/\s+/));

// Words that don't make two questions "about the same thing" on their own: a name made only of
// these is skipped ("U.S.", "Billboard Hot 100", "Pew Research Center"), though "World Series" counts.
const GENERIC_NAME_WORDS = new Set(`us usa dc united states america american americans earth earth's world
nba nfl mlb nhl wnba ncaa division i ii iii mvp census bureau billboard hot spotify gallup pew research
center canada`.split(/\s+/));
// Words trimmed from either end of a name: "of October" is no name at all.
const NAME_EDGE_WORDS = new Set(`the of no a an january february march april may june july august september
october november december monday tuesday wednesday thursday friday saturday sunday`.split(/\s+/));

// Two questions are repeats when they're the same shape of question (SAME_SHAPE) about the same
// team, person, film, or place, or the same shape with no names at all ("what percentage of U.S.
// adults said they drink alcohol?" in two different years). The same shape about different subjects
// isn't a repeat, but too many of those are limited separately.
const SAME_SHAPE = 0.75;

// A rough stem, so "lives", "lived" and "live" (or "games" and "game") count as the same word.
function stem(word) {
  let base = word.length > 5 && word.endsWith("ing") ? word.slice(0, -3)
    : word.length > 4 && word.endsWith("ed") ? word.slice(0, -2)
    : word.length > 4 && word.endsWith("ies") ? `${word.slice(0, -3)}y`
    : word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1)
    : word;
  if (base.length > 3 && base.endsWith("e")) base = base.slice(0, -1);
  return base;
}

function words(text) {
  return text.toLowerCase().replace(/[’`]/g, "'").replace(/'s\b/g, "")
    .split(/[^\p{L}\p{N}'-]+/u).map(word => word.replace(/^['-]+|['-]+$/g, ""))
    .filter(word => word && !STOPWORDS.has(word)).map(stem);
}

// Proper names in a question: runs of capitalized words, not counting the question's first word.
// "Shai Gilgeous-Alexander's" becomes "shai gilgeous-alexander".
function names(text) {
  const found = new Set();
  const pattern = /\p{Lu}[\p{L}.'’&-]*(?:\s+(?:of\s+|the\s+|de\s+|la\s+)?\p{Lu}[\p{L}.'’&-]*)*/gu;
  for (const match of text.matchAll(pattern)) {
    if (match.index === 0) {
      // The opening word ("What", "In") is capitalized because it starts the sentence; keep the rest.
      const rest = match[0].split(/\s+/).slice(1).join(" ");
      if (!rest) continue;
      match[0] = rest;
    }
    // "Pew Research Center's July" is two names, split at the possessive.
    for (const piece of match[0].toLowerCase().replace(/[’]/g, "'").replace(/\./g, "").split(/'s(?:\s+|$)/)) {
      const parts = piece.replace(/,+$/, "").split(/\s+/).filter(Boolean);
      while (parts.length && NAME_EDGE_WORDS.has(parts[0])) parts.shift();
      while (parts.length && NAME_EDGE_WORDS.has(parts.at(-1))) parts.pop();
      if (parts.some(part => !GENERIC_NAME_WORDS.has(part))) found.add(parts.join(" "));
    }
  }
  return [...found];
}

// A question's shape: its words with names, years, and numbers taken out, so "what percentage of
// Jokić's points came from free throws in 2024–25?" and the same about Curry in 2022–23 match.
function shape(text) {
  let masked = text.replace(/[’]/g, "'").replace(/\./g, ""); // names are kept without their dots
  for (const name of names(text)) masked = masked.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  return words(masked.replace(/\d[\d.,–-]*/g, " "));
}

// Dice similarity of two word lists: 1 for the same words, 0 for none in common.
function likeness(a, b) {
  const left = new Set(a), right = new Set(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return (2 * shared) / (left.size + right.size);
}

function profile(question) {
  const text = typeof question === "string" ? question : question.text;
  return { text, category: question.category, words: words(text), shape: shape(text), names: names(text) };
}

const short = text => (text.length > 90 ? `${text.slice(0, 87)}...` : text);

// The problems with one question against earlier ones. `earlier` are profiles of questions to
// compare with; `rules` say which checks apply and their limits.
function problemsWith(candidate, earlier, rules) {
  const problems = [];
  const similar = earlier.find(other => likeness(candidate.shape, other.shape) >= SAME_SHAPE &&
    (candidate.names.some(name => other.names.includes(name)) || (!candidate.names.length && !other.names.length)));
  if (similar) problems.push(`too similar to an earlier question ("${short(similar.text)}"); ask about something else`);
  if (rules.maxSameShape !== undefined) {
    const sameShape = earlier.filter(other => likeness(candidate.shape, other.shape) >= SAME_SHAPE);
    if (sameShape.length >= rules.maxSameShape) {
      problems.push(`the same kind of question has been asked ${sameShape.length} times ${rules.where} (for example "${short(sameShape[0].text)}"); use a different kind of question`);
    }
  }
  if (rules.maxSameName !== undefined) {
    for (const name of candidate.names) {
      const count = earlier.filter(other => other.names.includes(name)).length;
      if (count >= rules.maxSameName) problems.push(`"${name}" already appears ${count} time${count === 1 ? "" : "s"} ${rules.where}; pick a different subject`);
    }
  }
  return problems;
}

// Category caps for an endless bank, as a share of the bank: room to lean a little past each
// category's target (35% Sports, 25% U.S. life, 25% World, 8% Movies, 7% Music), but no further.
const BANK_CATEGORY_CAPS = { Sports: 0.38, "U.S. life": 0.3, World: 0.3, Movies: 0.12, Music: 0.11 };
const BANK_CAP_FLOOR = 60; // caps are measured against at least this many questions, so a young bank can start anywhere
const BANK_MAX_SAME_SHAPE = 6;
const BANK_MAX_SAME_NAME = 3;
const DAILY_WINDOW_DAYS = 14;
const DAILY_MAX_PER_CATEGORY = 2;

// Checks a batch for an endless bank. `bank` is the bank's current questions, `others` are every
// other question to avoid repeating (the other banks and the daily puzzles). Returns the questions
// that pass and, for the rest, why not. Questions in the batch count against each other too.
function checkBankBatch(batch, { bank = [], others = [] } = {}) {
  const inBank = bank.map(profile);
  const elsewhere = others.map(profile);
  const counts = {};
  for (const question of inBank) counts[question.category] = (counts[question.category] || 0) + 1;
  const accepted = [], rejected = [];
  for (const question of batch) {
    const candidate = profile(question);
    const problems = [
      ...problemsWith(candidate, inBank, { maxSameShape: BANK_MAX_SAME_SHAPE, maxSameName: BANK_MAX_SAME_NAME, where: "in this bank" }),
      ...problemsWith(candidate, elsewhere, { where: "elsewhere" })
    ];
    const cap = BANK_CATEGORY_CAPS[candidate.category];
    if (cap !== undefined) {
      const total = inBank.length + 1;
      const allowed = Math.ceil(cap * Math.max(total, BANK_CAP_FLOOR));
      if ((counts[candidate.category] || 0) + 1 > allowed) {
        problems.push(`${candidate.category} already has ${counts[candidate.category]} of this bank's ${inBank.length} questions, its most for now; write a question in another category`);
      }
    }
    if (problems.length) {
      rejected.push({ text: question.text, problems });
      continue;
    }
    accepted.push(question);
    inBank.push(candidate);
    counts[candidate.category] = (counts[candidate.category] || 0) + 1;
  }
  return { accepted, rejected };
}

// Checks a daily puzzle. `nearby` are the questions of puzzles within two weeks of its date (not the
// date itself, which is being replaced); `others` are every other question to avoid repeating (older
// puzzles and the endless banks). A special (a themed day) may repeat its event's teams and shapes.
// Returns a list of problems, empty when the puzzle is fine.
function checkPuzzle(questions, { nearby = [], others = [], special = false } = {}) {
  const near = nearby.map(profile);
  const far = others.map(profile);
  const problems = [];
  const counts = {};
  const seen = [];
  questions.forEach((question, index) => {
    const candidate = profile(question);
    const issues = [
      ...problemsWith(candidate, near, special ? { where: "" } : { maxSameShape: 1, maxSameName: 1, where: `within ${DAILY_WINDOW_DAYS} days of this puzzle` }),
      ...problemsWith(candidate, far, { where: "" }),
      ...problemsWith(candidate, seen, special ? { where: "" } : { maxSameShape: 1, maxSameName: 1, where: "in this puzzle" })
    ];
    counts[candidate.category] = (counts[candidate.category] || 0) + 1;
    if (!special && counts[candidate.category] === DAILY_MAX_PER_CATEGORY + 1) {
      issues.push(`a puzzle can have at most ${DAILY_MAX_PER_CATEGORY} ${candidate.category} questions`);
    }
    seen.push(candidate);
    for (const issue of new Set(issues)) problems.push(`Question ${index + 1}: ${issue}.`);
  });
  return problems;
}

module.exports = {
  BANK_CATEGORY_CAPS, BANK_MAX_SAME_NAME, BANK_MAX_SAME_SHAPE, DAILY_MAX_PER_CATEGORY, DAILY_WINDOW_DAYS,
  checkBankBatch, checkPuzzle, likeness, names, shape, words
};
