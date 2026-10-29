# IndiaKart — Server

Express 5 + TypeScript (strict, ESM) + MongoDB (Mongoose). Follows
[`expresscodingstandard.md`](./expresscodingstandard.md).

## Requirements

- Node.js 20+
- MongoDB **replica set** (MongoDB Atlas works out of the box). Orders, stock, points and refunds
  use multi-document transactions, which a standalone `mongod` does not support.
- Razorpay account (test keys are fine for development)

## Setup

```bash
cp .env.example .env   # fill in MONGO_URI, JWT_SECRET, Razorpay keys
npm install
npm run seed:products  # optional: 50 products with categories
npm run dev            # http://localhost:5000
```

`seed:products` creates an admin account if none exists and prints its password **once** — save
it and change it after first login. `npm run seed:reviews` adds sample reviews in development
(`-- --remove` deletes them again).

| Script                   | Purpose                               |
| ------------------------ | ------------------------------------- |
| `npm run dev`            | Watch mode with `tsx`                 |
| `npm run build`          | Compile to `dist/`                    |
| `npm start`              | Run the compiled server               |
| `npm run typecheck`      | `tsc --noEmit`                        |
| `npm run lint`           | ESLint                                |
| `npm run format`         | Prettier write                        |
| `npm run seed:products`  | Insert the sample catalogue           |
| `npm run seed:reviews`   | Insert / remove sample reviews (dev)  |

## Environment

Every variable is documented in [`.env.example`](./.env.example) and validated at startup — the
server refuses to start with a missing or invalid value. The essentials:

| Variable                          | Notes                                                         |
| --------------------------------- | ------------------------------------------------------------- |
| `MONGO_URI`                       | Replica-set connection string (no `//` before the db name)    |
| `JWT_SECRET`                      | 32+ random characters                                         |
| `CORS_ORIGINS`                    | Comma-separated client URLs                                   |
| `RAZORPAY_KEY_ID` / `_KEY_SECRET` | Dashboard → API Keys                                          |
| `RAZORPAY_WEBHOOK_SECRET`         | Dashboard → Webhooks                                          |
| `CRON_SECRET`                     | Enables `GET /api/cron/expire-orders` (needed on serverless)  |
| `RESEND_API_KEY` / `EMAIL_FROM`   | Optional; without a key, emails are printed in the log        |

## Structure

```
src/
├── app.ts            # Express app: security middleware, routes, error handler
├── server.ts         # Long-running process: listen, expiry timer, graceful shutdown
├── config/           # env validation
├── integrations/     # Razorpay REST client
├── lib/              # db (transactions), errors, logger
├── middleware/       # auth, validation, rate limits, error handler
├── modules/          # users, products, reviews, orders, rewards, wishlist, memberships, notifications
│   └── <module>/ *.model.ts *.service.ts *.controller.ts *.routes.ts *.validation.ts
├── routes/index.ts   # mounts every module under /api
└── scripts/          # seed scripts
api/index.js          # Vercel serverless entry (uses dist/)
```

## API

All routes are under `/api`. 🔒 = logged in, 👑 = admin.

| Area        | Endpoints                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------- |
| Users       | `POST /users/register`, `/login`, `/forgot-password`, `/reset-password` · 🔒 `GET/PUT /users/profile` · 🔒 `/users/addresses` CRUD · 👑 `GET /users`, `DELETE /users/:id` |
| Products    | `GET /products`, `/products/suggest`, `/products/:id` · 👑 `POST /products/admin`              |
| Reviews     | `GET /products/:id/reviews` · 🔒 `GET/PUT /products/:id/reviews/mine`, `DELETE …/:reviewId`   |
| Orders      | 🔒 `POST /orders`, `POST /orders/quote`, `GET /orders/myorders`, `GET /orders/:id`, `POST /orders/:id/cancel` |
| Payments    | 🔒 `POST /orders/:id/razorpay`, `POST /orders/:id/razorpay/verify`, `POST /orders/:id/cash-on-delivery` |
| Order admin | 👑 `PUT /orders/:id/pay`, `/ship`, `/deliver` · `POST /orders/:id/refund`, `/refunds/:paymentId/retry` |
| Rewards     | 🔒 `GET /rewards/me`                                                                           |
| Wishlist    | 🔒 `GET /wishlist`, `PUT/DELETE /wishlist/:productId`                                          |
| Memberships | `GET /memberships/plans` · 🔒 `/me`, `/checkout`, `/:id/verify`, `/:id/cancel` · 👑 list, refund, retry |
| Webhooks    | `POST /api/webhooks/razorpay` (signature-checked, raw body)                                   |
| Health      | `GET /health/live`, `GET /health/ready`                                                       |

`POST /orders` accepts an `Idempotency-Key` header so a retried checkout never creates a second
order.

## Payments, discounts and points

- **Pricing** is computed only on the server (`modules/orders/order-pricing.ts`); the client shows
  the `/orders/quote` result and the order is rejected with `PRICE_CHANGED` if it no longer matches.
- **First-order discount:** 10% of items, max ₹200, once per customer.
- **Points:** earn 1 per ₹100 once an order is paid *and* delivered; spend 1 point = ₹1, up to 20%
  of the items. Rules live in `modules/rewards/rewards.config.ts` (policy text restates them in the
  client's `features/policies/content.ts` — change both).
- **Stock** is reserved in the same transaction as the order; unpaid online orders are cancelled
  after `ORDER_PAYMENT_WINDOW_MINUTES` and their stock, points and discount released.
- **Refunds** go back through Razorpay automatically on cancel/refund, late or duplicate payment.
  Failed refunds show a Retry button to admins. Cash-on-delivery refunds are flagged for manual
  settlement.

## Razorpay webhook

Dashboard → Webhooks → URL `https://<your-api>/api/webhooks/razorpay`, secret =
`RAZORPAY_WEBHOOK_SECRET`, events: `payment.captured`, `order.paid`, `refund.processed`,
`refund.failed`.

## Deployment

**Long-running host (Render, Railway, VPS):** `npm run build && npm start`. Set `TRUST_PROXY=1`
behind one proxy. The expiry timer runs in-process.

**Vercel:** `vercel.json` is set up (`framework: null`, everything rewritten to `api/index.js`).
Add every env variable in Project Settings and set `TRUST_PROXY=1`. Serverless functions can't
run the expiry timer, so set `CRON_SECRET` and call `GET /api/cron/expire-orders` every few
minutes from a scheduler with `Authorization: Bearer <CRON_SECRET>`.
