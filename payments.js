// Stripe integration for the delivery fee: orderers save a card (Setup
// Intent + a Stripe Customer), runners connect a payout account (Stripe
// Connect Express). When a runner claims an order, the fee is charged and
// split automatically — the runner's share transfers straight to their
// connected account, the platform's cut (PLATFORM_CUT) stays behind.
// Nothing here runs until STRIPE_SECRET_KEY is set.
const Stripe = require("stripe");

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const PLATFORM_CUT = 0.25; // runner keeps 75%, platform keeps 25%
const MIN_FEE_DOLLARS = 1; // Stripe's own card minimum is $0.50; we round up for headroom

function requireStripe() {
  if (!stripe) throw new Error("Payments aren't configured on this server yet.");
  return stripe;
}

async function getOrCreateCustomer(user) {
  const s = requireStripe();
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await s.customers.create({ email: user.email, name: user.name });
  return customer.id;
}

async function createSetupIntent(customerId) {
  const s = requireStripe();
  // Card only, explicitly — the frontend mounts a plain card element, not
  // the redirect-capable Payment Element, so automatic payment methods
  // (which include Klarna/Bancontact/etc, and demand a return_url) don't fit.
  return s.setupIntents.create({ customer: customerId, usage: "off_session", payment_method_types: ["card"] });
}

async function createConnectAccount(user) {
  const s = requireStripe();
  const account = await s.accounts.create({
    type: "express",
    country: "US",
    email: user.email,
    capabilities: { transfers: { requested: true } }
  });
  return account.id;
}

async function createAccountLink(accountId, refreshUrl, returnUrl) {
  const s = requireStripe();
  return s.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding"
  });
}

async function isAccountReady(accountId) {
  const s = requireStripe();
  const account = await s.accounts.retrieve(accountId);
  return Boolean(account.charges_enabled && account.payouts_enabled);
}

// Charges the orderer's saved card for the delivery fee and splits it in
// the same call: `PLATFORM_CUT` of it stays on the platform's balance as
// an application fee, the rest transfers directly to the runner's account.
async function chargeDeliveryFee({ customerId, paymentMethodId, runnerAccountId, amountDollars }) {
  const s = requireStripe();
  const amountCents = Math.round(amountDollars * 100);
  const applicationFeeCents = Math.round(amountCents * PLATFORM_CUT);
  return s.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    customer: customerId,
    payment_method: paymentMethodId,
    off_session: true,
    confirm: true,
    application_fee_amount: applicationFeeCents,
    transfer_data: { destination: runnerAccountId }
  });
}

module.exports = {
  enabled: Boolean(stripe),
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
  PLATFORM_CUT,
  MIN_FEE_DOLLARS,
  getOrCreateCustomer,
  createSetupIntent,
  createConnectAccount,
  createAccountLink,
  isAccountReady,
  chargeDeliveryFee
};
