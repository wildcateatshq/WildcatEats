// Real Postgres storage (e.g. Supabase). Used automatically whenever
// DATABASE_URL is set. Creates its own tables on startup if they don't exist
// yet, so there's no separate migration step.
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    create table if not exists users (
      id serial primary key,
      name text not null,
      email text not null unique,
      phone text not null,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists pending_verifications (
      email text primary key,
      name text not null,
      phone text not null,
      password_hash text not null,
      code text not null,
      expires_at timestamptz not null,
      last_sent_at timestamptz not null
    );
  `);
  await pool.query(`
    create table if not exists orders (
      id serial primary key,
      orderer_id integer not null references users(id),
      runner_id integer references users(id),
      store text not null,
      hall text not null,
      dropoff_details text not null default '',
      items text not null,
      tip numeric not null default 0,
      status text not null default 'open',
      created_at timestamptz not null default now(),
      claimed_at timestamptz,
      picked_up_at timestamptz,
      arrived_at timestamptz,
      delivered_at timestamptz
    );
  `);
}

function rowToUser(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, email: r.email, phone: r.phone, passwordHash: r.password_hash };
}

function rowToOrder(r) {
  if (!r) return null;
  return {
    id: r.id,
    ordererId: r.orderer_id,
    runnerId: r.runner_id,
    store: r.store,
    hall: r.hall,
    dropoffDetails: r.dropoff_details,
    items: r.items,
    tip: Number(r.tip),
    status: r.status,
    createdAt: r.created_at.getTime(),
    claimedAt: r.claimed_at ? r.claimed_at.getTime() : null,
    pickedUpAt: r.picked_up_at ? r.picked_up_at.getTime() : null,
    arrivedAt: r.arrived_at ? r.arrived_at.getTime() : null,
    deliveredAt: r.delivered_at ? r.delivered_at.getTime() : null,
    ordererName: r.orderer_name,
    runnerName: r.runner_name || null
  };
}

const ORDER_SELECT = `
  select o.*, ou.name as orderer_name, ru.name as runner_name
  from orders o
  join users ou on ou.id = o.orderer_id
  left join users ru on ru.id = o.runner_id
`;

async function getUserByEmail(email) {
  const { rows } = await pool.query("select * from users where lower(email) = lower($1)", [email || ""]);
  return rowToUser(rows[0]);
}

async function getUserById(id) {
  const { rows } = await pool.query("select * from users where id = $1", [id]);
  return rowToUser(rows[0]);
}

async function createUser({ name, email, phone, passwordHash }) {
  const { rows } = await pool.query(
    "insert into users (name, email, phone, password_hash) values ($1,$2,$3,$4) returning *",
    [name, email, phone, passwordHash]
  );
  return rowToUser(rows[0]);
}

async function getPendingVerification(emailKey) {
  const { rows } = await pool.query("select * from pending_verifications where email = $1", [emailKey]);
  const r = rows[0];
  if (!r) return null;
  return {
    name: r.name,
    email: r.email,
    phone: r.phone,
    passwordHash: r.password_hash,
    code: r.code,
    expiresAt: r.expires_at.getTime(),
    lastSentAt: r.last_sent_at.getTime()
  };
}

async function setPendingVerification(emailKey, data) {
  await pool.query(
    `insert into pending_verifications (email, name, phone, password_hash, code, expires_at, last_sent_at)
     values ($1,$2,$3,$4,$5,to_timestamp($6 / 1000.0),to_timestamp($7 / 1000.0))
     on conflict (email) do update set
       name = excluded.name, phone = excluded.phone, password_hash = excluded.password_hash,
       code = excluded.code, expires_at = excluded.expires_at, last_sent_at = excluded.last_sent_at`,
    [emailKey, data.name, data.phone, data.passwordHash, data.code, data.expiresAt, data.lastSentAt]
  );
}

async function deletePendingVerification(emailKey) {
  await pool.query("delete from pending_verifications where email = $1", [emailKey]);
}

async function createOrder({ ordererId, store, hall, dropoffDetails, items, tip }) {
  const { rows } = await pool.query(
    `insert into orders (orderer_id, store, hall, dropoff_details, items, tip)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [ordererId, store, hall, dropoffDetails || "", items, Number(tip) || 0]
  );
  return getOrderById(rows[0].id);
}

async function getOrderById(id) {
  const { rows } = await pool.query(`${ORDER_SELECT} where o.id = $1`, [id]);
  return rowToOrder(rows[0]);
}

async function getOpenOrders(excludeUserId) {
  const { rows } = await pool.query(
    `${ORDER_SELECT} where o.status = 'open' and o.orderer_id <> $1 order by o.created_at desc`,
    [excludeUserId]
  );
  return rows.map(rowToOrder);
}

async function getOrdersByOrderer(userId) {
  const { rows } = await pool.query(`${ORDER_SELECT} where o.orderer_id = $1 order by o.created_at desc`, [userId]);
  return rows.map(rowToOrder);
}

async function getOrdersByRunner(userId) {
  const { rows } = await pool.query(`${ORDER_SELECT} where o.runner_id = $1 order by o.created_at desc`, [userId]);
  return rows.map(rowToOrder);
}

// Maps our camelCase patch keys to columns; timestamp fields are passed as ms and converted.
const TIMESTAMP_FIELDS = new Set(["claimedAt", "pickedUpAt", "arrivedAt", "deliveredAt"]);
const FIELD_COLUMN = {
  runnerId: "runner_id",
  status: "status",
  claimedAt: "claimed_at",
  pickedUpAt: "picked_up_at",
  arrivedAt: "arrived_at",
  deliveredAt: "delivered_at"
};

async function updateOrder(id, patch) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(patch)) {
    const col = FIELD_COLUMN[key];
    if (!col) continue;
    if (TIMESTAMP_FIELDS.has(key)) {
      sets.push(`${col} = to_timestamp($${i} / 1000.0)`);
    } else {
      sets.push(`${col} = $${i}`);
    }
    values.push(value);
    i++;
  }
  if (sets.length === 0) return getOrderById(id);
  values.push(id);
  await pool.query(`update orders set ${sets.join(", ")} where id = $${i}`, values);
  return getOrderById(id);
}

async function deleteOrder(id) {
  await pool.query("delete from orders where id = $1", [id]);
}

module.exports = {
  backend: "postgres",
  init,
  getUserByEmail,
  getUserById,
  createUser,
  getPendingVerification,
  setPendingVerification,
  deletePendingVerification,
  createOrder,
  getOrderById,
  getOpenOrders,
  getOrdersByOrderer,
  getOrdersByRunner,
  updateOrder,
  deleteOrder
};
