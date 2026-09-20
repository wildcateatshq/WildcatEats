// Dev tool: runs a set of representative delivery scenarios through both
// the deterministic formula (pricing.js) and the AI-assisted path
// (aiPricing.js) and prints them side by side, so you can sanity-check
// that Claude's recommendations are actually reasonable before trusting it
// in production.
//
// Requires a real ANTHROPIC_API_KEY in .env — without one, aiPricing.js
// just falls back to the formula for every scenario and every row will
// show "used: no (no key)", which isn't a real comparison.
//
// Usage: node compare-pricing.js   (or: npm run compare-pricing)
require("dotenv").config();
const pricing = require("./pricing");
const aiPricing = require("./aiPricing");
const locations = require("./locations");

function scenario(label, { store, hall, overrides = {} }) {
  const travel = locations.resolveTravel(store, hall);
  if (!travel) throw new Error(`compare-pricing.js: couldn't resolve travel for ${store} -> ${hall}`);
  const base = {
    orderData: { orders_past_hour: 19, orders_past_hour_same_day_last_week: 19, current_unclaimed_orders: 2, avg_claim_time_past_hour_minutes: 5 },
    runnerData: { runners_online_now: 7, runners_online_avg_this_hour: 7, runners_online_avg_same_time_last_week: 7 },
    weatherData: { current_weather: "clear", temperature: 65 },
    orderDetails: { total_items: 3, prep_time_estimate: 5, ...travel },
    historicalData: {}
  };
  // Shallow-merge each top-level section so a scenario only has to specify
  // what it's actually varying.
  const input = { ...base, ...overrides };
  for (const key of ["orderData", "runnerData", "weatherData", "orderDetails", "historicalData"]) {
    if (overrides[key]) input[key] = { ...base[key], ...overrides[key] };
  }
  return { label, input };
}

const SCENARIOS = [
  scenario("Baseline — short walk, normal everything", { store: "COVA", hall: "Villanova School of Business" }),
  scenario("Longer walk, still normal conditions", { store: "Holy Grounds (Bartley)", hall: "Jackson Hall" }),
  scenario("High demand (28 orders vs 18 baseline)", {
    store: "COVA", hall: "Sullivan Hall",
    overrides: { orderData: { orders_past_hour: 28, orders_past_hour_same_day_last_week: 18 } }
  }),
  scenario("Low demand (6 orders vs 18 baseline)", {
    store: "COVA", hall: "Sullivan Hall",
    overrides: { orderData: { orders_past_hour: 6, orders_past_hour_same_day_last_week: 18 } }
  }),
  scenario("Tight runner supply (4 online vs 8 usual)", {
    store: "COVA", hall: "Sullivan Hall",
    overrides: { runnerData: { runners_online_now: 4, runners_online_avg_same_time_last_week: 8 } }
  }),
  scenario("Rainy weather", {
    store: "COVA", hall: "Sullivan Hall",
    overrides: { weatherData: { current_weather: "rainy", temperature: 50 } }
  }),
  scenario("Snowy weather", {
    store: "COVA", hall: "Sullivan Hall",
    overrides: { weatherData: { current_weather: "snowy", temperature: 28 } }
  }),
  scenario("Complex order (9 items)", {
    store: "COVA", hall: "Sullivan Hall",
    overrides: { orderDetails: { total_items: 9, order_complexity: "complex" } }
  }),
  scenario("Late night", {
    store: "COVA", hall: "Sullivan Hall",
    overrides: { orderDetails: { is_late_night: true } }
  }),
  scenario("Cabrini shuttle crossing", { store: "Cascia", hall: "Sullivan Hall" }),
  scenario("Everything stacked — high demand, tight supply, snowy, complex, late night", {
    store: "COVA", hall: "Sullivan Hall",
    overrides: {
      orderData: { orders_past_hour: 28, orders_past_hour_same_day_last_week: 18 },
      runnerData: { runners_online_now: 4, runners_online_avg_same_time_last_week: 8 },
      weatherData: { current_weather: "snowy", temperature: 20 },
      orderDetails: { total_items: 9, order_complexity: "complex", is_late_night: true }
    }
  })
];

function pct(a, b) {
  const base = Number(a.replace("$", ""));
  const other = Number(b.replace("$", ""));
  if (base === 0) return "n/a";
  const delta = ((other - base) / base) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%`;
}

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("No ANTHROPIC_API_KEY in .env — every row below will just be the formula falling back to itself.");
    console.log("Add a real key, then re-run this script for an actual comparison.\n");
  }

  const rows = [];
  for (const { label, input } of SCENARIOS) {
    const formula = pricing.recommendPrice(input);
    const ai = await aiPricing.recommendPriceWithAI(input);
    rows.push({
      label,
      formulaPrice: formula.recommended_price,
      aiPrice: ai.recommended_price,
      delta: pct(formula.recommended_price, ai.recommended_price),
      used: ai.ai_used ? "yes" : `no (${ai.ai_error || "fell back"})`,
      aiReasoning: ai.ai_used ? ai.reasoning : "—",
      belowFloor: ai.below_target_hourly ? "YES — BUG, should never happen" : "no"
    });
  }

  const nameWidth = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    console.log(r.label.padEnd(nameWidth), "| formula:", r.formulaPrice.padEnd(6), "| AI:", r.aiPrice.padEnd(6), "| delta:", r.delta.padEnd(6), "| AI used:", r.used);
    if (r.aiReasoning !== "—") console.log(" ".repeat(nameWidth), "  reasoning:", r.aiReasoning);
    if (r.belowFloor !== "no") console.log(" ".repeat(nameWidth), "  !!", r.belowFloor);
  }

  const used = rows.filter((r) => r.used === "yes");
  if (used.length) {
    const deltas = used.map((r) => Number(r.delta.replace("%", "").replace("n/a", "0")));
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const maxAbs = Math.max(...deltas.map(Math.abs));
    console.log(`\n${used.length}/${rows.length} scenarios actually used the AI. Avg delta from formula: ${avg.toFixed(1)}%. Largest single deviation: ${maxAbs.toFixed(0)}%.`);
    if (maxAbs > 60) {
      console.log("Flag: at least one AI price deviated more than 60% from the formula — worth a manual look at that scenario's reasoning above.");
    }
  }
})();
