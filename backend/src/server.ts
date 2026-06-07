// ============================================================
// Lime AI Platform — Express Server (main entry point)
// ============================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { globalRateLimit, requestTiming } from './middleware/rateLimiter.js';
import routes from './routes/index.js';
import { logger } from './utils/logger.js';
import { db } from './db/client.js';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// ─────────────────────────────────────────────
// SECURITY HEADERS
// ─────────────────────────────────────────────
app.set('trust proxy', 1); // Trust first proxy (nginx/cloudflare)

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'https://api.anthropic.com'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// ─────────────────────────────────────────────
// CORS — allow Studio plugin + dashboard + API clients
// ─────────────────────────────────────────────
const allowedOrigins = [
  process.env.DASHBOARD_URL ?? 'http://localhost:3000',
  'https://limeai.dev',
  // Roblox Studio uses HttpService which doesn't send Origin header,
  // so it passes CORS automatically (no origin = server-to-server call)
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Roblox Studio, Postman, mobile apps)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(compression());
app.use(requestTiming);
app.use(globalRateLimit);

// Stripe webhook needs raw body
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

// Everything else gets JSON parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// HTTP request logging
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
  skip: (req) => req.path === '/health',
}));

// ─────────────────────────────────────────────
// STRIPE WEBHOOKS (must come before auth)
// ─────────────────────────────────────────────
app.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) { res.status(400).send('No signature'); return; }

  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });
    const event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as { metadata?: { userId?: string; planName?: string }; customer?: string; subscription?: string };
      const { userId, planName } = session.metadata ?? {};
      if (userId && planName) {
        // Update user plan
        const { rows: plan } = await db.query(
          `SELECT id FROM subscription_plans WHERE name = $1`, [planName]
        );
        if (plan[0]) {
          await db.query(
            `UPDATE users SET plan_id = $1 WHERE id = $2`,
            [plan[0].id, userId]
          );
          await db.query(
            `UPDATE subscriptions SET plan_id = $1, stripe_customer_id = $2,
               stripe_subscription_id = $3, status = 'active', updated_at = NOW()
             WHERE user_id = $4`,
            [plan[0].id, session.customer, session.subscription, userId]
          );
          logger.info('Subscription upgraded', { userId, planName });
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as { id: string };
      await db.query(
        `UPDATE subscriptions SET status = 'canceled', updated_at = NOW()
         WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
      // Downgrade to free
      const { rows: free } = await db.query(
        `SELECT id FROM subscription_plans WHERE name = 'free'`
      );
      if (free[0]) {
        await db.query(
          `UPDATE users SET plan_id = $1
           WHERE id = (SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $2)`,
          [free[0].id, sub.id]
        );
      }
    }

    res.json({ received: true });
  } catch (err: unknown) {
    logger.error('Stripe webhook error', err);
    res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }
});

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────
app.use('/api/v1', routes);

// ─────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, async () => {
  try {
    await db.query('SELECT 1');
    // Auto-create tables if they don't exist
    await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await db.query(`CREATE TABLE IF NOT EXISTS subscription_plans (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(50) UNIQUE NOT NULL, display_name VARCHAR(100) NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, requests_per_day INTEGER NOT NULL DEFAULT 20, requests_per_month INTEGER NOT NULL DEFAULT 100, max_tokens_per_request INTEGER NOT NULL DEFAULT 2048, max_conversations INTEGER NOT NULL DEFAULT 10, features JSONB NOT NULL DEFAULT '[]', active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`INSERT INTO subscription_plans (name, display_name, price_cents, requests_per_day, requests_per_month, max_tokens_per_request, max_conversations, features) VALUES ('free','Free',0,20,100,2048,10,'[]'),('pro','Pro',1900,200,5000,8192,100,'[]'),('team','Team',4900,1000,25000,16384,500,'[]'),('enterprise','Enterprise',19900,-1,-1,32768,-1,'[]') ON CONFLICT (name) DO NOTHING`);
    await db.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS email_verify_token VARCHAR(255), ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255), ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ`);
    await db.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, username VARCHAR(50), display_name VARCHAR(100), roblox_username VARCHAR(50), email_verified BOOLEAN NOT NULL DEFAULT false, email_verify_token VARCHAR(255), email_verify_expires TIMESTAMPTZ, password_reset_token VARCHAR(255), password_reset_expires TIMESTAMPTZ, plan_id UUID REFERENCES subscription_plans(id), is_admin BOOLEAN NOT NULL DEFAULT false, is_banned BOOLEAN NOT NULL DEFAULT false, ban_reason TEXT, last_login_at TIMESTAMPTZ, last_login_ip INET, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS sessions (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, refresh_token VARCHAR(500) UNIQUE NOT NULL, ip_address INET, user_agent TEXT, expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, title VARCHAR(255) NOT NULL DEFAULT 'New Conversation', model VARCHAR(100) NOT NULL DEFAULT 'gemini-1.5-flash', archived BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, role VARCHAR(20) NOT NULL, content TEXT NOT NULL, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, model VARCHAR(100), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS subscriptions (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan_id UUID NOT NULL REFERENCES subscription_plans(id), status VARCHAR(50) NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS usage_logs (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, conversation_id UUID, message_id UUID, plan_name VARCHAR(50) NOT NULL, model VARCHAR(100) NOT NULL, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0, cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0, latency_ms INTEGER, success BOOLEAN NOT NULL DEFAULT true, error_code VARCHAR(100), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS analytics_events (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID REFERENCES users(id) ON DELETE SET NULL, event_type VARCHAR(100) NOT NULL, properties JSONB DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS audit_logs (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID REFERENCES users(id) ON DELETE SET NULL, action VARCHAR(100) NOT NULL, resource VARCHAR(100), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS code_jobs (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, prompt TEXT NOT NULL, script_type VARCHAR(20) NOT NULL DEFAULT 'Script', insert_location TEXT NOT NULL DEFAULT 'ServerScriptService', status VARCHAR(20) NOT NULL DEFAULT 'pending', generated_code TEXT, explanation TEXT, script_name TEXT NOT NULL DEFAULT 'LimeAI_Script', error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ, inserted_at TIMESTAMPTZ)`);
    logger.info(`✅ Lime AI Backend running on port ${PORT}`);
  } catch (err) {
    logger.error('❌ Startup error', err);
    process.exit(1);
  }
});
