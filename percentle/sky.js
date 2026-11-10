"use strict";

// The city's weather: today's real forecast for Villanova, PA, from Open-Meteo (free, no key). Only
// the server asks, so no player's address or data goes to Open-Meteo. Everyone sees the same sky,
// and a failed lookup just means a clear sky.

const express = require("express");
const { easternDate } = require("./puzzles");

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast?latitude=40.0398&longitude=-75.3407" +
  "&daily=weather_code,temperature_2m_max&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=1";
// A day's forecast is checked again after this long (forecasts change); a failed lookup sooner.
const FRESH_MS = 3 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
// Snow only on a day that stays this cold or colder; a warmer "snow" day shows as rain.
const SNOW_MAX_F = 40;

// Days already shown before the real forecast took over (Nov 11, 2026), kept as players saw them.
const SHOWN_BEFORE = { "2026-11-10": "snow" };

const SNOW = new Set([71, 73, 75, 77, 85, 86]);
const ICE = new Set([56, 57, 66, 67]);
const RAIN = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99]);
const FOG = new Set([45, 48]);

// A WMO weather code and the day's high (°F) as the city shows them: "snow", "rain", "fog" or null.
function skyFor(code, high) {
  const cold = Number.isFinite(high) && high <= SNOW_MAX_F;
  if (SNOW.has(code) || ICE.has(code)) return cold ? "snow" : "rain";
  if (RAIN.has(code)) return "rain";
  if (FOG.has(code)) return "fog";
  return null;
}

function createSkyRouter(options = {}) {
  const router = express.Router();
  const fetchForecast = options.fetch || (url => fetch(url, { signal: AbortSignal.timeout(5000) }));
  const today = options.today || (() => easternDate());
  const now = options.now || (() => Date.now());
  let cached = null; // { date, kind, high, until }
  let pending = null;

  async function lookUp(date) {
    try {
      const response = await fetchForecast(FORECAST_URL);
      if (!response.ok) throw new Error(`forecast returned ${response.status}`);
      const daily = (await response.json())?.daily;
      const code = daily?.weather_code?.[0];
      const high = daily?.temperature_2m_max?.[0];
      if (!Number.isFinite(code)) throw new Error("forecast had no weather code");
      return { date, kind: skyFor(code, high), high: Number.isFinite(high) ? Math.round(high) : null, until: now() + FRESH_MS };
    } catch (error) {
      console.warn("Chargle weather lookup failed:", error.message);
      return { date, kind: null, high: null, until: now() + RETRY_MS };
    }
  }

  router.get("/", async (req, res, next) => {
    try {
      const date = today();
      if (date in SHOWN_BEFORE) return res.json({ date, weather: SHOWN_BEFORE[date], high: null });
      if (!cached || cached.date !== date || now() >= cached.until) {
        pending ??= lookUp(date).finally(() => { pending = null; });
        cached = await pending;
      }
      res.set("Cache-Control", "public, max-age=600");
      res.json({ date: cached.date, weather: cached.kind, high: cached.high });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createSkyRouter, skyFor };
