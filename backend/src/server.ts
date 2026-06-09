import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { db } from './db/client.js';
import { logger } from './utils/logger.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import jobRoutes from './routes/jobs.routes.js';
import usageRoutes from './routes/usage.routes.js';
import billingRoutes from './routes/billing.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { authenticate } from './middleware/auth.middleware.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──
const allowedOrigins = [
  process.env.DASHBOARD_URL ?? 'http://localhost:3000',
  'https://lycheeai.dev',
  'http://localhost:3000',
  'http://localhost:5173',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// ── DB INIT ──
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      username TEXT,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      roblox_id TEXT,
      roblox_username TEXT,
      plan_name TEXT DEFAULT 'free',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      is_admin BOOLEAN DEFAULT false,
      is_banned BOOLEAN DEFAULT false,
      ban_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS code_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      script_type TEXT NOT NULL DEFAULT 'Script',
      insert_location TEXT NOT NULL DEFAULT 'ServerScriptService',
      script_name TEXT NOT NULL DEFAULT 'LycheeAI_Script',
      generated_code TEXT,
      explanation TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      inserted_at TIMESTAMPTZ
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      properties JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Plugin sessions table for connection status ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS plugin_sessions (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_seen TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  logger.info('Database initialized');
}

// ── ROUTES ──
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Lychee AI Backend' }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/user', authenticate, userRoutes);
app.use('/api/v1/jobs', authenticate, jobRoutes);
app.use('/api/v1/usage', authenticate, usageRoutes);
app.use('/api/v1/billing', authenticate, billingRoutes);
app.use('/api/v1/admin', authenticate, adminRoutes);

// ── PLUGIN HEARTBEAT — plugin calls this every 3s while connected ──
app.post('/api/v1/plugin/heartbeat', authenticate, async (req: any, res) => {
  try {
    await db.query(
      `INSERT INTO plugin_sessions (user_id, last_seen)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW()`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ── PLUGIN STATUS — website polls this to check if plugin is connected ──
app.get('/api/v1/plugin/status', authenticate, async (req: any, res) => {
  try {
    const result = await db.query(
      `SELECT last_seen FROM plugin_sessions WHERE user_id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) {
      return res.json({ connected: false });
    }
    const lastSeen = new Date(result.rows[0].last_seen);
    const secondsAgo = (Date.now() - lastSeen.getTime()) / 1000;
    res.json({ connected: secondsAgo < 10 });
  } catch (err) {
    res.json({ connected: false });
  }
});

// ── START ──
initDb().then(() => {
  app.listen(PORT, () => {
    logger.info(`✅ Lychee AI Backend running on port ${PORT}`);
  });
}).catch(err => {
  logger.error('Failed to initialize DB', err);
  process.exit(1);
});

export default app;
