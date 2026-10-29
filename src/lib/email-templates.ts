import { env } from '../config/env.js';
import type { EmailMessage } from '../integrations/email.js';

type Template = Pick<EmailMessage, 'subject' | 'html' | 'text'>;

const storeName = 'WebMart';

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rupees = (amount: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount);

const dateText = (date: Date) => date.toLocaleDateString('en-IN', { dateStyle: 'medium' });

export const storeUrl = (path: string) => `${env.CLIENT_URL}${path}`;

type Content = {
  subject: string;
  heading: string;
  /** Plain paragraphs; escaped here. */
  paragraphs: string[];
  /** Optional lines such as order items, shown as a list. */
  lines?: string[];
  button?: { label: string; url: string };
};

/** One simple, table-free layout that renders everywhere; text version built from the same data. */
function render(content: Content): Template {
  const paragraphsHtml = content.paragraphs
    .map((paragraph) => `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(paragraph)}</p>`)
    .join('');
  const linesHtml = content.lines
    ? `<ul style="margin:0 0 18px;padding-left:18px;line-height:1.7">${content.lines
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('')}</ul>`
    : '';
  const buttonHtml = content.button
    ? `<p style="margin:22px 0"><a href="${escapeHtml(content.button.url)}" style="background:#2DD4BF;color:#000;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;display:inline-block">${escapeHtml(content.button.label)}</a></p>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px">
<p style="margin:0 0 20px;font-weight:800;font-size:18px">${storeName}<span style="color:#2DD4BF">.</span></p>
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(content.heading)}</h1>
${paragraphsHtml}${linesHtml}${buttonHtml}
</div>
<p style="margin:16px 0 0;font-size:12px;color:#71717a;text-align:center">You are receiving this because of activity on your ${storeName} account.</p>
</div></body></html>`;

  const text = [
    content.heading,
    '',
    ...content.paragraphs,
    ...(content.lines ? ['', ...content.lines.map((line) => `- ${line}`)] : []),
    ...(content.button ? ['', `${content.button.label}: ${content.button.url}`] : []),
  ].join('\n');

  return { subject: content.subject, html, text };
}

export function passwordResetEmail(name: string, resetUrl: string, validMinutes: number) {
  return render({
    subject: 'Reset your password',
    heading: 'Reset your password',
    paragraphs: [
      `Hi ${name}, we received a request to reset your ${storeName} password.`,
      `This link works for ${validMinutes} minutes and can be used once. If you didn't ask for this, you can ignore this email; your password stays the same.`,
    ],
    button: { label: 'Choose a new password', url: resetUrl },
  });
}

export type OrderEmailData = {
  orderId: string;
  customerName: string;
  items: { name: string; qty: number; price: number }[];
  totalPrice: number;
  paymentMethod: string;
  isPaid: boolean;
  deliveryOption?: string;
  estimatedDeliveryDate?: Date;
};

const shortId = (orderId: string) => orderId.slice(-8);
const orderButton = (orderId: string) => ({
  label: 'View your order',
  url: storeUrl(`/orders/${orderId}`),
});
const itemLines = (order: OrderEmailData) =>
  order.items.map((item) => `${item.qty} × ${item.name} — ${rupees(item.price * item.qty)}`);

export function orderConfirmedEmail(order: OrderEmailData) {
  const isCod = order.paymentMethod === 'Cash on Delivery';
  const eta = order.estimatedDeliveryDate
    ? ` ${order.deliveryOption === 'express' ? 'Express delivery' : 'Delivery'} is expected by ${dateText(order.estimatedDeliveryDate)}.`
    : '';
  return render({
    subject: `Order #${shortId(order.orderId)} confirmed`,
    heading: 'Thanks, your order is confirmed',
    paragraphs: [
      `Hi ${order.customerName}, we've received your order #${shortId(order.orderId)}.${eta}`,
      isCod
        ? `Total to pay on delivery: ${rupees(order.totalPrice)}.`
        : `We received your payment of ${rupees(order.totalPrice)}.`,
    ],
    lines: itemLines(order),
    button: orderButton(order.orderId),
  });
}

export function orderShippedEmail(order: OrderEmailData) {
  return render({
    subject: `Order #${shortId(order.orderId)} has shipped`,
    heading: 'Your order is on its way',
    paragraphs: [
      `Hi ${order.customerName}, order #${shortId(order.orderId)} has been shipped.${
        order.estimatedDeliveryDate ? ` Expected by ${dateText(order.estimatedDeliveryDate)}.` : ''
      }`,
      ...(order.paymentMethod === 'Cash on Delivery' && !order.isPaid
        ? [`Please keep ${rupees(order.totalPrice)} ready to pay on delivery.`]
        : []),
    ],
    lines: itemLines(order),
    button: orderButton(order.orderId),
  });
}

export function orderDeliveredEmail(order: OrderEmailData) {
  return render({
    subject: `Order #${shortId(order.orderId)} delivered`,
    heading: 'Your order was delivered',
    paragraphs: [
      `Hi ${order.customerName}, order #${shortId(order.orderId)} has been delivered. We hope you love it.`,
      'You can now rate and review the products you bought, which helps other shoppers.',
    ],
    lines: itemLines(order),
    button: orderButton(order.orderId),
  });
}

export function orderCancelledEmail(order: OrderEmailData, isRefundDue: boolean) {
  return render({
    subject: `Order #${shortId(order.orderId)} cancelled`,
    heading: 'Your order was cancelled',
    paragraphs: [
      `Hi ${order.customerName}, order #${shortId(order.orderId)} has been cancelled.`,
      isRefundDue
        ? `We've started a refund of ${rupees(order.totalPrice)} to your original payment method. Banks usually take 5 to 7 business days to show it.`
        : 'You were not charged for this order.',
    ],
    button: orderButton(order.orderId),
  });
}

export function orderRefundedEmail(order: OrderEmailData) {
  return render({
    subject: `Refund for order #${shortId(order.orderId)}`,
    heading: 'Your refund is on its way',
    paragraphs: [
      `Hi ${order.customerName}, we've refunded ${rupees(order.totalPrice)} for order #${shortId(order.orderId)}. Banks usually take 5 to 7 business days to show it.`,
    ],
    button: orderButton(order.orderId),
  });
}

export function membershipWelcomeEmail(
  name: string,
  label: string,
  endsAt: Date,
  bonusPoints: number,
) {
  return render({
    subject: 'Welcome to Plus',
    heading: `You're a Plus member`,
    paragraphs: [
      `Hi ${name}, your ${label} membership is active until ${dateText(endsAt)}.`,
      `You now get free shipping, free express delivery and double reward points, and we've added ${bonusPoints} welcome points to your account.`,
    ],
    button: { label: 'Start shopping', url: storeUrl('/products') },
  });
}

export function membershipRefundedEmail(name: string, amount: number) {
  return render({
    subject: 'Your Plus membership was refunded',
    heading: 'Your Plus membership was cancelled',
    paragraphs: [
      `Hi ${name}, your Plus membership has been cancelled and ${rupees(amount)} is being refunded to your original payment method. Banks usually take 5 to 7 business days to show it.`,
      'Your Plus benefits and welcome points have ended.',
    ],
  });
}
