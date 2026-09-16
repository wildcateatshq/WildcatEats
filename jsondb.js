// Zero-dependency JSON-file storage. Used automatically when DATABASE_URL
// isn't set — good for quick local testing, but the file (and everyone's
// accounts/orders) resets on every restart if you're on ephemeral hosting.
// See pgdb.js for the real Postgres-backed version.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "db.json");

function load() {
  if (!fs.existsSync(FILE)) {
    return {
      users: [],
      orders: [],
      messages: [],
      pendingVerifications: {},
      nextUserId: 1,
      nextOrderId: 1,
      nextMessageId: 1
    };
  }
  const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (!data.pendingVerifications) data.pendingVerifications = {};
  if (!data.messages) data.messages = [];
  if (!data.nextMessageId) data.nextMessageId = 1;
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
  return normalizeUser(db.users.find((u) => u.email.toLowerCase() === (email || "").toLowerCase()) || null);
}

async function getUserById(id) {
  return normalizeUser(db.users.find((u) => u.id === Number(id)) || null);
}

function normalizeUser(u) {
  if (!u) return null;
  return { stripeCustomerId: null, stripeAccountId: null, stripeOnboarded: false, ...u };
}

async function createUser({ name, email, phone, passwordHash }) {
  const user = {
    id: db.nextUserId++,
    name,
    email,
    phone,
    passwordHash,
    stripeCustomerId: null,
    stripeAccountId: null,
    stripeOnboarded: false
  };
  db.users.push(user);
  save();
  return user;
}

async function updateUser(id, patch) {
  const u = db.users.find((u) => u.id === Number(id));
  if (!u) return null;
  Object.assign(u, patch);
  save();
  return normalizeUser(u);
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

async function createOrder({ ordererId, store, hall, dropoffDetails, items, tip, stripePaymentMethodId }) {
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
    deliveredAt: null,
    stripePaymentMethodId: stripePaymentMethodId || null,
    stripePaymentIntentId: null,
    paymentStatus: "unpaid",
    disputeReason: null,
    disputedAt: null,
    refundedAt: null,
    runnerLat: null,
    runnerLng: null,
    runnerLocationAt: null
  };
  db.orders.push(order);
  save();
  return withOrderNames(order);
}

async function getOrderById(id) {
  const o = db.orders.find((o) => o.id === Number(id));
  return o ? withOrderNames(o) : null;
}

async function getOpenOrders() {
  return db.orders.filter((o) => o.status === "open").map(withOrderNames);
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

async function getDisputedOrders() {
  return db.orders
    .filter((o) => o.disputedAt)
    .sort((a, b) => b.disputedAt - a.disputedAt)
    .map(withOrderNames);
}

function withMessageSender(m) {
  const sender = db.users.find((u) => u.id === m.senderId);
  return { ...m, senderName: sender ? sender.name : "Unknown" };
}

// threadUserId is null for the normal orderer<->runner thread on an order,
// or a specific user id for a private admin<->that-user side channel on the
// same order — keeps the two kinds of conversation from mixing.
async function getMessagesByOrder(orderId, threadUserId = null) {
  return db.messages
    .filter((m) => m.orderId === Number(orderId) && (m.threadUserId || null) === (threadUserId || null))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(withMessageSender);
}

async function createMessage({ orderId, senderId, text, threadUserId = null }) {
  const message = {
    id: db.nextMessageId++,
    orderId: Number(orderId),
    senderId,
    text,
    threadUserId: threadUserId || null,
    createdAt: Date.now()
  };
  db.messages.push(message);
  save();
  return withMessageSender(message);
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
  deleteOrder,
  getMessagesByOrder,
  createMessage,
  updateUser,
  getDisputedOrders
};
