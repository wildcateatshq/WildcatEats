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
      messageReads: [],
      pushSubscriptions: [],
      nextUserId: 1,
      nextOrderId: 1,
      nextMessageId: 1
    };
  }
  const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (!data.pendingVerifications) data.pendingVerifications = {};
  if (!data.messages) data.messages = [];
  if (!data.nextMessageId) data.nextMessageId = 1;
  if (!data.messageReads) data.messageReads = [];
  if (!data.pushSubscriptions) data.pushSubscriptions = [];
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

async function createOrder({ ordererId, store, hall, dropoffDetails, items, orderNumber, tip, stripePaymentMethodId }) {
  const order = {
    id: db.nextOrderId++,
    ordererId,
    runnerId: null,
    store,
    hall,
    dropoffDetails: dropoffDetails || "",
    items,
    orderNumber: orderNumber || "",
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

// "Active" = currently out on a delivery, or finished one within the last 2
// minutes. Used to power the live "delivering now" counter.
async function getActiveDeliveryOrders() {
  const cutoff = Date.now() - 2 * 60 * 1000;
  return db.orders.filter((o) =>
    o.status === "claimed" ||
    o.status === "picked_up" ||
    (o.status === "delivered" && o.deliveredAt && o.deliveredAt > cutoff)
  );
}

// Powers the pricing engine's real-time demand signal — counts orders
// created in [fromMs, toMs), e.g. "the past hour" or "this same hour a
// week ago".
async function countOrdersCreatedInRange(fromMs, toMs) {
  return db.orders.filter((o) => o.createdAt >= fromMs && o.createdAt < toMs).length;
}

// Average minutes-to-claim for orders claimed within [fromMs, toMs) —
// how fast runners are actually picking up work right now.
async function getAvgClaimTimeMinutes(fromMs, toMs) {
  const claimed = db.orders.filter((o) => o.claimedAt && o.claimedAt >= fromMs && o.claimedAt < toMs);
  if (claimed.length === 0) return null;
  const totalMinutes = claimed.reduce((sum, o) => sum + (o.claimedAt - o.createdAt) / 60000, 0);
  return totalMinutes / claimed.length;
}

// Buckets recent orders by delivery fee (nearest $0.50) to approximate the
// spec's historicalData.pricing_by_point — real claim-rate-by-price signal
// drawn from actual order history, not fabricated numbers. Buckets with too
// few orders to be meaningful are left out.
async function getPricingHistory(sinceMs, minSampleSize = 3) {
  const recent = db.orders.filter((o) => o.createdAt >= sinceMs);
  const buckets = new Map();
  for (const o of recent) {
    const key = (Math.round(o.tip * 2) / 2).toFixed(2);
    if (!buckets.has(key)) buckets.set(key, { total: 0, claimed: 0, claimMinutesSum: 0 });
    const bucket = buckets.get(key);
    bucket.total++;
    if (o.claimedAt) {
      bucket.claimed++;
      bucket.claimMinutesSum += (o.claimedAt - o.createdAt) / 60000;
    }
  }
  const result = {};
  for (const [price, bucket] of buckets) {
    if (bucket.total < minSampleSize) continue;
    result[price] = {
      claim_rate: Math.round((bucket.claimed / bucket.total) * 100) / 100,
      avg_claim_time_minutes: bucket.claimed > 0 ? Math.round((bucket.claimMinutesSum / bucket.claimed) * 10) / 10 : null
    };
  }
  return result;
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

// Drives the unread badge — one row per (user, thread) recording when that
// user last actually opened it. No row yet means "never opened."
async function getLastRead(userId, threadKey) {
  const row = db.messageReads.find((r) => r.userId === userId && r.threadKey === threadKey);
  return row ? row.lastReadAt : null;
}

async function markThreadRead(userId, threadKey) {
  const row = db.messageReads.find((r) => r.userId === userId && r.threadKey === threadKey);
  if (row) row.lastReadAt = Date.now();
  else db.messageReads.push({ userId, threadKey, lastReadAt: Date.now() });
  save();
}

// A user can have several push subscriptions (one per browser/device) —
// all of them get a push when they get a message.
async function addPushSubscription(userId, subscription) {
  db.pushSubscriptions = db.pushSubscriptions.filter((s) => s.endpoint !== subscription.endpoint);
  db.pushSubscriptions.push({ userId, ...subscription, createdAt: Date.now() });
  save();
}

async function removePushSubscription(endpoint) {
  db.pushSubscriptions = db.pushSubscriptions.filter((s) => s.endpoint !== endpoint);
  save();
}

async function getPushSubscriptionsForUser(userId) {
  return db.pushSubscriptions.filter((s) => s.userId === userId);
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
  getDisputedOrders,
  getActiveDeliveryOrders,
  countOrdersCreatedInRange,
  getAvgClaimTimeMinutes,
  getPricingHistory,
  getLastRead,
  markThreadRead,
  addPushSubscription,
  removePushSubscription,
  getPushSubscriptionsForUser
};
