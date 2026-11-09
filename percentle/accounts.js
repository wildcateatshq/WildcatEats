"use strict";

// Player accounts: an email, a username, and a password, so a player's stats and runs follow them
// across devices. The game keeps its save data in the browser as before; a signed-in browser also
// sends it here, where it's merged with what the account already has (mergeStates) and handed back.
// Passwords are only ever stored as salted scrypt hashes, and sessions as hashes of their tokens.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { easternDate } = require("./puzzles");

const scrypt = promisify(crypto.scrypt);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const SESSION_DAYS = 365;
// A password-reset link works for an hour, and only once.
const RESET_MINUTES = 60;
// A save is small (a few kilobytes a month of daily play); this leaves years of room.
const MAX_STATE_BYTES = 512 * 1024;

// The email or username is already taken.
class AccountTaken extends Error {}

function validateSignup({ email, username, password } = {}) {
  const problems = [];
  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const cleanName = typeof username === "string" ? username.trim() : "";
  if (!EMAIL_PATTERN.test(cleanEmail) || cleanEmail.length > 254) problems.push("Enter a valid email address.");
  if (!USERNAME_PATTERN.test(cleanName)) problems.push("Usernames are 3 to 20 letters, numbers, or underscores.");
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    problems.push(`Passwords need at least ${MIN_PASSWORD} characters.`);
  }
  if (problems.length) throw new RangeError(problems.join(" "));
  return { email: cleanEmail, username: cleanName, password };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(String(password), Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// A new session: the token goes to the browser in a cookie; only its hash is stored.
function newSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) };
}

// A password-reset link's token: sent in the email; only its hash is stored.
function newReset() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000) };
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new RangeError(`Passwords need at least ${MIN_PASSWORD} characters.`);
  }
  return password;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// A save sent by a browser: the game's state ({ games, progress, achievements, endless }). Only its
// overall shape and size are checked here; its coins, games, and purchases are never trusted, but
// worked out again from its guesses (verify.js).
function validateState(state) {
  if (!isObject(state)) throw new RangeError("state must be an object.");
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw new RangeError("That save is too large.");
  if (state.games !== undefined && !Array.isArray(state.games)) throw new RangeError("state.games must be a list.");
  for (const key of ["progress", "achievements", "endless"]) {
    if (state[key] !== undefined && !isObject(state[key])) throw new RangeError(`state.${key} must be an object.`);
  }
  return state;
}

// Two saves combined, so playing on two devices never loses anything:
//   - games: every day played on either; a day played on both keeps the one already saved here;
//   - progress (each puzzle or endless run): whichever got further;
//   - achievements: everything earned on either, keeping the first time it was earned;
//   - endless bests and run counts: the higher of the two.
// `saved` is what the account had; `incoming` is the browser's.
function mergeStates(saved, incoming) {
  const a = isObject(saved) ? saved : {};
  const b = isObject(incoming) ? incoming : {};
  const games = new Map();
  for (const game of [...(a.games || []), ...(b.games || [])]) {
    if (isObject(game) && typeof game.date === "string" && !games.has(game.date)) games.set(game.date, game);
  }
  const progress = { ...(b.progress || {}) };
  for (const [key, entry] of Object.entries(a.progress || {})) {
    const other = progress[key];
    const reach = value => (Array.isArray(value?.guesses) ? value.guesses.length : -1);
    if (!other || reach(entry) >= reach(other)) progress[key] = entry;
  }
  const endlessA = isObject(a.endless) ? a.endless : {}, endlessB = isObject(b.endless) ? b.endless : {};
  const higher = (x, y) => Math.max(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0);
  const bests = (x = {}, y = {}) => {
    const out = { ...y };
    for (const [key, value] of Object.entries(x)) out[key] = higher(value, out[key]);
    return out;
  };
  // The market wallet: coins from every endless run on either device, everything bought on either,
  // and in each category whichever device picked something most recently.
  const walletA = isObject(a.wallet) ? a.wallet : {}, walletB = isObject(b.wallet) ? b.wallet : {};
  const equipped = { ...(walletB.equipped || {}) };
  for (const [category, pick] of Object.entries(walletA.equipped || {})) {
    if (!equipped[category] || (pick?.at ?? 0) >= (equipped[category]?.at ?? 0)) equipped[category] = pick;
  }
  return {
    ...b,
    ...a,
    wallet: {
      endless: { ...(walletB.endless || {}), ...(walletA.endless || {}) },
      owned: { ...(walletB.owned || {}), ...(walletA.owned || {}) },
      equipped
    },
    games: [...games.values()].sort((x, y) => x.date.localeCompare(y.date)),
    progress,
    achievements: { ...(b.achievements || {}), ...(a.achievements || {}) },
    // When the privacy note was last read: the later of the two, so a newer note read on one device
    // isn't shown again on the next.
    ...([a.privacyNoticeSeen, b.privacyNoticeSeen].some(seen => typeof seen === "string")
      ? { privacyNoticeSeen: [a.privacyNoticeSeen, b.privacyNoticeSeen].filter(seen => typeof seen === "string").sort().at(-1) }
      : {}),
    endless: {
      ...endlessB,
      ...endlessA,
      best: bests(endlessA.best, endlessB.best),
      hardBest: bests(endlessA.hardBest, endlessB.hardBest),
      allTime: higher(endlessA.allTime, endlessB.allTime),
      hardAllTime: higher(endlessA.hardAllTime, endlessB.hardAllTime),
      runs: higher(endlessA.runs, endlessB.runs)
    }
  };
}

// Accounts whose email is in CHARGLE_OWNER_EMAILS (comma-separated, set on Render) belong to the
// game's owner: the page gives them every market item for free.
const isOwner = email => (process.env.CHARGLE_OWNER_EMAILS || "").split(",")
  .map(owner => owner.trim().toLowerCase()).filter(Boolean).includes(String(email).toLowerCase());
const publicAccount = account => ({ username: account.username, email: account.email, ...(isOwner(account.email) ? { owner: true } : {}) });

function createAccountStore(options = {}) {
  const filePath = options.filePath || process.env.PERCENTLE_ACCOUNTS_FILE || path.join(__dirname, "..", "data", "percentle-accounts.json");
  const pool = options.pool || (options.filePath || !process.env.DATABASE_URL
    ? null
    : new (require("pg").Pool)({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }));
  // File storage: { accounts: [{ id, email, username, passwordHash, createdAt, state }],
  // sessions: { tokenHash: { accountId, expiresAt } }, resets: { tokenHash: { accountId, expiresAt, createdAt, used } } }
  let data = { accounts: [], sessions: {}, resets: {} };
  let writes = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  // File writes go one at a time so concurrent requests can't lose each other's changes.
  function queued(change) {
    const operation = writes.then(async () => {
      const result = await change();
      await persist();
      return result;
    });
    writes = operation.catch(() => {});
    return operation;
  }

  async function init() {
    if (pool) {
      await pool.query(`
        create table if not exists percentle_accounts (
          id uuid primary key,
          email text not null unique,
          username text not null,
          username_key text not null unique,
          password_hash text not null,
          state jsonb,
          created_at timestamptz not null default now()
        )
      `);
      await pool.query(`
        create table if not exists percentle_sessions (
          token_hash text primary key,
          account_id uuid not null references percentle_accounts(id) on delete cascade,
          expires_at timestamptz not null
        )
      `);
      await pool.query(`
        create table if not exists percentle_password_resets (
          token_hash text primary key,
          account_id uuid not null references percentle_accounts(id) on delete cascade,
          expires_at timestamptz not null,
          created_at timestamptz not null default now(),
          used boolean not null default false
        )
      `);
      return;
    }
    try {
      const loaded = JSON.parse(await fs.readFile(filePath, "utf8"));
      data = { accounts: loaded.accounts || [], sessions: loaded.sessions || {}, resets: loaded.resets || {} };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function createAccount({ email, username, passwordHash }) {
    const account = { id: crypto.randomUUID(), email, username, passwordHash, createdAt: new Date().toISOString() };
    if (pool) {
      try {
        await pool.query(
          "insert into percentle_accounts (id, email, username, username_key, password_hash) values ($1, $2, $3, $4, $5)",
          [account.id, email, username, username.toLowerCase(), passwordHash]
        );
      } catch (error) {
        if (error.code === "23505") throw new AccountTaken(/username/.test(error.constraint || error.detail || "") ? "username" : "email");
        throw error;
      }
      return account;
    }
    return queued(() => {
      if (data.accounts.some(other => other.email === email)) throw new AccountTaken("email");
      if (data.accounts.some(other => other.username.toLowerCase() === username.toLowerCase())) throw new AccountTaken("username");
      data.accounts.push({ ...account, state: null });
      return account;
    });
  }

  async function findByEmail(email) {
    if (pool) {
      const { rows } = await pool.query("select id, email, username, password_hash as \"passwordHash\" from percentle_accounts where email = $1", [email]);
      return rows[0] || null;
    }
    return data.accounts.find(account => account.email === email) || null;
  }

  async function createSession(accountId, { tokenHash, expiresAt }) {
    if (pool) {
      await pool.query("insert into percentle_sessions (token_hash, account_id, expires_at) values ($1, $2, $3)", [tokenHash, accountId, expiresAt]);
      return;
    }
    await queued(() => {
      data.sessions[tokenHash] = { accountId, expiresAt: expiresAt.toISOString() };
    });
  }

  // The account a session token belongs to, or null if there's none (or it has expired).
  async function accountForSession(tokenHash) {
    if (pool) {
      const { rows } = await pool.query(
        `select a.id, a.email, a.username from percentle_sessions s join percentle_accounts a on a.id = s.account_id
         where s.token_hash = $1 and s.expires_at > now()`,
        [tokenHash]
      );
      return rows[0] || null;
    }
    const session = data.sessions[tokenHash];
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
    return data.accounts.find(account => account.id === session.accountId) || null;
  }

  async function deleteSession(tokenHash) {
    if (pool) {
      await pool.query("delete from percentle_sessions where token_hash = $1", [tokenHash]);
      return;
    }
    await queued(() => {
      delete data.sessions[tokenHash];
    });
  }

  // Merges a browser's save into the account's and returns the result, one change at a time per
  // account so two devices saving together can't undo each other.
  async function mergeState(accountId, incoming) {
    return updateState(accountId, saved => mergeStates(saved, incoming));
  }

  // Replaces an account's save with `change(saved)` (which may be async) and returns the new save.
  // One change runs at a time per account, so two devices saving together can't undo each other.
  async function updateState(accountId, change) {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const { rows } = await client.query("select state from percentle_accounts where id = $1 for update", [accountId]);
        const next = await change(rows[0]?.state ?? null);
        await client.query("update percentle_accounts set state = $2 where id = $1", [accountId, JSON.stringify(next)]);
        await client.query("commit");
        return next;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    // File storage: the change is worked out before the write queue, then applied only if nothing
    // else changed this save in the meantime (otherwise it's worked out again).
    for (;;) {
      const account = data.accounts.find(item => item.id === accountId);
      const before = account.state;
      const next = await change(before ?? null);
      const applied = await queued(() => {
        if (account.state !== before) return false;
        account.state = next;
        return true;
      });
      if (applied) return next;
    }
  }

  // A password-reset link for an account. Returns false (and makes none) if one was made in the
  // last couple of minutes, so a form pressed again and again can't flood someone's inbox.
  async function createReset(accountId, { tokenHash, expiresAt }) {
    if (pool) {
      const { rows } = await pool.query(
        "select 1 from percentle_password_resets where account_id = $1 and created_at > now() - interval '2 minutes'", [accountId]
      );
      if (rows.length) return false;
      await pool.query("insert into percentle_password_resets (token_hash, account_id, expires_at) values ($1, $2, $3)", [tokenHash, accountId, expiresAt]);
      return true;
    }
    return queued(() => {
      const recent = Object.values(data.resets).some(reset => reset.accountId === accountId && Date.now() - Date.parse(reset.createdAt) < 120_000);
      if (recent) return false;
      data.resets[tokenHash] = { accountId, expiresAt: expiresAt.toISOString(), createdAt: new Date().toISOString(), used: false };
      return true;
    });
  }

  // Uses up a password-reset link: sets the new password and logs the account out everywhere.
  // Returns the account, or null if the link is unknown, used, or expired.
  async function resetPassword(tokenHash, passwordHash) {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const { rows } = await client.query(
          "update percentle_password_resets set used = true where token_hash = $1 and not used and expires_at > now() returning account_id", [tokenHash]
        );
        if (!rows.length) {
          await client.query("rollback");
          return null;
        }
        const accountId = rows[0].account_id;
        const updated = await client.query("update percentle_accounts set password_hash = $2 where id = $1 returning id, email, username", [accountId, passwordHash]);
        await client.query("delete from percentle_sessions where account_id = $1", [accountId]);
        await client.query("commit");
        return updated.rows[0];
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    return queued(() => {
      const reset = data.resets[tokenHash];
      if (!reset || reset.used || Date.parse(reset.expiresAt) <= Date.now()) return null;
      reset.used = true;
      const account = data.accounts.find(item => item.id === reset.accountId);
      if (!account) return null;
      account.passwordHash = passwordHash;
      for (const [hash, session] of Object.entries(data.sessions)) if (session.accountId === account.id) delete data.sessions[hash];
      return account;
    });
  }

  // Deletes an account with its saved stats, sessions, and reset links.
  async function deleteAccount(accountId) {
    if (pool) {
      await pool.query("delete from percentle_accounts where id = $1", [accountId]);
      return;
    }
    await queued(() => {
      data.accounts = data.accounts.filter(account => account.id !== accountId);
      for (const [hash, session] of Object.entries(data.sessions)) if (session.accountId === accountId) delete data.sessions[hash];
      for (const [hash, reset] of Object.entries(data.resets)) if (reset.accountId === accountId) delete data.resets[hash];
    });
  }

  // The stored password hash for an account (to confirm a deletion).
  async function passwordHashFor(accountId) {
    if (pool) {
      const { rows } = await pool.query("select password_hash from percentle_accounts where id = $1", [accountId]);
      return rows[0]?.password_hash || null;
    }
    return data.accounts.find(account => account.id === accountId)?.passwordHash || null;
  }

  // Empties an account's saved stats (for local testing's ?reset).
  async function clearState(accountId) {
    if (pool) {
      await pool.query("update percentle_accounts set state = null where id = $1", [accountId]);
      return;
    }
    await queued(() => {
      const account = data.accounts.find(item => item.id === accountId);
      if (account) account.state = null;
    });
  }

  // New accounts per Eastern day, for the stats spreadsheet: [{ date, accounts }].
  async function dailySignups() {
    if (pool) {
      const { rows } = await pool.query(
        `select to_char(created_at at time zone 'America/New_York', 'YYYY-MM-DD') as date, count(*)::int as accounts
         from percentle_accounts group by 1`
      );
      return rows;
    }
    const days = new Map();
    for (const account of data.accounts) {
      const date = easternDate(new Date(account.createdAt));
      days.set(date, (days.get(date) || 0) + 1);
    }
    return [...days].map(([date, accounts]) => ({ date, accounts }));
  }

  return {
    init, createAccount, findByEmail, createSession, accountForSession, deleteSession, mergeState, updateState, dailySignups,
    createReset, resetPassword, deleteAccount, passwordHashFor, clearState
  };
}

module.exports = {
  AccountTaken, RESET_MINUTES, createAccountStore, hashPassword, hashToken, isOwner, mergeStates, newReset, newSession, publicAccount,
  validatePassword, validateSignup, validateState, verifyPassword
};
