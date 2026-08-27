// Zero-dependency JSON-file storage. Used automatically when DATABASE_URL
// isn't set — good for quick local testing, but the file (and everyone's
// accounts/orders) resets on every restart if you're on ephemeral hosting.
// See pgdb.js for the real Postgres-backed version.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "db.json");

function load() {
  if (!fs.existsSync(FILE)) {
    return { users: [], orders: [], pendingVerifications: {}, nextUserId: 1, nextOrderId: 1 };
  }
  const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (!data.pendingVerifications) data.pendingVerifications = {};
  return data;
}

function save() {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

let db = load();

function withOrderNames(o) {
  const orderer = db.users.find((u) => u.id === o.ordererId);
  const runner = db.users.find((u) => u.id === o.runnerId);
  return { ...o, ordererName: orderer ? orderer.name : "Unknown", runnerName: runner ? runner.name : null };
}

async function init() {}

async function getUserByEmail(email) {
  return db.users.find((u) => u.email.toLowerCase() === (email || "").toLowerCase()) || null;
}

async function getUserById(id) {
  return db.users.find((u) => u.id === Number(id)) || null;
}

async function createUser({ name, email, phone, passwordHash }) {
  const user = { id: db.nextUserId++, name, email, phone, passwordHash };
  db.users.push(user);
  save();
  return user;
}

async function getPendingVerification(emailKey) {
  return db.pendingVerifications[emailKey] || null;
}

async function setPendingVerification(emailKey, data) {
  db.pendingVerifications[emailKey] = { ...data, email: emailKey };
  save();
}

async function deletePendingVerification(emailKey) {
  delete db.pendingVerifications[emailKey];
  save();
}

async function createOrder({ ordererId, store, hall, dropoffDetails, items, tip }) {
  const order = {
    id: db.nextOrderId++,
    ordererId,
    runnerId: null,
    store,
    hall,
    dropoffDetails: dropoffDetails || "",
    items,
    tip: Number(tip) || 0,
    status: "open",
    createdAt: Date.now(),
    claimedAt: null,
    pickedUpAt: null,
    arrivedAt: null,
    deliveredAt: null
  };
  db.orders.push(order);
  save();
  return withOrderNames(order);
}

async function getOrderById(id) {
  const o = db.orders.find((o) => o.id === Number(id));
  return o ? withOrderNames(o) : null;
}

async function getOpenOrders(excludeUserId) {
  return db.orders.filter((o) => o.status === "open" && o.ordererId !== excludeUserId).map(withOrderNames);
}

async function getOrdersByOrderer(userId) {
  return db.orders
    .filter((o) => o.ordererId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(withOrderNames);
}

async function getOrdersByRunner(userId) {
  return db.orders
    .filter((o) => o.runnerId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(withOrderNames);
}

async function updateOrder(id, patch) {
  const o = db.orders.find((o) => o.id === Number(id));
  if (!o) return null;
  Object.assign(o, patch);
  save();
  return withOrderNames(o);
}

async function deleteOrder(id) {
  db.orders = db.orders.filter((o) => o.id !== Number(id));
  save();
}

module.exports = {
  backend: "json-file",
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
