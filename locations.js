// Resolves a (store, hall) pair into the travel-related inputs
// pricing.recommendPrice() expects. Keeps all the campus geography/zone
// rules (coordinates, the Cabrini shuttle crossing) out of pricing.js,
// which stays a generic "given these inputs, compute a price" engine.
const config = require("./config");

const EARTH_RADIUS_MILES = 3958.8;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

// Straight-line (haversine) distance in miles — fine for campus-scale
// walking distances; no need for real street routing.
function haversineMiles(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(h));
}

// Crossing to/from Cabrini is a shuttle ride, not a walk, so no coordinate
// distance applies. Rough estimate: walk to the stop + a typical wait + the
// ~8 minute ride — update this if real shuttle schedule data ever becomes
// available. difficulty reflects the schedule risk (missed shuttle, etc.)
// on top of the raw time cost.
const CABRINI_CROSSING_MINUTES = 20;
const CABRINI_CROSSING_DIFFICULTY = 0.15;

// Cascia and the Cabrini halls have no coordinates — they're all close
// together on that campus, so an order that stays entirely within it is
// just treated as a short, flat local walk.
const CABRINI_LOCAL_DISTANCE_MILES = 0.3;

function findHall(hallName) {
  return config.halls.find((h) => h.name === hallName) || null;
}

function isCabriniStore(storeName) {
  return (config.cabriniStores || []).includes(storeName);
}

function storeLocation(storeName) {
  return (config.storeLocations || {})[storeName] || null;
}

// Returns { distance_miles } or { extra_travel_minutes, extra_difficulty },
// or null if the store/hall isn't recognized or is missing coordinates.
function resolveTravel(storeName, hallName) {
  const hall = findHall(hallName);
  if (!hall) return null;

  const storeIsCabrini = isCabriniStore(storeName);
  const hallIsCabrini = Boolean(hall.cabrini);

  if (storeIsCabrini && hallIsCabrini) {
    return { distance_miles: CABRINI_LOCAL_DISTANCE_MILES };
  }
  if (storeIsCabrini !== hallIsCabrini) {
    return { extra_travel_minutes: CABRINI_CROSSING_MINUTES, extra_difficulty: CABRINI_CROSSING_DIFFICULTY };
  }

  const storeLoc = storeLocation(storeName);
  if (!storeLoc || hall.lat == null || hall.lng == null) return null;
  const distance_miles = Math.round(haversineMiles(storeLoc, { lat: hall.lat, lng: hall.lng }) * 100) / 100;
  return { distance_miles };
}

module.exports = { resolveTravel, haversineMiles };
