// Sends the villanova.edu signup verification code.
//
// Configure real sending via env vars (see .env.example):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//
// Until those are set, this just logs the code to the server console (and the
// signup API response includes it as `devCode` so the UI can show it) so you
// can test the whole flow before wiring up a real mail provider.

const nodemailer = require("nodemailer");

const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
if (configured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendVerificationEmail(toEmail, code) {
  if (!configured) {
    console.log(`\n[mailer] EMAIL SENDING NOT CONFIGURED (see .env.example).`);
    console.log(`[mailer] Verification code for ${toEmail}: ${code}\n`);
    return { sent: false };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: "Your WildcatEats verification code",
    text: `Your WildcatEats verification code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your WildcatEats verification code is <b style="font-size:1.2em;">${code}</b>.</p><p>It expires in 10 minutes.</p>`
  });
  return { sent: true };
}

module.exports = { sendVerificationEmail, configured };
