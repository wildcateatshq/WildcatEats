require("dotenv").config();
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const config = require("./config");
const db = require("./db");
const mailer = require("./mailer");
const notifications = require("./notifications");

const VERIFICATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 30 * 1000;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "wildcat-eats-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 1 week
  })
);

// ---------- helpers ----------

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(check));
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
  next();
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, phone: u.phone };
}

function publicOrder(o) {
  if (!o) return null;
  return {
    id: o.id,
    store: o.store,
    hall: o.hall,
    dropoffDetails: o.dropoffDetails,
    items: o.items,
    tip: o.tip,
    status: o.status,
    createdAt: o.createdAt,
    claimedAt: o.claimedAt,
    pickedUpAt: o.pickedUpAt,
    arrivedAt: o.arrivedAt,
    deliveredAt: o.deliveredAt,
    ordererName: o.ordererName,
    runnerName: o.runnerName
  };
}

function isVillanovaEmail(email) {
  return /^[^\s@]+@villanova\.edu$/i.test(email || "");
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

async function findOrderOr404(req, res) {
  const order = await db.getOrderById(req.params.id);
  if (!order) {
    res.status(404).json({ error: "Order not found." });
    return null;
  }
  return order;
}

// ---------- auth routes ----------

// Step 1 of signup: collect details, email a verification code. No account
// exists yet — it's held in pending_verifications until the code is confirmed.
app.post("/api/signup", async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: "Name, email, phone, and password are required." });
  }
  if (!isVillanovaEmail(email)) {
    return res.status(400).json({ error: "You need a villanova.edu email to sign up." });
  }
  const normalizedPhone = notifications.normalizePhone(phone);
  if (!normalizedPhone) {
    return res.status(400).json({ error: "Enter a valid 10-digit US phone number." });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters." });
  }

  const emailKey = email.toLowerCase();
  const existing = await db.getUserByEmail(emailKey);
  if (existing) {
    return res.status(400).json({ error: "An account with that email already exists." });
  }

  const code = generateCode();
  await db.setPendingVerification(emailKey, {
    name,
    phone: normalizedPhone,
    passwordHash: hashPassword(password),
    code,
    expiresAt: Date.now() + VERIFICATION_TTL_MS,
    lastSentAt: Date.now()
  });

  const result = await mailer.sendVerificationEmail(emailKey, code);
  res.json({
    pendingVerification: true,
    email: emailKey,
    // Only present when real email sending isn't configured yet — lets you
    // test the flow without a mail provider. See mailer.js / .env.example.
    devCode: result.sent ? undefined : code
  });
});

// Step 2 of signup: confirm the code, actually create the account, log them in.
app.post("/api/verify-email", async (req, res) => {
  const { email, code } = req.body || {};
  const emailKey = (email || "").toLowerCase();
  const pending = await db.getPendingVerification(emailKey);

  if (!pending) {
    return res.status(400).json({ error: "No pending signup for that email. Please sign up again." });
  }
  if (Date.now() > pending.expiresAt) {
    await db.deletePendingVerification(emailKey);
    return res.status(400).json({ error: "That code expired. Please sign up again." });
  }
  if (pending.code !== (code || "").trim()) {
    return res.status(400).json({ error: "Incorrect code." });
  }

  const user = await db.createUser({
    name: pending.name,
    email: emailKey,
    phone: pending.phone,
    passwordHash: pending.passwordHash
  });
  await db.deletePendingVerification(emailKey);

  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post("/api/resend-code", async (req, res) => {
  const { email } = req.body || {};
  const emailKey = (email || "").toLowerCase();
  const pending = await db.getPendingVerification(emailKey);
  if (!pending) {
    return res.status(400).json({ error: "No pending signup for that email. Please sign up again." });
  }
  if (Date.now() - pending.lastSentAt < RESEND_COOLDOWN_MS) {
    return res.status(429).json({ error: "Please wait a bit before requesting another code." });
  }

  const code = generateCode();
  await db.setPendingVerification(emailKey, {
    ...pending,
    code,
    expiresAt: Date.now() + VERIFICATION_TTL_MS,
    lastSentAt: Date.now()
  });

  const result = await mailer.sendVerificationEmail(emailKey, code);
  res.json({ ok: true, devCode: result.sent ? undefined : code });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  const emailKey = (email || "").toLowerCase();
  const user = await db.getUserByEmail(emailKey);
  if (!user || !verifyPassword(password || "", user.passwordHash)) {
    if (await db.getPendingVerification(emailKey)) {
      return res.status(401).json({ error: "Please verify your email first — check your inbox for the code." });
    }
    return res.status(401).json({ error: "Invalid email or password." });
  }
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", async (req, res) => {
  const user = req.session.userId ? await db.getUserById(req.session.userId) : null;
  res.json({ user: publicUser(user) });
});

app.get("/api/config", (req, res) => {
  res.json(config);
});

// ---------- order routes ----------

// Create a new order (place a food request)
app.post("/api/orders", requireAuth, async (req, res) => {
  const { store: storeName, hall, dropoffDetails, items, tip } = req.body || {};
  if (!storeName || !hall || !items) {
    return res.status(400).json({ error: "Store, hall, and items are required." });
  }
  const order = await db.createOrder({
    ordererId: req.session.userId,
    store: storeName,
    hall,
    dropoffDetails: dropoffDetails || "",
    items,
    tip: Number(tip) || 0
  });
  res.json({ order: publicOrder(order) });
});

// Open orders available to claim (not mine, not yet claimed)
app.get("/api/orders/open", requireAuth, async (req, res) => {
  const open = await db.getOpenOrders(req.session.userId);
  res.json({ orders: open.map(publicOrder) });
});

// Orders I placed
app.get("/api/orders/mine", requireAuth, async (req, res) => {
  const mine = await db.getOrdersByOrderer(req.session.userId);
  res.json({ orders: mine.map(publicOrder) });
});

// Orders I'm delivering
app.get("/api/orders/delivering", requireAuth, async (req, res) => {
  const mine = await db.getOrdersByRunner(req.session.userId);
  res.json({ orders: mine.map(publicOrder) });
});

// Claim an order to deliver
app.post("/api/orders/:id/claim", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.status !== "open") return res.status(400).json({ error: "Order already claimed." });
  if (order.ordererId === req.session.userId)
    return res.status(400).json({ error: "You can't deliver your own order." });

  const runner = await db.getUserById(req.session.userId);
  const updated = await db.updateOrder(order.id, {
    runnerId: req.session.userId,
    status: "claimed",
    claimedAt: Date.now()
  });

  const orderer = await db.getUserById(order.ordererId);
  if (orderer) {
    notifications.sendSms(
      orderer.phone,
      `WildcatEats: ${runner.name} claimed your order from ${order.store} and is heading over to grab it!`
    );
  }

  res.json({ order: publicOrder(updated) });
});

// Mark picked up from the store
app.post("/api/orders/:id/picked-up", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.runnerId !== req.session.userId) return res.status(403).json({ error: "Not your delivery." });
  if (order.status !== "claimed") return res.status(400).json({ error: "Wrong order status." });

  const updated = await db.updateOrder(order.id, { status: "picked_up", pickedUpAt: Date.now() });
  res.json({ order: publicOrder(updated) });
});

// "I'm here!" — notify the orderer the runner has arrived
app.post("/api/orders/:id/arrived", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.runnerId !== req.session.userId) return res.status(403).json({ error: "Not your delivery." });
  if (order.status !== "picked_up") return res.status(400).json({ error: "Wrong order status." });

  const updated = await db.updateOrder(order.id, { arrivedAt: Date.now() });

  const orderer = await db.getUserById(order.ordererId);
  if (orderer) {
    notifications.sendSms(orderer.phone, `WildcatEats: Your runner is here with your order from ${order.store}!`);
    notifications.makeCall(
      orderer.phone,
      `Hi, this is Wildcat Eats. Your delivery from ${order.store} has arrived. Go grab your food!`
    );
  }

  res.json({ order: publicOrder(updated) });
});

// Mark fully delivered / handed off
app.post("/api/orders/:id/delivered", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.runnerId !== req.session.userId) return res.status(403).json({ error: "Not your delivery." });
  if (order.status !== "picked_up") return res.status(400).json({ error: "Wrong order status." });

  const updated = await db.updateOrder(order.id, { status: "delivered", deliveredAt: Date.now() });
  res.json({ order: publicOrder(updated) });
});

// Cancel an order (only the orderer, only while still open)
app.post("/api/orders/:id/cancel", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.ordererId !== req.session.userId) return res.status(403).json({ error: "Not your order." });
  if (order.status !== "open") return res.status(400).json({ error: "Can't cancel after it's claimed." });

  await db.deleteOrder(order.id);
  res.json({ ok: true });
});

// Catch-all error handler — Express 5 forwards rejected async handlers here.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on our end." });
});

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WildcatEats running at http://localhost:${PORT} (storage: ${db.backend})`);
    });
  })
  .catch((err) => {
    console.error("Failed to set up the database:", err.message);
    process.exit(1);
  });
