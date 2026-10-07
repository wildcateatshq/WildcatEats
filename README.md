# NovaDash

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

## Percentle daily guessing game

Percentle is a separate, account-free game at `/percentle.html`, served by the existing
Express app; it does not change Wildcat Eats pages, accounts, or storage. Start the app with
`npm start` and visit http://localhost:3000/percentle.html.

Percentle can also run on its own with `npm run percentle` (`node percentle/server.js`).
That server makes the game the home page and loads none of the Wildcat Eats pages, APIs,
or database tables. Use it as the Render start command for a Percentle-only service.

### How it plays (Chargle)

Players see the game as **Chargle** (set by `GAME_NAME` in `public/percentle.mjs`); the code,
URLs, storage keys, and database tables keep the Percentle name. The score is a battery that
starts at 100% charge and drains by how far off each guess is (`DRAIN_RATE` in
`public/percentle/game.mjs`; 1 means each point off costs 1% of charge). Higher is better.
Games are saved as total points off, so changing `DRAIN_RATE` re-scores past games
consistently. Dropping below 0% ends the game early: the alarms go off, the lights cut out, and
the player sees an "Out of charge" screen. Exactly 0.0% survives.

### Daily puzzles come from an AI agent

There is no fixed question bank. Every day a scheduled AI agent researches five new
percentage questions on a random mix of U.S. life, sports, music, movies, and world topics,
checks each answer against a source, and publishes them through the puzzle API. The agent's
full instructions are in [percentle/AGENT_PROMPT.md](percentle/AGENT_PROMPT.md); paste that
file in as the prompt of whatever scheduler runs the agent.

- **Rollover:** the day changes at midnight Eastern time (America/New_York, so EST or EDT).
  Puzzle #1 is October 6, 2026; numbers count calendar days from there. An open tab reloads
  onto the new puzzle after midnight. If a day's puzzle hasn't been published yet, players see
  "Today's puzzle is on its way" and the page checks again every minute.
- **When to run the agent:** schedule it daily at about **11:30 PM Eastern**. Run after 6 PM, it
  targets the next day, so the puzzle is waiting when midnight arrives. (Run after midnight,
  it targets the current day, which also works but leaves a short gap.) In Claude Code, `/schedule`
  can create this as a daily cloud routine.
- **What the agent needs:** web search, `curl`, and two environment variables:
  `PERCENTLE_SITE_URL` (the public site URL) and `PERCENTLE_PUBLISH_TOKEN`.
- **Server setup:** set `PERCENTLE_PUBLISH_TOKEN` on the server to a long random secret (for
  example the output of `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`) and
  give the same value to the agent. Without it, publishing is turned off.

### Puzzle API

All routes are under `/api/percentle/puzzles`. Publishing and history need the header
`Authorization: Bearer <PERCENTLE_PUBLISH_TOKEN>`.

| Route | Who | What it does |
|---|---|---|
| `GET /today` | Players | Today's puzzle, or 404 if it isn't published yet |
| `GET /archive` | Players | Dates and numbers of puzzles from the last 30 days, before today |
| `GET /:date` | Players | A past or current puzzle. Future dates are hidden unless the token is sent |
| `GET /history?days=90` | Agent | Recent and scheduled puzzles, so the agent can avoid repeats |
| `PUT /:date` | Agent | Publish `{ "questions": [...] }` for today (if it isn't live yet) or up to 7 days ahead |

Each question has `text` (ending in "?"), `answer` (strictly between 0 and 100, at most one
decimal), `category`, `funFact` (shown after the answer), `sourceName`, and an `https://`
`sourceUrl` (kept for checking, not shown). Categories are `U.S. life`, `Sports`, `Music`,
`Movies`, and `World`, in any mix: a day can have several questions from one category and
none from another. The server rejects a puzzle that breaks these rules and lists every
problem so the agent can fix them in one retry. A day's puzzle can't be changed once that day has started, because players' guesses
and crowd scores depend on it; unreleased days can be replaced.

Puzzles are stored in a `percentle_puzzles` table when `DATABASE_URL` is set. Without
Postgres they go to `data/percentle-puzzles.json` (override with `PERCENTLE_PUZZLES_FILE`).
On hosts with ephemeral disks, use Postgres so puzzles survive restarts.

To publish a puzzle by hand (for example, locally), save it as `puzzle.json` and run:

```sh
curl -X PUT -H "Authorization: Bearer $PERCENTLE_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" --data @puzzle.json \
  http://localhost:3000/api/percentle/puzzles/2026-10-06
```

### Tests

Run the scoring, Eastern-date, puzzle-validation, puzzle API, and crowd tests with `npm test`.
No additional packages or build step are needed.

### Crowd comparison

Player progress, streaks, and personal scores stay in the browser. When a player finishes
today's puzzle, the page automatically sends a single rank number to the crowd API
anonymously (practice replays of past puzzles are never sent). Percentle never submits
individual guesses, names, or account details. Random per-day IDs let the crowd module update a
browser's score without linking scores across days. Your position appears only after at
least five other players have contributed.

The rank is the player's total points off if they finished, or 400 plus a little more the
earlier they ran out of charge (`crowdRank` in `game.mjs`), so every finisher ranks above every
player who ran out. Lower ranks better and tied ranks share the midpoint. Finishers see a line
from the lowest charge to the highest and the percent of players they beat; players who ran
out see what share of the other players also ran out (any rank of 400 or more).

The crowd module stores scores in a separate `percentle_daily_scores` table when
`DATABASE_URL` is configured. Without Postgres, it writes to `data/percentle-crowd.json`;
set `PERCENTLE_CROWD_FILE` to place this file on persistent storage. Crowd collection is
independent of the rest of Percentle: if the API is unavailable, the daily puzzle still works.

Possible follow-ups: a friends leaderboard, a timed hard mode, and themed weekend puzzles.
