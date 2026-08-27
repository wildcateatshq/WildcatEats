# WildcatEats

A DoorDash-style app for Villanova students: post a food order (where to pick up, where to
drop it off), and any other student can browse open orders, claim one, and deliver it —
marking pickup and "I'm here!" along the way.

## Run it

```
npm install
npm start
```

Then open http://localhost:3000

## How it works

- Any student account can both place orders and deliver them — no separate roles.
- **Signup requires a villanova.edu email**, verified with a real 6-digit code sent to that
  inbox before the account is created (nothing's created until the code is confirmed).
- **Order Food** tab: pick a store, pick a hall/dropoff spot, describe what you want, set a tip.
- **Deliver** tab: browse open orders, claim one, mark "picked up," then "I'm here!" (which
  flags the orderer's tracking view), then "mark delivered."
- The orderer's phone gets a **text when their order is claimed**, and a **text + phone call
  when the runner arrives**.
- No payments are wired up yet — orders just have a note field where students can put a Venmo
  handle or similar. That's the natural next thing to add (see below).

## Turning on real storage + email + texting/calling

Right now, data lives in a local `db.json` file, verification codes get logged to the server
console (and shown right in the UI), and notifications just get logged too — so the whole app
works fully with zero setup. Each piece below activates independently the moment its env vars
are set — you don't need all three at once.

1. `cp .env.example .env`
2. **Storage:** create a free [Supabase](https://supabase.com) project, then Settings → Database
   → Connection string (URI, "Session" mode) → paste into `DATABASE_URL`. Tables are created
   automatically on first run — no migration step.
3. **Email:** fill in `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` (e.g. a Gmail account + an
   [app password](https://myaccount.google.com/apppasswords)) for real verification emails.
4. **Texting/calling:** sign up at [twilio.com](https://www.twilio.com), grab a phone number,
   and fill in `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER`.
5. Restart the server (`npm start`).

## Deploying

`render.yaml` is a ready-to-go blueprint for [Render](https://render.com): New → Blueprint →
connect this repo → Render reads the file and creates the web service → paste in the env vars
from step 2 above (`DATABASE_URL`, `SMTP_*`, `TWILIO_*`) in the dashboard → deploy. `SESSION_SECRET`
is generated for you automatically.

(Vercel isn't a fit here — it's built for serverless functions/static sites, and this is a
persistent Express server with in-memory sessions and polling. Render runs it as a normal
always-on process, no rewrite needed.)

## Stack

Deliberately minimal so it's easy to read and extend:
- **Backend:** Node + Express, session-based auth (cookie sessions, scrypt-hashed passwords).
- **Storage:** Postgres via Supabase when `DATABASE_URL` is set (`pgdb.js`), otherwise a local
  `db.json` file (`jsondb.js`) — `db.js` picks automatically. Both implement the same async
  interface, so nothing else in the app needs to know which one is active.
- **Frontend:** plain HTML/CSS/JS, no build step. Each page polls the API every few seconds
  for live-ish status updates.

## Things to double check / customize

- `config.js` has the list of stores and dorms — I filled it in from general knowledge of
  Villanova, so **verify the hall/dining names are current** before showing this to anyone.
- The session secret in `server.js` is a placeholder — replace it before deploying anywhere
  public.

## Natural next steps

1. Real payments (Stripe) instead of the "put your Venmo in the notes" workaround.
2. Ratings/history so orderers can see a runner's track record.
