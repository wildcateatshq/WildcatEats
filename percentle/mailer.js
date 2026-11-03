"use strict";

// Chargle's email: only password-reset links. It sends through one of these, set in the environment:
//   - Resend (resend.com), over the web: RESEND_API_KEY, and CHARGLE_MAIL_FROM such as
//     "Chargle <noreply@chargle.io>" (an address on a domain verified in Resend). This works on
//     hosts that block mail ports, like Render's free plan.
//   - Any SMTP mail account (for example a Gmail address with an app password): SMTP_HOST,
//     SMTP_PORT (465 or 587), SMTP_USER, SMTP_PASS, and optionally CHARGLE_MAIL_FROM.
// Until one is set it can't send, and the reset link is only written to the server log.

const nodemailer = require("nodemailer");

function createMailer(env = process.env, fetchImpl = globalThis.fetch) {
  const resend = Boolean(env.RESEND_API_KEY);
  const smtp = !resend && Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  const configured = resend || smtp;
  const transport = smtp
    ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 587,
      secure: Number(env.SMTP_PORT) === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
    })
    : null;

  async function send(message) {
    if (smtp) return transport.sendMail({ ...message, from: env.CHARGLE_MAIL_FROM || `Chargle <${env.SMTP_USER}>` });
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...message, from: env.CHARGLE_MAIL_FROM || "Chargle <noreply@chargle.io>" })
    });
    if (!response.ok) throw new Error(`Resend refused the email (${response.status}): ${await response.text()}`);
  }

  async function sendPasswordReset(to, username, link, minutes) {
    if (!configured) {
      console.log(`[chargle mail] Email isn't set up, so no reset email was sent. Reset link for ${to}: ${link}`);
      return false;
    }
    await send({
      to,
      subject: "Reset your Chargle password",
      text: `Hi ${username},\n\nSomeone (hopefully you) asked to reset the password for your Chargle account. Choose a new one here:\n\n${link}\n\nThe link works once, for the next ${minutes} minutes. If you didn't ask for this, you can ignore this email; your password hasn't changed.\n\nChargle`,
      html: `<p>Hi ${escapeHtml(username)},</p><p>Someone (hopefully you) asked to reset the password for your Chargle account.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#ffe9a6;color:#1a1306;border-radius:6px;font-weight:bold;text-decoration:none">Choose a new password</a></p>
<p>The link works once, for the next ${minutes} minutes. If you didn't ask for this, you can ignore this email; your password hasn't changed.</p><p>Chargle</p>`
    });
    return true;
  }

  return { configured, sendPasswordReset };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

module.exports = { createMailer };
