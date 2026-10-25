// server/email.js
// -----------------------------------------------------------------------------
// Transactional email. Every message is written to the `emails` table (the admin
// "Email log" shows it). If RESEND_API_KEY is set it is also sent through Resend;
// otherwise it stays logged, which is how the demo runs.
// -----------------------------------------------------------------------------
import { q } from './db.js';

const FROM = () => process.env.EMAIL_FROM || 'ORBITAL SURPLUS <onboarding@resend.dev>';
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (c) => `$${((c || 0) / 100).toFixed(2)}`;

export async function sendEmail(to, subject, html, kind = 'transactional') {
  let status = 'logged';
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: FROM(), to: [to], subject, html }),
      });
      status = r.ok ? 'sent' : `failed (${r.status})`;
    } catch { status = 'failed'; }
  }
  await q('insert into emails (to_email, subject, html, kind, status) values ($1,$2,$3,$4,$5)', [to, subject, html, kind, status]);
  return status;
}

const LIME = '#C8FF2E';
const frame = (title, body, origin = '') => `<!doctype html><html><body style="margin:0;background:#000;font-family:'DM Mono',Menlo,Consolas,monospace;color:#e8e8e8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0b0b0b;border:1px solid #222">
<tr><td style="padding:20px 28px;border-bottom:1px solid #222;font-size:14px;letter-spacing:.12em">[ORBITAL SURPLUS] <span style="color:${LIME}">■</span></td></tr>
<tr><td style="padding:28px"><h1 style="font-size:20px;font-weight:400;letter-spacing:.06em;text-transform:uppercase;margin:0 0 18px">${title}</h1>${body}</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #222;font-size:11px;color:#8a8a8a;line-height:1.6">ORBITAL SURPLUS IS A PORTFOLIO PROJECT. PAYMENTS RUN IN STRIPE TEST MODE AND NOTHING SHIPS.${origin ? ` <a href="${origin}" style="color:${LIME}">VISIT THE DEPOT</a>` : ''}</td></tr>
</table></td></tr></table></body></html>`;

const btn = (href, label) => `<p style="margin:22px 0 0"><a href="${href}" style="display:inline-block;border:1px solid ${LIME};color:${LIME};padding:10px 16px;text-decoration:none;letter-spacing:.08em">[ ${label} ]</a></p>`;

const lines = (o) => `<table role="presentation" width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:12px 0">
${o.items.map((l) => `<tr style="border-bottom:1px solid #1f1f1f"><td>${l.quantity} × ${esc(l.name)}<br><span style="color:#8a8a8a">SIZE ${esc(l.size)}</span></td><td align="right">${money(l.line_total)}</td></tr>`).join('')}
<tr><td>Subtotal</td><td align="right">${money(o.subtotal)}</td></tr>
${o.discount ? `<tr><td>Discount (${esc(o.discount_code)})</td><td align="right">−${money(o.discount)}</td></tr>` : ''}
<tr><td>${esc(o.shipping?.label || 'Shipping')}</td><td align="right">${o.shipping?.amount ? money(o.shipping.amount) : 'FREE'}</td></tr>
${o.tax ? `<tr><td>Tax</td><td align="right">${money(o.tax)}</td></tr>` : ''}
<tr><td style="color:${LIME}">TOTAL</td><td align="right" style="color:${LIME}">${money(o.total)}</td></tr></table>`;

export function orderConfirmation(o, origin) {
  const a = o.address || {};
  return sendEmail(o.email, `Order #${o.number} confirmed — ORBITAL SURPLUS`, frame(`Cargo locked, ${esc((o.name || 'crew').split(' ')[0])}`,
    `<p style="line-height:1.6">Order <strong>#${o.number}</strong> is paid and queued for the next launch window.</p>${lines(o)}
    <p style="font-size:12px;color:#8a8a8a;line-height:1.6">DELIVER TO<br>${esc(o.name)}<br>${esc(a.line1)}<br>${esc(a.city)} ${esc(a.state || '')} ${esc(a.postal_code)}<br>${esc(a.country)}</p>
    ${btn(`${origin}/order/${o.token}`, 'TRACK YOUR ORDER')}`, origin), 'order_confirmation');
}

export function shippingConfirmation(o, origin) {
  return sendEmail(o.email, `Order #${o.number} has launched`, frame('Your cargo has launched',
    `<p style="line-height:1.6">Order <strong>#${o.number}</strong> left the depot.</p><p>CARRIER: ${esc(o.tracking?.carrier || '—')}<br>TRACKING: ${esc(o.tracking?.number || '—')}</p>${lines(o)}${btn(`${origin}/order/${o.token}`, 'VIEW ORDER')}`, origin), 'shipping_confirmation');
}

export function refundNotice(o, amount, origin) {
  return sendEmail(o.email, `Refund for order #${o.number}`, frame('Refund issued',
    `<p style="line-height:1.6">We refunded <strong>${money(amount)}</strong> for order <strong>#${o.number}</strong>. It can take 5–10 business days to reach your statement.</p>`, origin), 'refund');
}

export function welcomeEmail(email, origin) {
  return sendEmail(email, 'You are on the manifest — 10% off inside', frame('Welcome aboard',
    `<p style="line-height:1.6">You'll hear about new drops and restocks before they hit the depot floor. Here's 10% off your first order:</p>
    <p style="font-size:22px;letter-spacing:.14em;border:1px dashed ${LIME};color:${LIME};display:inline-block;padding:10px 18px">LAUNCH10</p>${btn(`${origin}/shop`, 'BROWSE THE DEPOT')}`, origin), 'marketing');
}

export function accountWelcome(c, origin) {
  return sendEmail(c.email, 'Your ORBITAL SURPLUS account', frame(`Hello ${esc(c.name || 'crew')}`,
    `<p style="line-height:1.6">Your account is ready. Track orders, save your address and check out faster.</p>${btn(`${origin}/account`, 'OPEN YOUR ACCOUNT')}`, origin), 'account');
}

export function passwordResetEmail(email, link, origin) {
  return sendEmail(email, 'Reset your password', frame('Reset your password',
    `<p style="line-height:1.6">Someone asked to reset the password for this account. If that was you, use the link below within an hour.</p>${btn(link, 'CHOOSE A NEW PASSWORD')}
    <p style="font-size:12px;color:#8a8a8a">If you didn't ask for this, ignore this email.</p>`, origin), 'account');
}

export function contactAck(name, email, origin) {
  return sendEmail(email, 'We got your message', frame('Transmission received',
    `<p style="line-height:1.6">Thanks ${esc(name)}. A depot hand will reply within two working days.</p>`, origin), 'support');
}
