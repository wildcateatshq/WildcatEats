"use strict";

// Percentle-only server: the game is the home page and none of the Wildcat Eats pages,
// APIs, or tables are loaded. Start it with `npm run percentle` (Render start command:
// `node percentle/server.js`). The full Wildcat Eats server also serves the game at
// /percentle.html.
require("dotenv").config();
const path = require("node:path");
const express = require("express");
const { createCrowdStore } = require("./crowd");
const { createCrowdRouter } = require("./crowd-router");
const { createPuzzleStore } = require("./puzzles");
const { createPuzzleRouter } = require("./puzzle-router");
const { createEndlessStore } = require("./endless");
const { createEndlessRouter } = require("./endless-router");
const { createStatsStore } = require("./stats");
const { createStatsRouter } = require("./stats-router");

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "..", "public");
const crowd = createCrowdStore();
const puzzles = createPuzzleStore();
const endless = createEndlessStore();
const stats = createStatsStore();
const app = express();

// The page itself is always re-checked so a deploy shows up straight away; its styles, scripts,
// and icon can be reused for a few minutes (they're small, and not renamed between deploys).
const ASSET_CACHE_MS = 5 * 60 * 1000;
const page = { headers: { "Cache-Control": "no-cache" } };
const asset = { maxAge: ASSET_CACHE_MS };

app.use(express.json());
app.get(["/", "/percentle.html"], (req, res) => res.sendFile(path.join(publicDir, "percentle.html"), page));
app.get("/percentle.css", (req, res) => res.sendFile(path.join(publicDir, "percentle.css"), asset));
app.get("/percentle.mjs", (req, res) => res.sendFile(path.join(publicDir, "percentle.mjs"), asset));
// Google and some browsers look for the icon here rather than in the page's <link> tags.
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(publicDir, "percentle", "favicon.ico"), { maxAge: 24 * 60 * 60 * 1000 }));
app.use("/percentle", express.static(path.join(publicDir, "percentle"), asset));
// For search engines: the game's public address, what to crawl (not the API), and a sitemap.
const SITE_URL = "https://chargle.io";
app.get("/robots.txt", (req, res) => res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap.xml\n`));
app.get("/sitemap.xml", (req, res) => res.type("application/xml").send(
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq></url>\n</urlset>\n`
));
app.use("/api/percentle/crowd", createCrowdRouter(crowd));
app.use("/api/percentle/puzzles", createPuzzleRouter(puzzles, { endless }));
app.use("/api/percentle/endless", createEndlessRouter(endless, { puzzles }));
app.use("/api/percentle/stats", createStatsRouter(stats, crowd));
app.use((req, res) => res.redirect("/"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

Promise.all([crowd.init(), puzzles.init(), endless.init(), stats.init()])
  .then(() => app.listen(PORT, () => console.log(`Percentle running at http://localhost:${PORT} (storage: ${process.env.DATABASE_URL ? "postgres" : "json-file"})`)))
  .catch(error => {
    console.error("Failed to set up Percentle storage:", error.message);
    process.exit(1);
  });
