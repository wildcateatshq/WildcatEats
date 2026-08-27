// Picks the real Postgres backend when DATABASE_URL is set (e.g. Supabase),
// otherwise falls back to the local JSON file so the app still runs with zero
// setup. Both export the same async interface — see jsondb.js / pgdb.js.
module.exports = process.env.DATABASE_URL ? require("./pgdb") : require("./jsondb");
