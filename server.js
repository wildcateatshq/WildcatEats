require("dotenv").config();
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const config = require("./config");
const db = require("./db");
const mailer = require("./mailer");
const notifications = require("./notifications");
const payments = require("./payments");

const VERIFICATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 30 * 1000;

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1); // Render sits behind a proxy — needed for correct https:// URLs (Stripe Connect links)

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

// Gated on ADMIN_EMAIL rather than a DB role — this app has exactly one
// admin (whoever runs it), so a normal account matching that env var is
// enough. No ADMIN_EMAIL set means the admin tooling is fully disabled.
async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
  const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
  if (!adminEmail) return res.status(403).json({ error: "Admin tools aren't configured on this server." });
  const user = await db.getUserById(req.session.userId);
  if (!user || user.email.toLowerCase() !== adminEmail) {
    return res.status(403).json({ error: "Not authorized." });
  }
  next();
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, stripeOnboarded: Boolean(u.stripeOnboarded) };
}

// forRunner: runners see what THEY earn, never the full fee the orderer
// paid — the platform's cut isn't any of their business to see.
function publicOrder(o, { forRunner = false } = {}) {
  if (!o) return null;
  return {
    id: o.id,
    store: o.store,
    hall: o.hall,
    dropoffDetails: o.dropoffDetails,
    items: o.items,
    ...(forRunner ? { runnerEarnings: Math.round(o.tip * (1 - payments.PLATFORM_CUT) * 100) / 100 } : { tip: o.tip }),
    status: o.status,
    createdAt: o.createdAt,
    claimedAt: o.claimedAt,
    pickedUpAt: o.pickedUpAt,
    arrivedAt: o.arrivedAt,
    deliveredAt: o.deliveredAt,
    ordererName: o.ordererName,
    runnerName: o.runnerName,
    paymentStatus: o.paymentStatus,
    disputeReason: o.disputeReason,
    disputedAt: o.disputedAt,
    refundedAt: o.refundedAt,
    runnerLat: o.runnerLat,
    runnerLng: o.runnerLng,
    runnerLocationAt: o.runnerLocationAt
  };
}

function isParticipant(order, userId) {
  return order.ordererId === userId || order.runnerId === userId;
}

function publicMessage(m, viewerId) {
  return {
    id: m.id,
    orderId: m.orderId,
    senderId: m.senderId,
    senderName: m.senderName,
    text: m.text,
    createdAt: m.createdAt,
    mine: m.senderId === viewerId
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

app.get("/api/stripe/config", (req, res) => {
  res.json({ enabled: payments.enabled, publishableKey: payments.publishableKey, minFee: payments.MIN_FEE_DOLLARS });
});

app.get("/api/mapbox/config", (req, res) => {
  const token = process.env.MAPBOX_TOKEN || "";
  res.json({ enabled: Boolean(token), token });
});

// ---------- order routes ----------

// Step 1 of placing an order: save a card against the orderer's Stripe
// Customer (no charge yet — that happens when a runner claims the order).
// The frontend confirms this SetupIntent client-side with Stripe.js.
app.post("/api/orders/setup-intent", requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    const customerId = await payments.getOrCreateCustomer(user);
    if (customerId !== user.stripeCustomerId) {
      await db.updateUser(user.id, { stripeCustomerId: customerId });
    }
    const setupIntent = await payments.createSetupIntent(customerId);
    res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new order (place a food request). Requires a card already saved
// via /api/orders/setup-intent — the resulting payment method is what gets
// charged once someone claims it.
app.post("/api/orders", requireAuth, async (req, res) => {
  const { store: storeName, hall, dropoffDetails, items, tip, stripePaymentMethodId } = req.body || {};
  if (!storeName || !hall || !items) {
    return res.status(400).json({ error: "Store, hall, and items are required." });
  }
  const feeAmount = Number(tip);
  if (!feeAmount || feeAmount < payments.MIN_FEE_DOLLARS) {
    return res.status(400).json({ error: `Delivery fee must be at least $${payments.MIN_FEE_DOLLARS}.` });
  }
  if (payments.enabled && !stripePaymentMethodId) {
    return res.status(400).json({ error: "Add a payment method for the delivery fee before posting." });
  }
  const order = await db.createOrder({
    ordererId: req.session.userId,
    store: storeName,
    hall,
    dropoffDetails: dropoffDetails || "",
    items,
    tip: feeAmount,
    stripePaymentMethodId: stripePaymentMethodId || null
  });
  res.json({ order: publicOrder(order) });
});

// Open orders available to claim — includes your own posted orders too
// (you're allowed to claim/deliver those yourself; see the claim route).
app.get("/api/orders/open", requireAuth, async (req, res) => {
  const open = await db.getOpenOrders();
  res.json({ orders: open.map((o) => publicOrder(o, { forRunner: true })) });
});

// Orders I placed
app.get("/api/orders/mine", requireAuth, async (req, res) => {
  const mine = await db.getOrdersByOrderer(req.session.userId);
  res.json({ orders: mine.map((o) => publicOrder(o)) });
});

// Orders I'm delivering
app.get("/api/orders/delivering", requireAuth, async (req, res) => {
  const mine = await db.getOrdersByRunner(req.session.userId);
  res.json({ orders: mine.map((o) => publicOrder(o, { forRunner: true })) });
});

// ---------- runner payouts (Stripe Connect) ----------

// Kicks off (or resumes) a runner's payout onboarding. Returns a one-time
// Stripe-hosted URL to redirect the browser to — can't be done from inside
// a fetch(), the frontend does `window.location.href = url`.
app.post("/api/stripe/connect/start", requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    let accountId = user.stripeAccountId;
    if (!accountId) {
      accountId = await payments.createConnectAccount(user);
      await db.updateUser(user.id, { stripeAccountId: accountId });
    }
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const link = await payments.createAccountLink(
      accountId,
      `${baseUrl}/deliver.html?stripe_refresh=1`,
      `${baseUrl}/deliver.html?stripe_return=1`
    );
    res.json({ url: link.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called when the runner lands back from Stripe's hosted onboarding —
// checks whether their account is actually ready to receive transfers yet.
app.post("/api/stripe/connect/check", requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    if (!user.stripeAccountId) return res.json({ onboarded: false });
    const ready = await payments.isAccountReady(user.stripeAccountId);
    if (ready !== user.stripeOnboarded) {
      await db.updateUser(user.id, { stripeOnboarded: ready });
    }
    res.json({ onboarded: ready });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim an order to deliver
app.post("/api/orders/:id/claim", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.status !== "open") return res.status(400).json({ error: "Order already claimed." });

  const runner = await db.getUserById(req.session.userId);

  if (payments.enabled) {
    if (!runner.stripeOnboarded || !runner.stripeAccountId) {
      return res
        .status(400)
        .json({ error: "Set up payouts before claiming a delivery — see the banner above." });
    }
    const orderer = await db.getUserById(order.ordererId);
    if (!orderer.stripeCustomerId || !order.stripePaymentMethodId) {
      return res.status(400).json({ error: "This order's payment method is missing — it can't be claimed." });
    }
    try {
      const paymentIntent = await payments.chargeDeliveryFee({
        customerId: orderer.stripeCustomerId,
        paymentMethodId: order.stripePaymentMethodId,
        runnerAccountId: runner.stripeAccountId,
        amountDollars: order.tip
      });
      await db.updateOrder(order.id, {
        stripePaymentIntentId: paymentIntent.id,
        paymentStatus: "paid"
      });
    } catch (err) {
      return res.status(402).json({
        error: `Payment failed (${err.message}) — this order is still open for someone else.`
      });
    }
  }

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

  res.json({ order: publicOrder(updated, { forRunner: true }) });
});

// Runner's live GPS while actively delivering — only accepted while
// claimed/picked_up, only the assigned runner can post it. The orderer
// picks it up via their own polling of /api/orders/mine.
app.post("/api/orders/:id/location", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.runnerId !== req.session.userId) return res.status(403).json({ error: "Not your delivery." });
  if (order.status !== "claimed" && order.status !== "picked_up") {
    return res.status(400).json({ error: "This delivery isn't active." });
  }
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: "Invalid coordinates." });
  }
  await db.updateOrder(order.id, { runnerLat: lat, runnerLng: lng, runnerLocationAt: Date.now() });
  res.json({ ok: true });
});

// Mark picked up from the store
app.post("/api/orders/:id/picked-up", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.runnerId !== req.session.userId) return res.status(403).json({ error: "Not your delivery." });
  if (order.status !== "claimed") return res.status(400).json({ error: "Wrong order status." });

  const updated = await db.updateOrder(order.id, { status: "picked_up", pickedUpAt: Date.now() });
  res.json({ order: publicOrder(updated, { forRunner: true }) });
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

  res.json({ order: publicOrder(updated, { forRunner: true }) });
});

// Mark fully delivered / handed off
app.post("/api/orders/:id/delivered", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.runnerId !== req.session.userId) return res.status(403).json({ error: "Not your delivery." });
  if (order.status !== "picked_up") return res.status(400).json({ error: "Wrong order status." });

  // Clear the runner's location once the delivery's done — no reason to
  // keep sharing (or storing) where they are after this point.
  const updated = await db.updateOrder(order.id, {
    status: "delivered",
    deliveredAt: Date.now(),
    runnerLat: null,
    runnerLng: null,
    runnerLocationAt: null
  });
  res.json({ order: publicOrder(updated, { forRunner: true }) });
});

// ---------- messages (orderer <-> runner, once claimed) ----------

app.get("/api/orders/:id/messages", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (!isParticipant(order, req.session.userId)) return res.status(403).json({ error: "Not your order." });
  if (!order.runnerId) return res.status(400).json({ error: "No one has claimed this order yet." });

  const messages = await db.getMessagesByOrder(order.id);
  res.json({ messages: messages.map((m) => publicMessage(m, req.session.userId)) });
});

app.post("/api/orders/:id/messages", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (!isParticipant(order, req.session.userId)) return res.status(403).json({ error: "Not your order." });
  if (!order.runnerId) return res.status(400).json({ error: "No one has claimed this order yet." });

  const text = (req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Message can't be empty." });
  if (text.length > 1000) return res.status(400).json({ error: "Message is too long." });

  const message = await db.createMessage({ orderId: order.id, senderId: req.session.userId, text });
  res.json({ message: publicMessage(message, req.session.userId) });
});

// Orderer reports a problem with a delivered order (e.g. never actually
// got the food) — flags it for admin review, doesn't refund automatically.
app.post("/api/orders/:id/report", requireAuth, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.ordererId !== req.session.userId) return res.status(403).json({ error: "Not your order." });
  if (order.status !== "delivered") return res.status(400).json({ error: "Can only report a delivered order." });
  if (order.disputedAt) return res.status(400).json({ error: "This order was already reported." });

  const reason = (req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Tell us what happened." });
  if (reason.length > 1000) return res.status(400).json({ error: "That's a bit long — keep it under 1000 characters." });

  const updated = await db.updateOrder(order.id, { disputeReason: reason, disputedAt: Date.now() });
  res.json({ order: publicOrder(updated) });
});

// ---------- admin (dispute review) ----------

app.get("/api/admin/reports", requireAdmin, async (req, res) => {
  const reports = await db.getDisputedOrders();
  res.json({ orders: reports.map((o) => publicOrder(o)) });
});

// Refunds the orderer and tries to reverse the runner's transfer too. If the
// runner already cashed out, the transfer can't be clawed back — the
// response says so, and that money needs recovering from the runner directly.
app.post("/api/admin/orders/:id/refund", requireAdmin, async (req, res) => {
  const order = await findOrderOr404(req, res);
  if (!order) return;
  if (order.paymentStatus !== "paid") return res.status(400).json({ error: "This order isn't in a refundable state." });
  if (!order.stripePaymentIntentId) return res.status(400).json({ error: "No payment on record for this order." });

  try {
    const { transferReversed } = await payments.refundPayment(order.stripePaymentIntentId);
    const updated = await db.updateOrder(order.id, { paymentStatus: "refunded", refundedAt: Date.now() });
    res.json({
      order: publicOrder(updated),
      transferReversed,
      warning: transferReversed
        ? undefined
        : "Refunded the orderer, but the runner already cashed out — recover their share manually."
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
