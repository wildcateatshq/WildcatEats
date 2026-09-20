// Dynamic delivery pricing engine. Pure function of its inputs — no I/O, no
// DB/network access — so it's easy to test and to keep in sync with the
// spec independent of wherever the inputs end up being sourced from.
//
// Input/output shapes follow the NovaDash pricing spec: given real-time
// order/runner/weather/order-detail/historical data, recommend a delivery
// price that keeps runners at or above $10/hour.
//
// The runner/platform split is a static 75/25 — demand, supply, weather,
// order complexity, and time of day don't move that percentage. They still
// move the overall PRICE though (via a surge multiplier below), same as
// real travel time (distance, prep wait, a Cabrini shuttle crossing) does
// through the $10/hour floor — the split of whatever that price ends up
// being is just always 75/25, so both sides move together.
const RUNNER_PAYOUT_PCT = 75;
const TARGET_HOURLY_RATE = 10;
const PRICE_FLOOR = 2.5;
const PRICE_CEILING = 12.0;
const WALK_MINUTES_PER_MILE = 12; // ~5mph campus walking pace

// Applied on top of the time/market-derived price, to maximize revenue.
// Runner and platform still split whatever that inflated price is 75/25,
// so this markup flows through to both sides, not just the platform's cut.
const PRICE_MULTIPLIER = 1.25;

// How much a real-time condition can push the price up/down, as a fraction
// (e.g. 0.15 = +15%). Combined multiplicatively into one surge_multiplier,
// then clamped so no combination of bad conditions can spiral too far.
const SURGE_MIN = 0.75;
const SURGE_MAX = 1.75;
const LATE_NIGHT_SURGE = 0.1; // fewer runners tend to be online late

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function roundUpToQuarter(n) {
  return round2(Math.ceil(n / 0.25) * 0.25);
}

function roundToNearestQuarter(n) {
  return round2(Math.round(n / 0.25) * 0.25);
}

function money(n) {
  return `$${round2(n).toFixed(2)}`;
}

// Guards a ratio against a missing/zero baseline — treated as "no signal",
// which should read as MEDIUM demand / NORMAL supply rather than blow up
// into Infinity or NaN.
function safeRatio(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return 1;
  if (!Number.isFinite(numerator)) return 1;
  return numerator / denominator;
}

function classifyDemand(ordersPastHour, ordersBaseline) {
  const demand_multiplier = safeRatio(ordersPastHour, ordersBaseline);
  if (demand_multiplier > 1.2) return { demand_level: "HIGH", demand_adjustment: 8, demand_multiplier };
  if (demand_multiplier < 0.8) return { demand_level: "LOW", demand_adjustment: -7, demand_multiplier };
  return { demand_level: "MEDIUM", demand_adjustment: 0, demand_multiplier };
}

function classifySupply(runnersOnlineNow, runnersAvgLastWeek) {
  const runner_availability_ratio = safeRatio(runnersOnlineNow, runnersAvgLastWeek);
  if (runner_availability_ratio < 0.7) return { supply_level: "TIGHT", supply_adjustment: 4, runner_availability_ratio };
  if (runner_availability_ratio > 1.2) return { supply_level: "LOOSE", supply_adjustment: -3, runner_availability_ratio };
  return { supply_level: "NORMAL", supply_adjustment: 0, runner_availability_ratio };
}

function distanceAdjustment(distanceMiles) {
  // No distance signal at all (e.g. a Cabrini shuttle crossing, priced via
  // extra_travel_minutes/extra_difficulty instead) — neutral, not "close by".
  if (distanceMiles == null) return 0;
  const d = Number(distanceMiles);
  if (!Number.isFinite(d)) return 0;
  if (d < 0.25) return -0.08;
  if (d <= 0.5) return 0;
  if (d <= 0.75) return 0.1;
  return 0.18;
}

function complexityAdjustment(complexity, totalItems) {
  const label = complexity || (totalItems <= 2 ? "simple" : totalItems <= 6 ? "standard" : "complex");
  if (label === "simple") return { adjustment: -0.05, label };
  if (label === "complex") return { adjustment: 0.12, label };
  return { adjustment: 0, label: "standard" };
}

function weatherAdjustment(weather) {
  const w = (weather || "clear").toLowerCase();
  if (w.includes("snow") || w.includes("severe") || w.includes("storm") || w.includes("ice")) return 0.12;
  if (w.includes("rain")) return 0.08;
  return 0;
}

function prepTimeAdjustment(prepMinutes) {
  const p = Number(prepMinutes) || 0;
  if (p < 3) return -0.02;
  if (p <= 8) return 0;
  return 0.05;
}

// extra_difficulty lets a caller add a flat difficulty bump that isn't tied
// to distance/complexity/weather/prep — e.g. the schedule risk of a
// Cabrini <-> main campus shuttle crossing (see locations.js).
function calculateDifficulty(orderDetails) {
  const distance_adj = distanceAdjustment(orderDetails.distance_miles);
  const { adjustment: complexity_adj, label: complexity_label } = complexityAdjustment(
    orderDetails.order_complexity,
    Number(orderDetails.total_items) || 0
  );
  const weather_adj = weatherAdjustment(orderDetails.weather);
  const prep_adj = prepTimeAdjustment(orderDetails.prep_time_estimate);
  const extra_adj = Number(orderDetails.extra_difficulty) || 0;
  const difficulty_multiplier = 1.0 + distance_adj + complexity_adj + weather_adj + prep_adj + extra_adj;
  return { difficulty_multiplier, distance_adj, complexity_adj, complexity_label, weather_adj, prep_adj, extra_adj };
}

// How much real-time conditions move the overall price (not the 75/25
// split): demand and runner supply reuse the same weighting the split used
// to move by, just retargeted at price; weather and order complexity reuse
// calculateDifficulty's numbers directly since those had no effect on
// price at all once the split went static. Distance/prep-time are
// deliberately left out — they already move price for real, through the
// time-based $10/hour floor, so including them here too would double-count
// them.
function calculateSurge({ demand, supply, difficulty, isLateNight }) {
  const demand_surge = demand.demand_adjustment / 100;
  const supply_surge = supply.supply_adjustment / 100;
  const weather_surge = difficulty.weather_adj;
  const complexity_surge = difficulty.complexity_adj;
  const time_of_day_surge = isLateNight ? LATE_NIGHT_SURGE : 0;
  let surge_multiplier = 1.0 + demand_surge + supply_surge + weather_surge + complexity_surge + time_of_day_surge;
  surge_multiplier = Math.min(Math.max(surge_multiplier, SURGE_MIN), SURGE_MAX);
  return { surge_multiplier, demand_surge, supply_surge, weather_surge, complexity_surge, time_of_day_surge };
}

// extra_travel_minutes covers travel time that isn't distance-based — the
// Cabrini shuttle crossing again, added on top of (not instead of) the
// normal walk-time math.
function calculateTotalTime(orderDetails) {
  const distance = Number(orderDetails.distance_miles) || 0;
  const prep = Number(orderDetails.prep_time_estimate) || 0;
  const extra_travel = Number(orderDetails.extra_travel_minutes) || 0;
  const walk_to_source = distance * WALK_MINUTES_PER_MILE;
  const walk_to_destination = distance * WALK_MINUTES_PER_MILE;
  const total_time_minutes = walk_to_source + prep + walk_to_destination + extra_travel;
  // A zero-distance, zero-prep order is a degenerate input, not a real
  // instant delivery — floor at 1 minute so hourly-rate math stays finite.
  const total_time_hours = Math.max(total_time_minutes, 1) / 60;
  return { total_time_minutes, total_time_hours };
}

// Cheapest historical price point at/above the floor with a strong claim
// rate; falls back to the best claim rate that still clears the floor. Null
// (no usable history) tells the caller to anchor on the hourly floor alone.
//
// Two guards keep this from swamping the distance/time signal:
//  1. Requires at least 2 distinct price points — a single bucket (e.g.
//     every past order used the same flat default fee) isn't real
//     price-discovery data, it's one number with no variation to learn
//     from, and anchoring on it would flatten every order to that one
//     value regardless of how far the delivery actually is.
//  2. Caps how far above the floor an anchor can reach (50%, or $1,
//     whichever is bigger). Without this, a globally "reliable" price from
//     history (e.g. $5 always gets claimed) would get recommended for
//     every cheap/short order too, erasing the difference between a short
//     walk and a long one. This keeps market data able to round the price
//     to a clean, proven number nearby, not override it outright.
function marketAnchoredPrice(pricingByPoint, floor) {
  if (!pricingByPoint || typeof pricingByPoint !== "object") return null;
  const points = Object.entries(pricingByPoint)
    .map(([price, stats]) => ({
      price: Number(price),
      claimRate: Number(stats && stats.claim_rate)
    }))
    .filter((p) => Number.isFinite(p.price) && Number.isFinite(p.claimRate))
    .sort((a, b) => a.price - b.price);
  if (points.length < 2) return null;

  const anchorCeiling = Math.max(floor * 1.5, floor + 1.0);
  const inRange = points.filter((p) => p.price >= floor && p.price <= anchorCeiling);
  if (inRange.length === 0) return null;

  const strongAboveFloor = inRange.filter((p) => p.claimRate >= 0.85);
  if (strongAboveFloor.length) return strongAboveFloor[0].price;

  return inRange.reduce((best, p) => (p.claimRate > best.claimRate ? p : best)).price;
}

function priceForPayoutPct(minimumRunnerPayout, payoutPct, pricingByPoint, surgeMultiplier = 1) {
  const floor = minimumRunnerPayout / (payoutPct / 100);
  const anchored = marketAnchoredPrice(pricingByPoint, floor);
  let price = anchored != null ? anchored : roundUpToQuarter(floor);
  price = roundToNearestQuarter(price * surgeMultiplier * PRICE_MULTIPLIER);
  price = Math.min(Math.max(price, PRICE_FLOOR), PRICE_CEILING);
  return { price, floor };
}

function buildReasoning({ demand, supply, difficulty, surge, orderData, runnerData, isLateNight }) {
  const clauses = [];

  if (demand.demand_level === "HIGH") {
    clauses.push(`high demand (${orderData.orders_past_hour} orders in the past hour vs ${orderData.orders_past_hour_same_day_last_week} usual)`);
  } else if (demand.demand_level === "LOW") {
    clauses.push(`low demand (${orderData.orders_past_hour} orders in the past hour vs ${orderData.orders_past_hour_same_day_last_week} usual)`);
  }

  if (supply.supply_level === "TIGHT") {
    clauses.push(`only ${runnerData.runners_online_now} runners online (down from ${runnerData.runners_online_avg_same_time_last_week} normally)`);
  } else if (supply.supply_level === "LOOSE") {
    clauses.push(`${runnerData.runners_online_now} runners online (more than the usual ${runnerData.runners_online_avg_same_time_last_week})`);
  }

  if (difficulty.weather_adj > 0) clauses.push(`${(difficulty.weatherLabel || "bad weather").toLowerCase()} conditions`);

  if (difficulty.complexity_label === "complex") clauses.push("a complex, multi-item order");
  else if (difficulty.complexity_label === "simple") clauses.push("a simple, quick order");

  if (isLateNight) clauses.push("it being late night, when fewer runners are usually online");

  if (difficulty.distance_adj > 0) clauses.push("a longer walk than usual");
  else if (difficulty.distance_adj < 0) clauses.push("a very short walk");

  if (difficulty.extra_adj > 0) clauses.push("a cross-campus shuttle crossing to/from Cabrini");

  if (clauses.length === 0) {
    return "Standard conditions all around — no surge applied.";
  }
  const reasoning = `${clauses.join(", ")} shaped this price (runner still gets a fixed 75% of it).`;
  return reasoning.charAt(0).toUpperCase() + reasoning.slice(1);
}

function buildAdjustedFactors({ demand, supply, surge, isLateNight }) {
  const factors = [];
  if (surge.demand_surge !== 0) {
    factors.push(`${demand.demand_level === "HIGH" ? "High" : "Low"} demand: ${surge.demand_surge > 0 ? "+" : ""}${round2(surge.demand_surge * 100)}% to price`);
  }
  if (surge.supply_surge !== 0) {
    factors.push(`${supply.supply_level === "TIGHT" ? "Tight" : "Loose"} runner supply: ${surge.supply_surge > 0 ? "+" : ""}${round2(surge.supply_surge * 100)}% to price`);
  }
  if (surge.weather_surge !== 0) {
    factors.push(`Weather: +${round2(surge.weather_surge * 100)}% to price`);
  }
  if (surge.complexity_surge !== 0) {
    factors.push(`Order complexity: ${surge.complexity_surge > 0 ? "+" : ""}${round2(surge.complexity_surge * 100)}% to price`);
  }
  if (isLateNight) {
    factors.push(`Late night: +${round2(LATE_NIGHT_SURGE * 100)}% to price`);
  }
  factors.push(`Runner payout stays a fixed ${RUNNER_PAYOUT_PCT}% of whatever the final price is (platform ${100 - RUNNER_PAYOUT_PCT}%).`);
  return factors;
}

function recommendPrice(input) {
  const orderData = input.orderData || {};
  const runnerData = input.runnerData || {};
  const weatherData = input.weatherData || {};
  const orderDetails = { ...(input.orderDetails || {}), weather: weatherData.current_weather };
  const historicalData = input.historicalData || {};
  const isLateNight = Boolean(orderDetails.is_late_night);

  const demand = classifyDemand(orderData.orders_past_hour, orderData.orders_past_hour_same_day_last_week);
  const supply = classifySupply(runnerData.runners_online_now, runnerData.runners_online_avg_same_time_last_week);
  const difficulty = calculateDifficulty(orderDetails);
  difficulty.weatherLabel = weatherData.current_weather;
  const surge = calculateSurge({ demand, supply, difficulty, isLateNight });

  const { total_time_minutes, total_time_hours } = calculateTotalTime(orderDetails);
  const minimum_runner_payout = total_time_hours * TARGET_HOURLY_RATE;

  const runner_payout_percentage = RUNNER_PAYOUT_PCT;

  const { price: recommended_price } = priceForPayoutPct(
    minimum_runner_payout,
    runner_payout_percentage,
    historicalData.pricing_by_point,
    surge.surge_multiplier
  );

  const split = deriveSplit(recommended_price, total_time_hours);

  return {
    recommended_price: money(recommended_price),
    runner_payout: money(split.runner_payout),
    runner_payout_percentage: Math.round(runner_payout_percentage),
    platform_fee: money(split.platform_fee),
    platform_fee_percentage: Math.round(100 - runner_payout_percentage),
    demand_level: demand.demand_level.toLowerCase(),
    supply_level: supply.supply_level.toLowerCase(),
    reasoning: buildReasoning({ demand, supply, difficulty, surge, orderData, runnerData, isLateNight }),
    adjusted_factors: buildAdjustedFactors({ demand, supply, surge, isLateNight }),
    runner_hourly_equivalent: `$${split.runner_hourly_equivalent.toFixed(2)}/hour`,
    total_time_estimate_minutes: Math.round(total_time_minutes),
    total_time_hours,
    below_target_hourly: split.below_target_hourly
  };
}

// Splits an arbitrary price 75/25 for a delivery of the given estimated
// duration — factored out so a price chosen by something other than this
// formula (e.g. aiPricing.js) can still get consistent runner-pay figures
// and the same $10/hour wage-floor check.
function deriveSplit(price, totalTimeHours) {
  const runner_payout = round2(price * (RUNNER_PAYOUT_PCT / 100));
  const platform_fee = round2(price - runner_payout);
  const runner_hourly_equivalent = round2(runner_payout / totalTimeHours);
  const below_target_hourly = runner_hourly_equivalent < TARGET_HOURLY_RATE - 0.01;
  return { runner_payout, platform_fee, runner_hourly_equivalent, below_target_hourly };
}

module.exports = {
  recommendPrice,
  deriveSplit,
  money,
  // exported for unit testing / reuse
  classifyDemand,
  classifySupply,
  calculateDifficulty,
  calculateTotalTime,
  marketAnchoredPrice,
  RUNNER_PAYOUT_PCT,
  TARGET_HOURLY_RATE,
  PRICE_FLOOR,
  PRICE_CEILING
};
