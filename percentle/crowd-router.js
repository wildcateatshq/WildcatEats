"use strict";

const express = require("express");
const { easternDate } = require("./puzzles");

function createCrowdRouter(store, currentDate = () => easternDate()) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      res.json(await store.getSummary(req.query.date));
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    const { date, id, score } = req.body || {};
    if (date !== currentDate()) {
      return res.status(400).json({ error: "Only today's puzzle accepts crowd scores." });
    }
    try {
      res.json(await store.submit(date, id, score));
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createCrowdRouter };
