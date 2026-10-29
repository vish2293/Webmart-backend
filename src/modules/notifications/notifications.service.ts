import { sendEmail } from '../../integrations/email.js';
import {
  membershipRefundedEmail,
  membershipWelcomeEmail,
  orderCancelledEmail,
  orderConfirmedEmail,
  orderDeliveredEmail,
  orderRefundedEmail,
  orderShippedEmail,
  type OrderEmailData,
} from '../../lib/email-templates.js';
import { logger } from '../../lib/logger.js';
import { Membership } from '../memberships/membership.model.js';
import { Order } from '../orders/order.model.js';
import { User } from '../users/user.model.js';

export type OrderNotification = 'confirmed' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

// These run after the database change has committed and are awaited (a serverless host may
// freeze the process once the response is sent), but they never throw: an email problem must
// not undo or fail the order action that triggered it.

/** Sends the customer an email about an order. */
export async function notifyOrder(orderId: string, kind: OrderNotification) {
  try {
    const order = await Order.findById(orderId).lean();
    if (!order) return;
    const user = await User.findById(order.user).select('name email').lean();
    if (!user) return;

    const data: OrderEmailData = {
      orderId,
      customerName: user.name,
      items: order.orderItems.map((item) => ({
        name: item.name,
        qty: item.qty,
        price: item.price,
      })),
      totalPrice: order.totalPrice,
      paymentMethod: order.paymentMethod,
      isPaid: order.isPaid,
      deliveryOption: order.deliveryOption,
      estimatedDeliveryDate: order.estimatedDeliveryDate,
    };
    const isRefundDue = order.isPaid && order.paymentMethod !== 'Cash on Delivery';
    const message = {
      confirmed: () => orderConfirmedEmail(data),
      shipped: () => orderShippedEmail(data),
      delivered: () => orderDeliveredEmail(data),
      cancelled: () => orderCancelledEmail(data, isRefundDue),
      refunded: () => orderRefundedEmail(data),
    }[kind]();
    await sendEmail({ to: user.email, ...message });
  } catch (error) {
    logger.error({ err: error, orderId, kind }, 'Could not prepare an order email');
  }
}

/** Sends the customer an email about a Plus membership. */
export async function notifyMembership(membershipId: string, kind: 'welcome' | 'refunded') {
  try {
    const membership = await Membership.findById(membershipId).lean();
    if (!membership) return;
    const user = await User.findById(membership.user).select('name email').lean();
    if (!user) return;

    if (kind === 'welcome' && membership.endsAt) {
      const label = membership.plan === 'yearly' ? 'Plus Yearly' : 'Plus Monthly';
      await sendEmail({
        to: user.email,
        ...membershipWelcomeEmail(
          user.name,
          label,
          membership.endsAt,
          membership.welcomeBonusPoints,
        ),
      });
    } else if (kind === 'refunded') {
      await sendEmail({
        to: user.email,
        ...membershipRefundedEmail(user.name, membership.refund?.amount ?? membership.pricePaid),
      });
    }
  } catch (error) {
    logger.error({ err: error, membershipId, kind }, 'Could not prepare a membership email');
  }
}
