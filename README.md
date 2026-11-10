# NovaDash

The public website is a landing page. Ordering and delivery happen in the
native iPhone app under `ios/`, which connects directly to Supabase.

## Run it

```
npm install
npm start
```

Then open http://localhost:3000 for the landing page or
http://localhost:3000/admin for admin sign-in.

## Website access

The website has no student signup, ordering, or delivery pages. Old web page
URLs redirect to the landing page, and their APIs return 404. The native Swift
app remains separate from the retired website ordering routes.

## Admin dashboard

Anyone who opens `/admin` sees the sign-in page; only admin credentials get
past it. Set `ADMIN_EMAIL` and a strong `ADMIN_PASSWORD` in `.env` (or as
environment variables on your host) for the owner account, then restart the
server. No web account or student signup is required. Keep both values private
and do not commit `.env`. A successful sign-in creates an internal admin record
only if the legacy dashboard database needs one for report messages.

The dashboard's **Admins** section lets any admin add more admins (name, email,
and a password of 12+ characters) or remove them. Added admins are stored in
Supabase, so apply `supabase/migrations/010_admin_accounts.sql` and set
`SUPABASE_URL` and `SUPABASE_SECRET_KEY`. The owner can't be removed from the
dashboard, and admins can't remove themselves. A removed admin loses access
within 30 seconds.

The overview and reported-order sections read the website's legacy database
(`db.json` locally, or Postgres with `DATABASE_URL`). Native iPhone orders are
shown separately in the dashboard's native-order testing section.

### Native order testing

Set `SUPABASE_URL` and a server-only `SUPABASE_SECRET_KEY` for the same Supabase
project as the iPhone app, then restart the server. Apply the native-app
migrations in `supabase/migrations/001_native_app.sql`,
`002_order_map.sql`, and `003_delivery_notifications.sql` if they are not
already applied. In `/admin`, create a test request using a native account
as the orderer and any native account as the test recipient, including the
orderer. Sign in to the recipient account on the simulator. The dashboard sends that account a delivery
offer without checking location. The app shows the open request on Deliver and
presents a local notification while it is running with notification permission.
For an existing dashboard-created open request, enter the recipient email and
choose **Send test offer**. Self-delivery is allowed only when that account has
a dashboard test offer for the order; ordinary app orders retain the self-delivery
restriction. To complete the request without a delivery trip, choose **Fulfill
for test**. This admin-only action does not charge the orderer.

When an order is marked delivered (by a tap or QR handoff, or **Fulfill for
test**), `supabase/migrations/007_native_delivery_payouts.sql` adds its payout
to the runner's test balance as a recorded credit. Each order pays out once.

The dashboard's **Store open overrides** section can force any listed dining
location open until an admin returns it to its official schedule. Apply
`supabase/migrations/009_store_hours_overrides.sql` to enable the shared state;
the iPhone app refreshes active overrides every 30 seconds.

### Native account test credits

The `/admin` dashboard can add test credits to native iPhone accounts. To enable
it, run `supabase/migrations/004_native_test_credits.sql` in the SQL editor of
the same Supabase project used by the Swift app. Set `SUPABASE_URL` and a
server-only `SUPABASE_SECRET_KEY` in `.env` (or your host's environment), then
restart the server. A legacy `SUPABASE_SERVICE_ROLE_KEY` also works. Never add
either secret to the iPhone app or public website files. [Supabase's RLS and
key guidance](https://supabase.com/docs/guides/database/secure-data) explains
why these keys must stay on the backend.

Search for a native account by full email, choose it, enter a dollar amount and
reason, and confirm. Each addition is recorded, and the app's Account page
shows the updated test balance when reopened or pulled to refresh. Credits are
not real deposits, cannot yet pay for orders, and cannot be withdrawn. Future
refunds will need a separate payment-aware flow rather than using this tool.

### Native card payments (Stripe)

The iPhone app charges real money through the server's Stripe account
(`native-payments.js`):

- **Orderers** add a card from Account → Add/Edit Payment Method, or when they
  first place an order. The card is entered on a Stripe-hosted page, so card
  numbers never reach NovaDash.
- **Runners** tap Account → Set Up Payouts to create a Stripe Express account
  for their bank details. Afterwards that row reads **Withdraw** and opens their
  Stripe dashboard. Stripe pays out to their bank automatically.
- When a runner **accepts** a request, the orderer's card is charged the
  delivery fee. The runner's 75% goes straight to their Stripe account, and the
  platform keeps 25% (`PLATFORM_CUT` in `payments.js`), which also covers
  Stripe's processing fee. Releasing within the 30-second window refunds the
  full fee. Dashboard test orders are never charged.

To turn it on:

1. Enable Connect (Express accounts) in the Stripe dashboard.
2. Set `STRIPE_SECRET_KEY` on Render. Use an `sk_test_` key first and save
   card `4242 4242 4242 4242`, then switch to the `sk_live_` key.
3. Run `supabase/migrations/011_native_payments.sql`. It also stops the app
   from accepting or releasing deliveries without the server, so app builds
   from before this change can no longer accept requests.

Without `STRIPE_SECRET_KEY`, deliveries are accepted without a charge and runners
earn test credits as before. There are no webhooks to configure. To refund an
order after the 30-second window, refund it in the Stripe dashboard with
**Reverse transfer** checked, so the runner's share comes back too.

## Deploying

`render.yaml` is a blueprint for [Render](https://render.com). Configure
`ADMIN_EMAIL` and `ADMIN_PASSWORD` in the Render environment for hosted admin
sign-in; your local `.env` is not uploaded. `SESSION_SECRET` is generated by
the blueprint.

(Vercel isn't a fit here — it's built for serverless functions/static sites, and this is a
persistent Express server with in-memory sessions and polling. Render runs it as a normal
always-on process, no rewrite needed.)

## Stack

Deliberately minimal so it's easy to read and extend:
- **Backend:** Node + Express, session-based admin auth.
- **Storage:** Postgres via Supabase when `DATABASE_URL` is set (`pgdb.js`), otherwise a local
  `db.json` file (`jsondb.js`) — `db.js` picks automatically. Both implement the same async
  interface, so nothing else in the app needs to know which one is active.
- **Frontend:** plain HTML/CSS/JS, no build step. The public page is informational.

Set a random `SESSION_SECRET` before deploying outside Render.

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
A SUPERCHARGED answer (within 0.5) recharges the battery by 5% (`SUPERCHARGE_BONUS`), never above
100%; because of that cap, charge is worked out question by question (`chargeTrack`), and each
saved game keeps its final charge (older games are re-scored from their total points off). **Hard mode** (a switch on the start screen) drains twice as fast (`HARD_DRAIN_RATE`), turns the
golds purple, and locks in once a puzzle's first guess is made; hard players get their own crowd
line (`mode` on crowd submissions) and their games are marked in stats and sharing. In the average
and best charge (and the spreadsheet's average charge left), a hard game counts as the charge the
same guesses would leave in regular mode, `(100 + hard charge) / 2` (`statsCharge`). The switch is
locked only while today's puzzle is under way: before it starts it sets the mode for the daily and
for endless runs, and once it's finished it sets the mode for endless runs only.
Dropping below 0% ends the game early: the city blacks out into silhouettes, the game fades away,
the view drifts slowly up into the night sky (Milky Way, nebulae, a ringed planet), and at the top
the player sees an "Out of charge" screen, with a UFO gliding across the sky under the top bar. An
endless run that runs out in daylight ends in a storm instead: clouds roll in, lightning knocks the
power out, and the view rises into the storm clouds. Exactly 0.0% survives.

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
| `POST /:date/check` | Agent | Check draft questions (`text`, `category`) for repeats before researching them; nothing is saved |

**Variety checks** (`percentle/variety.js`) keep the agent from repeating itself. Publishing a
puzzle is refused (400) if a question repeats an earlier daily or endless question (the same kind
of question about the same subject, even reworded or for another season), or if, within 14 days
of its date, it reuses a subject (team, person, film, brand, place) or a kind of question, or if
it has more than 2 questions of one category. Specials (with a `theme`) may repeat their event's
subjects and kinds.

Each question has `text` (ending in "?"), `answer` (strictly between 0 and 100, at most one
decimal), `category`, `funFact` (shown after the answer), `sourceName`, and an `https://`
`sourceUrl` (kept for checking, not shown). A question can instead have a **custom scale**,
`scale: { min, max, unit, prefix }` (for example `{ "min": 20000, "max": 120000, "prefix": "$" }` for a
salary, or `{ "min": 1, "max": 36, "unit": "points" }` for an ACT score): its answer must sit 10–90% of
the way along the scale and is rounded to the scale's step, about a thousandth of the range as a
power of ten (100 on a 100,000-wide range, 0.01 on 1–10). The game plays every question by where a
guess sits along its bar (0–100), so drain, supercharges and scores treat all scales alike, and it
shows guesses and answers in the scale's units. Categories are `U.S. life`, `Sports`, `Music`,
`Movies`, and `World`, in any mix: a day can have several questions from one category and
none from another. A puzzle can also carry an optional `theme` (3–40 characters, e.g. "World
Series Special"), which makes it a special: the game shows the title on the start screen and
in the share text. The agent only adds one after the editor approves the special by email.
The server rejects a puzzle that breaks these rules and lists every
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

### The night city and the bright-light look

A pixel-art city sits behind the game (`public/percentle/city.mjs`). It runs on the main battery:
every building has its own charge cut-off, so blocks go dark as the charge drains and the stars come
out as the city's glow fades. A supercharge strikes it with lightning along the screen edge, under
20% the last lights flicker, 0% is a blackout, and finishing with 60% or more (`FIREWORKS_AT`) sets
off fireworks. Hard mode turns it into a purple storm. In endless mode a clock runs from 9 PM, an
hour per round (`endlessClock` in `game.mjs`), through dawn, day and dusk into night 2, and the
sky, sun and moon follow it. The moon shows its real phase for the night (`moonPhase` in
`city.mjs`, counted in lunar months from a known new moon and checked in the tests against the U.S.
Naval Observatory's 2026 phase times). The scene is drawn once per screen width and then only switches
buildings and colors, and it holds still under reduced motion.

The city has life of its own (all in `city.mjs`; none of it plays on the start screen, after the
battery runs out, in a background tab, or with reduced motion):
- Windows flick on and off every few seconds in the buildings that have power.
- Visitors: one roll per new question, at least 25 seconds apart. A plane (25%), a shooting star at
  night (15%), a blimp with a CHARGLE.IO banner (7%), a helicopter sweeping a searchlight over the
  roofs late at night (8%), and a V of birds at dawn and dusk in endless (45%).
- A guess within 3 points (not a supercharge) sets off one firework; a perfect game (five
  supercharges) brings searchlights sweeping the sky on the results screen.
- A rooftop billboard shows the player's streak (2 days or more), otherwise CHARGLE and the puzzle
  number, or the best endless run. It goes dark with its building.
- Weather: one roll per day, seeded by the date so everyone sees the same sky (`weatherForDay` in
  `game.mjs`). Odds follow the season: winter about 30% snow and 10% fog, never rain; spring about 30%
  rain and 10% fog; summer about 20% rain; fall about 22% rain and 15% fog, with a little snow in
  March and November. Snow settles on the roofs while it's snowing, and in winter endless runs it
  falls and piles up round by round.
- Holidays by the Eastern date: Halloween (Oct 27-31: orange windows and moon, bats), December
  (colored lights along rooftops), New Year's (Dec 31-Jan 1) and the Fourth of July (Jul 3-5),
  with fireworks every few seconds.

On localhost, `?visitor=plane|shootingStar|blimp|helicopter|birds`, `?weather=rain|snow|fog|clear`
and `?holiday=halloween|december|newyear|july4|none` force those for testing (they survive `?reset`).

The palette is bright light rather than green: lit things look like a bulb, a white-hot face with a
gold halo, warming to amber (40%), orange (20%) and deep red (5%) as the battery drains. The
question's main button (Lock in, or Next) sits at the top right beside the question number, so the
bottom of the screen is left to the city.

### Endless mode

Players answer questions until their battery runs out (same drain and recharge as the daily),
from a bank of up to 500 questions per two-week period (periods start on launch day). The
agent adds sourced questions on every run (`percentle/AGENT_PROMPT.md`, Step 3b) and
emails the editor a 25-question sample when a bank reaches 500. A bank goes live once it has 250
questions; until then the previous period's is used, and before any exists the game says endless
mode is warming up. Unseen questions are asked first. Best runs are compared anonymously within
the period. A run takes the hard switch's setting when it starts: hard runs drain twice as fast,
are saved separately (`endless-hard:<startsOn>` progress, their own personal bests), and are
compared only with other hard runs (`mode` on `POST /runs`, with a separate anonymous ID). Routes are under `/api/percentle/endless`: `GET /bank` (players), `POST /runs`
(players, rate-limited), and, with the publish token, `GET /status`,
`POST /banks/:startsOn/questions` (batches of up to 50), `POST /banks/:startsOn/check` and
`POST /banks/:startsOn/remove`. The variety checks hold each bank to: no repeat of any banked or
daily question, at most 6 questions of one kind and 3 about one subject, at most 30% custom-scale questions (and 2 in a daily puzzle), and category caps
(Sports 38%, U.S. life 30%, World 30%, Movies 12%, Music 11%). Questions that fail are returned
in `rejected` with their reasons while the rest are added (422 if none are).
Banks and runs are stored in `percentle_endless_banks` / `percentle_endless_runs` with Postgres,
otherwise in `data/percentle-endless.json`.

### Accounts
Players can log in (the button at the top right, gone once they're logged in) with an email, a
username, and a password, so their stats follow them across devices. The browser keeps its save as
before; while logged in it also sends it to `PUT /api/percentle/accounts/state` a moment after each
change, and the server merges it with the account's save (`mergeStates` in `percentle/accounts.js`:
every game from either device, whichever device got further on a puzzle, all achievements, the
higher endless bests) and sends the result back, which the page adopts on logging in and on
opening. An endless run that's under way stays on its own device; its bests and run counts sync.
Routes under `/api/percentle/accounts`: `POST /signup`, `POST /login`, `POST /logout`, `GET /me`,
`PUT /state`, `POST /forgot`, `POST /reset`, `POST /delete`. Passwords are stored as salted scrypt hashes; sessions are a one-year `HttpOnly`,
`SameSite=Lax` cookie (`chargle_session`) whose token is stored only as a SHA-256 hash. Sign-ups
and log-ins are rate-limited per address. Accounts are stored in `percentle_accounts` /
`percentle_sessions` with Postgres, otherwise in `data/percentle-accounts.json`
(`PERCENTLE_ACCOUNTS_FILE`).

**Forgot password:** `POST /forgot` emails a one-time link (`/?password-token=...`, good for an hour,
stored only as a hash in `percentle_password_resets`); the page opens "Choose a new password", and
`POST /reset` sets it, logs the account out everywhere else, and logs it in. The answer is the same
whether or not the email has an account, and an account gets at most one link per two minutes.
Links always point at `CHARGLE_URL` (default `https://chargle.io`). Email goes through Resend
(`RESEND_API_KEY`, with `CHARGLE_MAIL_FROM` on a domain verified in Resend, e.g. `Chargle
<noreply@chargle.io>`), which works on hosts that block mail ports like Render's free plan, or any
SMTP account (`SMTP_HOST`, `SMTP_PORT` 465 or 587, `SMTP_USER`, `SMTP_PASS`); see `percentle/mailer.js`. Without them a live server answers
503 ("reset emails aren't set up yet"); a localhost server writes the link to its log instead.

**Local testing:** a server started with `CHARGLE_DEV=1` (never set on the live site) adds
`POST /dev-login` and `POST /dev-reset`: on localhost the page logs itself in to a test account
(`local_tester`), and `?reset` also empties that account's save, so a reset starts fresh while
staying logged in.

**Privacy:** a short note (what's kept and why, and how to delete it) is linked from the log-in box
and the stats dialog, and pops up once after a player first logs in or creates an account; the
"seen" mark is saved with their stats, so it's once across devices. **Delete account** (in the stats
dialog, password required, `POST /delete`) removes the account, its saved stats, sessions, and
reset links.

### Market
Logged-in players get a **Market** button at the top right (where Log in was; never both) to spend
coins on looks, in three tabs: **Visitors** (something of theirs that flies over the city on about 3
questions in 10: a paper plane, hot-air balloon, rocket, sky whale, dragon, or UFO; pixel art in
`city.mjs` `VISITOR_ART`), **Colors** (the battery, buttons, and city lights in Ice, Rose, Lime, Ember,
or Silver; hard mode stays purple), and **Lightning** (the supercharge bolt in blue, pink, green, red,
or rainbow). Items and prices are `MARKET_ITEMS` in `game.mjs`. Coins: a daily puzzle pays its final
charge (60% pays 60; hard games at their regular-mode equivalent; running out pays 0), and an
endless run pays more the farther it gets (10 rounds pay 40, 20 pay 100, 30 pay 180, 50 pay 400),
up to 150 a day from endless, or the day's best run if that pays more. Every game played
counts, including ones from before the market. The wallet (`state.wallet`: endless payouts, items
owned, and what's in use) is part of the save, so it syncs with the account; `mergeStates` keeps
every payout and purchase from both devices and the most recent pick in each tab. The results show
the coin total in their top corner, counting up to the new total after a game; it opens the market
(or log-in). Coins are kept in the browser's save, so a determined player could edit them; it's
only looks.

### Tests

Run the scoring, Eastern-date, puzzle-validation, puzzle API, and crowd tests with `npm test`.
No additional packages or build step are needed.

### Daily stats spreadsheet

Each browser gets a lasting random player ID (`percentle.player`, separate from the crowd IDs, so
it is never linked to a score). Once a day the page sends it with where the visit came from: a
`?ref=` tag such as `chargle.io/?ref=flyer` (removed from the address bar once read), else the
linking site, else "direct" (texts and most apps send nothing). Shares and endless runs are
counted against the same ID. Rows live in `percentle_visits` (or `data/percentle-stats.json`).

`GET /api/percentle/stats/daily.csv?key=...` returns one row per day, oldest first, from the first
day with data through today: players who opened the game, new and returning players, finishes,
hard-mode finishes, outs, average charge left (hard games at their regular-mode equivalent),
endless runs, shares, sources, and new and total accounts. Visit columns
are blank for days before tracking began. It needs `PERCENTLE_STATS_KEY` (unset turns it off),
and is meant for Excel's Data > From Web, set to refresh when the workbook opens.

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
