// Live weather for the pricing engine, via Open-Meteo (free, no API key).
// Villanova University, PA.
const LATITUDE = 40.0398;
const LONGITUDE = -75.3407;

// WMO weather codes -> the simple labels pricing.js understands.
const CODE_LABELS = {
  0: "clear",
  1: "clear",
  2: "clear",
  3: "clear",
  45: "clear",
  48: "clear",
  51: "rainy",
  53: "rainy",
  55: "rainy",
  56: "snowy",
  57: "snowy",
  61: "rainy",
  63: "rainy",
  65: "rainy",
  66: "snowy",
  67: "snowy",
  71: "snowy",
  73: "snowy",
  75: "snowy",
  77: "snowy",
  80: "rainy",
  81: "rainy",
  82: "rainy",
  85: "snowy",
  86: "snowy",
  95: "severe",
  96: "severe",
  99: "severe"
};

// Falls back to "clear" on any network/API failure — a pricing recommendation
// shouldn't fail outright just because a third-party weather API is down.
async function getCurrentWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`weather API returned ${response.status}`);
    const data = await response.json();
    const code = data?.current?.weather_code;
    const temperature = data?.current?.temperature_2m;
    return {
      current_weather: CODE_LABELS[code] || "clear",
      temperature: Number.isFinite(temperature) ? Math.round(temperature) : null
    };
  } catch (err) {
    return { current_weather: "clear", temperature: null };
  }
}

module.exports = { getCurrentWeather };
