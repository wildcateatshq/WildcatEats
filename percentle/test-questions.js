"use strict";

// Made-up questions for tests that are all different from one another, so the variety checks
// (variety.js) don't turn them away as repeats: question n pairs an adjective and a noun that no
// other question below 676 shares.
const ADJECTIVES = "amber brisk coral dusty eager fuzzy gentle hollow icy jolly kind lunar misty noble olive plush quiet rusty sandy tidy upbeat vivid windy young zesty bold".split(" ");
const NOUNS = "anchors barrels candles drums engines fences gloves hammers islands jackets kettles ladders magnets nests oars pianos quilts rafts saddles tents umbrellas violins wagons yachts zippers bridges".split(" ");

function questionText(n) {
  return `What percentage of ${ADJECTIVES[n % 26]} ${NOUNS[Math.floor(n / 26) % 26]} were counted?`;
}

// Categories in roughly the endless bank's target mix (35% Sports, 25% U.S. life, 25% World, 10%
// Movies, 5% Music), so a bank filled in order stays under every category's cap.
const MIX = ["Sports", "U.S. life", "World", "Sports", "U.S. life", "World", "Sports", "Movies", "U.S. life", "World",
  "Sports", "U.S. life", "World", "Sports", "Music", "World", "Sports", "U.S. life", "Movies", "Sports"];
const categoryFor = n => MIX[n % MIX.length];

module.exports = { categoryFor, questionText };
