// Real payments for the native app. The app signs in with Supabase, so these
// routes take its Supabase access token instead of a web session.
//   - Orderers save a card on a Stripe-hosted Checkout page (setup mode).
//   - Runners connect a payout account (Stripe Connect Express).
//   - Accepting a delivery charges the orderer's card for the delivery fee;
//     the runner's share goes straight to their Stripe account and the
//     platform keeps PLATFORM_CUT. Releasing in the 30-second window refunds it.
// Without STRIPE_SECRET_KEY, deliveries are accepted without a charge and the
// runner earns test credits instead (migration 011).
const crypto = require("node:crypto");
const express = require("express");
const payments = require("./payments");
const { nativeRequest, isDashboardTestOrder } = require("./native-orders");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKOUT_SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const RELEASE_WINDOW_MS = 30 * 1000;
const TEST_OFFER_TITLE = "Test delivery request";
const APP_CALLBACK = "novadash://stripe";
const RETURN_KINDS = new Set(["card", "card-cancel", "payouts", "payouts-refresh"]);

function runnerCents(amountCents) {
  return amountCents - Math.round(amountCents * payments.PLATFORM_CUT);
}

// ---------- Supabase sign-in ----------

// Access tokens are checked with Supabase, then remembered briefly so a
// screen that makes a few calls doesn't check the same token each time.
const tokenCache = new Map(); // sha256(token) -> { user, at }
const TOKEN_CACHE_MS = 60 * 1000;

async function supabaseUser(token) {
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_CACHE_MS) return hit.user;
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const apiKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!/^https:\/\/[^/]+$/.test(base) || !apiKey) {
    const error = new Error("Native payments need SUPABASE_URL and SUPABASE_SECRET_KEY on the server.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${base}/auth/v1/user`, { headers: { apikey: apiKey, Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  if (!UUID.test(payload?.id || "")) return null;
  const user = { id: payload.id.toLowerCase(), email: payload.email || "" };
  if (tokenCache.size > 1000) tokenCache.clear();
  tokenCache.set(key, { user, at: Date.now() });
  return user;
}

async function requireNativeUser(req, res, next) {
  const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(req.get("Authorization") || "");
  try {
    const user = match ? await supabaseUser(match[1]) : null;
    if (!user) return res.status(401).json({ error: "Please sign in again." });
    req.nativeUser = user;
    next();
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
}

// ---------- stored Stripe IDs ----------

async function paymentAccount(userID) {
  const rows = await nativeRequest("native_payment_accounts", { select: "*", user_id: `eq.${userID}`, limit: "1" });
  return rows[0] || null;
}

async function savePaymentAccount(userID, fields) {
  const rows = await nativeRequest("native_payment_accounts", { on_conflict: "user_id" }, {
    method: "POST", upsert: true,
    body: { user_id: userID, ...fields, updated_at: new Date().toISOString() }
  });
  return rows[0];
}

// A stored ID can belong to the other Stripe mode (test vs live) or have been
// deleted in Stripe; both look valid but every call on them fails.
async function stillExists(retrieve) {
  try {
    const object = await retrieve();
    return object && !object.deleted ? object : null;
  } catch (_) {
    return null;
  }
}

function payoutsReady(account) {
  return Boolean(account && account.capabilities?.transfers === "active" && account.payouts_enabled);
}

function baseURL(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function sendError(res, error) {
  res.status(error.status || 502).json({ error: error.message });
}

function createNativePaymentsRouter({ stripe = payments.client } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(requireNativeUser);

  function requireStripe(res) {
    if (stripe) return true;
    res.status(503).json({ error: "Card payments aren't set up on the server yet." });
    return false;
  }

  async function ensureCustomer(user, account) {
    if (account?.stripe_customer_id && await stillExists(() => stripe.customers.retrieve(account.stripe_customer_id))) {
      return account.stripe_customer_id;
    }
    const profiles = await nativeRequest("native_profiles", { select: "name,email", id: `eq.${user.id}`, limit: "1" });
    const customer = await stripe.customers.create({
      email: profiles[0]?.email || user.email || undefined,
      name: profiles[0]?.name || undefined,
      metadata: { native_user_id: user.id }
    });
    // A new customer starts without a card, so forget any old one.
    await savePaymentAccount(user.id, { stripe_customer_id: customer.id, payment_method_id: null, card_brand: null, card_last4: null });
    return customer.id;
  }

  // Rechecks a runner's payout account with Stripe and stores the result.
  async function refreshPayouts(userID, account) {
    if (!account?.stripe_account_id) return { connected: false, ready: false, stripeAccount: null };
    const stripeAccount = await stillExists(() => stripe.accounts.retrieve(account.stripe_account_id));
    const ready = payoutsReady(stripeAccount);
    if (ready !== account.payouts_ready) await savePaymentAccount(userID, { payouts_ready: ready });
    return { connected: Boolean(stripeAccount), ready, stripeAccount };
  }

  router.get("/payments", async (req, res) => {
    try {
      const account = await paymentAccount(req.nativeUser.id);
      const card = account?.payment_method_id ? { brand: account.card_brand || "card", last4: account.card_last4 || "" } : null;
      if (!stripe) {
        return res.json({ enabled: false, card: null, payouts: { connected: false, ready: false }, balanceCents: null, runnerShare: 1 - payments.PLATFORM_CUT });
      }
      const payouts = await refreshPayouts(req.nativeUser.id, account);
      let balanceCents = null;
      if (payouts.stripeAccount) {
        const balance = await stripe.balance.retrieve({}, { stripeAccount: payouts.stripeAccount.id });
        balanceCents = [...(balance.available || []), ...(balance.pending || [])]
          .filter((entry) => entry.currency === "usd")
          .reduce((sum, entry) => sum + entry.amount, 0);
      }
      res.json({
        enabled: true,
        card,
        payouts: { connected: payouts.connected, ready: payouts.ready },
        balanceCents,
        runnerShare: 1 - payments.PLATFORM_CUT
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Returns a Stripe-hosted page where the orderer enters a card. When it's
  // saved, Stripe sends them to /native/stripe/return, which hands the
  // Checkout session ID back to the app for /payments/card/confirm.
  router.post("/payments/card", async (req, res) => {
    if (!requireStripe(res)) return;
    try {
      const customer = await ensureCustomer(req.nativeUser, await paymentAccount(req.nativeUser.id));
      const base = baseURL(req);
      const session = await stripe.checkout.sessions.create({
        mode: "setup",
        currency: "usd",
        customer,
        payment_method_types: ["card"],
        // {CHECKOUT_SESSION_ID} is filled in by Stripe, so it must stay unencoded.
        success_url: `${base}/native/stripe/return?kind=card&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/native/stripe/return?kind=card-cancel`,
        metadata: { native_user_id: req.nativeUser.id }
      });
      res.json({ url: session.url });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/payments/card/confirm", async (req, res) => {
    if (!requireStripe(res)) return;
    const sessionID = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
    if (!CHECKOUT_SESSION.test(sessionID)) return res.status(400).json({ error: "That card setup link isn't valid." });
    try {
      const account = await paymentAccount(req.nativeUser.id);
      const session = await stripe.checkout.sessions.retrieve(sessionID, { expand: ["setup_intent.payment_method"] });
      const customerID = typeof session.customer === "string" ? session.customer : session.customer?.id;
      if (!account?.stripe_customer_id || customerID !== account.stripe_customer_id) {
        return res.status(403).json({ error: "That card setup belongs to a different account." });
      }
      const method = session.setup_intent?.payment_method;
      if (session.status !== "complete" || session.setup_intent?.status !== "succeeded" || !method?.id) {
        return res.status(400).json({ error: "Your card wasn't saved. Try adding it again." });
      }
      await stripe.customers.update(customerID, { invoice_settings: { default_payment_method: method.id } });
      if (account.payment_method_id && account.payment_method_id !== method.id) {
        await stripe.paymentMethods.detach(account.payment_method_id).catch(() => {});
      }
      const card = { brand: method.card?.brand || "card", last4: method.card?.last4 || "" };
      await savePaymentAccount(req.nativeUser.id, { payment_method_id: method.id, card_brand: card.brand, card_last4: card.last4 || null });
      res.json({ card });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Starts or resumes payout setup. Once the account is ready, returns a link
  // to the runner's Stripe Express dashboard (balance, payouts, bank) instead.
  router.post("/payments/payouts", async (req, res) => {
    if (!requireStripe(res)) return;
    try {
      const account = await paymentAccount(req.nativeUser.id);
      let { stripeAccount } = await refreshPayouts(req.nativeUser.id, account);
      if (stripeAccount && payoutsReady(stripeAccount)) {
        const login = await stripe.accounts.createLoginLink(stripeAccount.id);
        return res.json({ url: login.url, kind: "dashboard" });
      }
      if (!stripeAccount) {
        stripeAccount = await stripe.accounts.create({
          type: "express",
          country: "US",
          email: req.nativeUser.email || undefined,
          capabilities: { transfers: { requested: true } },
          metadata: { native_user_id: req.nativeUser.id }
        });
        await savePaymentAccount(req.nativeUser.id, { stripe_account_id: stripeAccount.id, payouts_ready: false });
      }
      const base = baseURL(req);
      const link = await stripe.accountLinks.create({
        account: stripeAccount.id,
        refresh_url: `${base}/native/stripe/return?kind=payouts-refresh`,
        return_url: `${base}/native/stripe/return?kind=payouts`,
        type: "account_onboarding"
      });
      res.json({ url: link.url, kind: "onboarding" });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Accepting a delivery: claim it first so only one runner can win, then
  // charge. If the charge fails the order goes back to the open list.
  router.post("/orders/:id/claim", async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid order ID." });
    const orderID = req.params.id.toLowerCase();
    const runnerID = req.nativeUser.id;
    try {
      const orders = await nativeRequest("native_orders", { select: "id,orderer_id,runner_id,status,tip,store", id: `eq.${orderID}`, limit: "1" });
      const order = orders[0];
      if (!order || order.status !== "open" || order.runner_id) {
        return res.status(409).json({ error: "Another student has already accepted this request." });
      }
      const testOrder = await isDashboardTestOrder(orderID).catch(() => false);
      if (order.orderer_id === runnerID) {
        const offers = await nativeRequest("native_delivery_notifications", {
          select: "id", order_id: `eq.${orderID}`, recipient_id: `eq.${runnerID}`, title: `eq.${TEST_OFFER_TITLE}`, limit: "1"
        }).catch(() => []);
        if (!offers.length) return res.status(400).json({ error: "You cannot accept your own order." });
      }

      const amountCents = Math.round(Number(order.tip) * 100);
      const charge = Boolean(stripe) && !testOrder && amountCents > 0;
      let runnerAccount = null;
      let ordererAccount = null;
      if (charge) {
        if (amountCents < Math.round(payments.MIN_FEE_DOLLARS * 100)) {
          return res.status(400).json({ error: "This order's delivery fee is too small to charge." });
        }
        runnerAccount = await paymentAccount(runnerID);
        if (!runnerAccount?.payouts_ready) {
          const payouts = await refreshPayouts(runnerID, runnerAccount);
          if (!payouts.ready) {
            return res.status(409).json({ error: "Set up payouts in Account before accepting deliveries, so we can pay you.", code: "payouts_required" });
          }
        }
        ordererAccount = await paymentAccount(order.orderer_id);
        if (!ordererAccount?.stripe_customer_id || !ordererAccount?.payment_method_id) {
          return res.status(409).json({ error: "This customer hasn't added a card yet, so the request can't be accepted." });
        }
      }

      const claimedAt = new Date().toISOString();
      const claimed = await nativeRequest("native_orders", { id: `eq.${orderID}`, status: "eq.open", runner_id: "is.null" }, {
        method: "PATCH", body: { runner_id: runnerID, status: "claimed", claimed_at: claimedAt }
      });
      if (!claimed.length) return res.status(409).json({ error: "Another student has already accepted this request." });
      if (!charge) return res.json({ ok: true, charged: false });

      let intent;
      try {
        intent = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: "usd",
          customer: ordererAccount.stripe_customer_id,
          payment_method: ordererAccount.payment_method_id,
          off_session: true,
          confirm: true,
          application_fee_amount: amountCents - runnerCents(amountCents),
          transfer_data: { destination: runnerAccount.stripe_account_id },
          description: `NovaDash delivery fee: ${order.store}`,
          metadata: { native_order_id: orderID, runner_id: runnerID }
        }, { idempotencyKey: `native-claim-${orderID}-${claimedAt}` });
        if (intent.status !== "succeeded") throw new Error(`payment ${intent.status}`);
      } catch (error) {
        console.error(`Delivery fee charge failed for native order ${orderID}:`, error.message);
        await nativeRequest("native_orders", { id: `eq.${orderID}`, runner_id: `eq.${runnerID}`, status: "eq.claimed" }, {
          method: "PATCH", body: { runner_id: null, status: "open", claimed_at: null }
        }).catch((revertError) => console.error(`Could not reopen native order ${orderID}:`, revertError.message));
        return res.status(402).json({ error: "The customer's card was declined, so this request couldn't be accepted." });
      }

      try {
        await nativeRequest("native_order_payments", {}, { method: "POST", body: {
          order_id: orderID,
          payment_intent_id: intent.id,
          orderer_id: order.orderer_id,
          runner_id: runnerID,
          amount_cents: amountCents,
          runner_cents: runnerCents(amountCents),
          status: "paid"
        } });
      } catch (error) {
        // The money moved and the order is claimed; only our record is missing.
        console.error(`Charged ${intent.id} for native order ${orderID} but could not record it:`, error.message);
      }
      res.json({ ok: true, charged: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  // The 30-second window after accepting (migration 008). Puts the order back
  // in the open list and refunds the orderer, runner's share included.
  router.post("/orders/:id/release", async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid order ID." });
    const orderID = req.params.id.toLowerCase();
    const runnerID = req.nativeUser.id;
    try {
      const cutoff = new Date(Date.now() - RELEASE_WINDOW_MS).toISOString();
      const released = await nativeRequest("native_orders", {
        id: `eq.${orderID}`, runner_id: `eq.${runnerID}`, status: "eq.claimed", claimed_at: `gt.${cutoff}`
      }, { method: "PATCH", body: { runner_id: null, status: "open", claimed_at: null } });
      if (!released.length) {
        const rows = await nativeRequest("native_orders", { select: "runner_id,status", id: `eq.${orderID}`, limit: "1" });
        const stillMine = rows[0]?.runner_id === runnerID && rows[0]?.status === "claimed";
        return res.status(409).json({ error: stillMine ? "The 30-second cancellation window has ended." : "This delivery is no longer assigned to you." });
      }
      await nativeRequest("native_delivery_handoffs", { order_id: `eq.${orderID}` }, { method: "DELETE" }).catch(() => {});

      const paid = await nativeRequest("native_order_payments", {
        select: "id,payment_intent_id", order_id: `eq.${orderID}`, runner_id: `eq.${runnerID}`, status: "eq.paid"
      });
      let warning = null;
      for (const payment of paid) {
        try {
          await stripe.refunds.create(
            { payment_intent: payment.payment_intent_id, reverse_transfer: true, refund_application_fee: true },
            { idempotencyKey: `native-release-${payment.id}` }
          );
          await nativeRequest("native_order_payments", { id: `eq.${payment.id}` }, {
            method: "PATCH", body: { status: "refunded", refunded_at: new Date().toISOString() }
          });
        } catch (error) {
          console.error(`Refund failed for ${payment.payment_intent_id} (native order ${orderID}):`, error.message);
          warning = "The delivery was released, but the customer's refund needs a manual check.";
        }
      }
      res.json({ ok: true, warning });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

// Where Stripe's hosted pages send people back to. The app opens those pages
// in a secure browser sheet that closes when it sees the novadash:// address.
function nativeStripeReturn(req, res) {
  const kind = RETURN_KINDS.has(req.query.kind) ? req.query.kind : "card-cancel";
  const params = new URLSearchParams({ kind });
  if (kind === "card" && CHECKOUT_SESSION.test(req.query.session_id || "")) params.set("session_id", req.query.session_id);
  res.set("Cache-Control", "no-store");
  res.redirect(302, `${APP_CALLBACK}?${params}`);
}

module.exports = { createNativePaymentsRouter, nativeStripeReturn, runnerCents };
