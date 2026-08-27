// Texts and calls the orderer's phone when a runner claims / arrives.
//
// Configure real sending via env vars (see .env.example):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//
// Until those are set, this just logs what *would* have been sent, so the
// rest of the app works fully before you set up a Twilio account.

const configured = !!(
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_FROM_NUMBER
);

let client = null;
if (configured) {
  client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Very light US-centric normalization: "6105551234" / "(610) 555-1234" -> "+16105551234"
function normalizePhone(raw) {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null; // not a recognizable US number
}

async function sendSms(toPhone, body) {
  if (!configured) {
    console.log(`\n[notifications] TWILIO NOT CONFIGURED (see .env.example).`);
    console.log(`[notifications] Would text ${toPhone}: "${body}"\n`);
    return { sent: false };
  }
  try {
    await client.messages.create({ to: toPhone, from: process.env.TWILIO_FROM_NUMBER, body });
    return { sent: true };
  } catch (err) {
    console.error(`[notifications] SMS to ${toPhone} failed:`, err.message);
    return { sent: false, error: err.message };
  }
}

async function makeCall(toPhone, message) {
  if (!configured) {
    console.log(`\n[notifications] TWILIO NOT CONFIGURED (see .env.example).`);
    console.log(`[notifications] Would call ${toPhone} and say: "${message}"\n`);
    return { sent: false };
  }
  try {
    // `twiml` lets us describe the call script inline — no public webhook needed.
    const twiml = `<Response><Say voice="Polly.Joanna">${message}</Say></Response>`;
    await client.calls.create({ to: toPhone, from: process.env.TWILIO_FROM_NUMBER, twiml });
    return { sent: true };
  } catch (err) {
    console.error(`[notifications] Call to ${toPhone} failed:`, err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendSms, makeCall, normalizePhone, configured };
