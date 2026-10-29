import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const sendTimeoutMs = 8_000;

export type EmailMessage = { to: string; subject: string; html: string; text: string };

/**
 * Sends one email through Resend. Never throws: a failed email must not fail the order, payment
 * or password request that triggered it, so errors are logged and swallowed. Without
 * RESEND_API_KEY (local development) the message is logged instead, which is how you read a
 * password-reset link without a mail account.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!env.RESEND_API_KEY) {
    logger.info(
      { to: message.to, subject: message.subject, text: message.text },
      'Email not sent (RESEND_API_KEY is not set)',
    );
    return;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(sendTimeoutMs),
    });
    if (!response.ok) {
      logger.error(
        { status: response.status, body: await response.text().catch(() => '') },
        'Email provider rejected a message',
      );
    }
  } catch (error) {
    logger.error({ err: error, subject: message.subject }, 'Could not send email');
  }
}
