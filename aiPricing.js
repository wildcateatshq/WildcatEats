// A genuine LLM reasoning layer on top of the deterministic pricing engine
// (pricing.js). Given the same real inputs the formula uses, plus the
// formula's own reference price, asks Claude to actually weigh the
// conditions and recommend a price — not just evaluate fixed arithmetic.
//
// The formula's hard business rules still apply as constraints the model
// must respect (the 75/25 split, the $10/hour wage floor, the $2.50-$12
// bounds) — this isn't the model inventing pricing policy from scratch,
// it's the model exercising judgment within policy that's already been
// decided. And it always has a safe fallback: no API key configured, a
// network failure, an unparseable response, or a price that would violate
// the wage floor all fall back to the deterministic price. `ai_used` in
// the result says which one actually happened.
const pricing = require("./pricing");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.PRICING_AI_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are NovaDash's delivery pricing agent for Villanova University's student-run food delivery platform.

You recommend a delivery fee for a single order. You're given real-time signals (recent order volume vs the same hour last week, runners currently online vs usual, live weather, whether it's currently late night, and the specific order's estimated travel time/complexity) plus a reference price already computed from fixed business rules.

Rules you must respect, not reconsider:
- The runner always gets exactly 75% of whatever price you choose, the platform 25%. You are not setting that split, only the price.
- The runner must earn at least $10/hour for the order's estimated total time (walking + prep wait, given to you as total_time_hours). Never recommend a price whose 75% runner share, divided by total_time_hours, comes out under $10/hour.
- Absolute bounds: never below $2.50, never above $12.00.
- Round to the nearest $0.25.

Within those constraints, use real judgment — weigh demand, runner supply, weather, time of day, and order difficulty together the way a thoughtful human dispatcher would, including combinations that don't reduce to simply adding factors up (e.g. bad weather matters more when supply is already tight; high demand late at night is a different situation than high demand at lunch). The reference price is a starting point, not an answer key — you can match it, adjust it up or down within the rules above, or reason through it independently.

Respond with ONLY a JSON object, no other text, no markdown fences:
{"price": <number>, "reasoning": "<1-2 plain-language sentences on what actually drove THIS price, no jargon>"}`;

function extractJson(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model response didn't contain a JSON object");
  return JSON.parse(match[0]);
}

async function recommendPriceWithAI(input) {
  const deterministic = pricing.recommendPrice(input);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ...deterministic, ai_used: false, ai_error: "ANTHROPIC_API_KEY isn't set — used the deterministic price." };
  }

  try {
    const userPayload = {
      order_data: input.orderData || {},
      runner_data: input.runnerData || {},
      weather: input.weatherData || {},
      order_details: input.orderDetails || {},
      reference: {
        price: deterministic.recommended_price,
        runner_hourly_equivalent: deterministic.runner_hourly_equivalent,
        total_time_minutes: deterministic.total_time_estimate_minutes,
        total_time_hours: deterministic.total_time_hours,
        reasoning: deterministic.reasoning
      }
    };

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(userPayload) }]
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Anthropic API returned ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`);
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text || "";
    const parsed = extractJson(text);

    const rawPrice = Number(parsed.price);
    const reasoning = String(parsed.reasoning || "").trim().slice(0, 500);
    if (!Number.isFinite(rawPrice)) throw new Error("Model returned a non-numeric price");
    if (!reasoning) throw new Error("Model returned no reasoning");

    const clamped = Math.min(Math.max(rawPrice, pricing.PRICE_FLOOR), pricing.PRICE_CEILING);
    const roundedPrice = Math.round(clamped / 0.25) * 0.25;
    const split = pricing.deriveSplit(roundedPrice, deterministic.total_time_hours);

    if (split.below_target_hourly) {
      return {
        ...deterministic,
        ai_used: false,
        ai_error: `Model recommended ${pricing.money(roundedPrice)}, which would pay the runner under $10/hour — used the deterministic price instead.`
      };
    }

    return {
      ...deterministic,
      recommended_price: pricing.money(roundedPrice),
      runner_payout: pricing.money(split.runner_payout),
      platform_fee: pricing.money(split.platform_fee),
      runner_hourly_equivalent: `$${split.runner_hourly_equivalent.toFixed(2)}/hour`,
      below_target_hourly: split.below_target_hourly,
      reasoning,
      ai_used: true
    };
  } catch (err) {
    return { ...deterministic, ai_used: false, ai_error: err.message };
  }
}

module.exports = { recommendPriceWithAI };
