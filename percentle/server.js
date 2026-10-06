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

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "..", "public");
const crowd = createCrowdStore();
const puzzles = createPuzzleStore();
const app = express();

app.use(express.json());
app.get(["/", "/percentle.html"], (req, res) => res.sendFile(path.join(publicDir, "percentle.html")));
app.get("/percentle.css", (req, res) => res.sendFile(path.join(publicDir, "percentle.css")));
app.get("/percentle.mjs", (req, res) => res.sendFile(path.join(publicDir, "percentle.mjs")));
app.use("/percentle", express.static(path.join(publicDir, "percentle")));
app.use("/api/percentle/crowd", createCrowdRouter(crowd));
app.use("/api/percentle/puzzles", createPuzzleRouter(puzzles));
app.use((req, res) => res.redirect("/"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

Promise.all([crowd.init(), puzzles.init()])
  .then(() => app.listen(PORT, () => console.log(`Percentle running at http://localhost:${PORT} (storage: ${process.env.DATABASE_URL ? "postgres" : "json-file"})`)))
  .catch(error => {
    console.error("Failed to set up Percentle storage:", error.message);
    process.exit(1);
  });
