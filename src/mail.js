'use strict';

/*
 * Outgoing email. Configure ONE of:
 *   RESEND_API_KEY=re_...            (https://resend.com, simplest on Vercel)
 *   SMTP_URL=smtps://user:pass@smtp.example.com:465   (any SMTP server, e.g. Gmail app password, Mailgun, SES)
 * plus MAIL_FROM="GoldRush <no-reply@yourdomain.com>".
 *
 * Without either, nothing is sent; admins can still create password reset links in the admin panel.
 */

const MAIL_FROM = process.env.MAIL_FROM || '';

function mailConfigured() {
  return !!(MAIL_FROM && (process.env.RESEND_API_KEY || process.env.SMTP_URL));
}

let smtp = null;
function smtpTransport() {
  if (!smtp) smtp = require('nodemailer').createTransport(process.env.SMTP_URL);
  return smtp;
}

async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) return { sent: false, reason: 'not-configured' };
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { sent: true };
  }
  await smtpTransport().sendMail({ from: MAIL_FROM, to, subject, text, html });
  return { sent: true };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A plain, good-looking email in the site's black and gold. */
function layout({ siteName, heading, body, button, url, footer }) {
  const text = `${heading}\n\n${body}\n\n${button}: ${url}\n\n${footer}\n\n${siteName}`;
  const html = `<!doctype html><html><body style="margin:0;background:#0b0d14;padding:32px 12px;font-family:Inter,Arial,sans-serif;color:#e8edf5">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#14171c;border:2px solid #1e2028;border-radius:20px">
    <tr><td style="padding:28px 28px 8px;font-size:22px;font-weight:800;color:#ffffff">
      <span style="display:inline-block;width:28px;height:28px;border-radius:50%;background:#eac837;color:#6b5200;text-align:center;line-height:28px;font-size:16px;vertical-align:middle;margin-right:8px">$</span>${escapeHtml(siteName)}</td></tr>
    <tr><td style="padding:12px 28px 0;font-size:20px;font-weight:700;color:#ffffff">${escapeHtml(heading)}</td></tr>
    <tr><td style="padding:10px 28px 0;font-size:15px;line-height:1.6;color:#94a3b8">${escapeHtml(body)}</td></tr>
    <tr><td style="padding:24px 28px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#eac837;color:#0b0d14;text-decoration:none;font-weight:800;padding:13px 26px;border-radius:40px">${escapeHtml(button)}</a></td></tr>
    <tr><td style="padding:0 28px 26px;font-size:13px;line-height:1.6;color:#6b7280">${escapeHtml(footer)}<br><br>If the button doesn't work, paste this into your browser:<br><span style="color:#eac837;word-break:break-all">${escapeHtml(url)}</span></td></tr>
  </table></td></tr></table></body></html>`;
  return { text, html };
}

module.exports = { mailConfigured, sendMail, layout };
