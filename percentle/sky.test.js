"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createSkyRouter, skyFor } = require("./sky");

test("the city's weather follows the real forecast, and only snows on a cold day", () => {
  assert.equal(skyFor(0, 62), null, "clear");
  assert.equal(skyFor(3, 62), null, "cloudy is clear");
  assert.equal(skyFor(61, 62), "rain");
  assert.equal(skyFor(95, 80), "rain", "thunderstorm");
  assert.equal(skyFor(45, 50), "fog");
  assert.equal(skyFor(73, 31), "snow");
  assert.equal(skyFor(73, 62), "rain", "a warm 'snow' day shows rain");
  assert.equal(skyFor(66, 30), "snow", "freezing rain on a cold day");
  assert.equal(skyFor(71, null), "rain", "no high: no snow");
});

test("today keeps the snow players already saw; the real forecast starts tomorrow", async t => {
  const app = express();
  app.use("/w", createSkyRouter({ today: () => "2026-11-10", fetch: async () => { throw new Error("not asked"); } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => server.close());
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/w`)).json();
  assert.equal(body.weather, "snow");
});

test("weather API looks the forecast up once and is clear when the lookup fails", async t => {
  let calls = 0;
  let fail = false;
  let clock = 0;
  const app = express();
  app.use("/w", createSkyRouter({
    today: () => "2026-11-11",
    now: () => clock,
    fetch: async () => {
      calls++;
      if (fail) throw new Error("offline");
      return { ok: true, json: async () => ({ daily: { weather_code: [71], temperature_2m_max: [28.4] } }) };
    }
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => server.close());
  const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/w`)).json();

  assert.deepEqual(await get(), { date: "2026-11-11", weather: "snow", high: 28 });
  await get();
  assert.equal(calls, 1, "cached");

  fail = true;
  clock = 4 * 60 * 60 * 1000;
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(await get(), { date: "2026-11-11", weather: null, high: null });
});
