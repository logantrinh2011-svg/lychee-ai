// ============================================================
// Lime AI Platform — Express Router (all routes)
// ============================================================

import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin, registerUser, loginUser,
         refreshTokens, revokeRefreshToken, verifyEmail } from '../middleware/auth.js';
import { authRateLimit, planUsageLimit, checkBanned } from '../middleware/rateLimiter.js';
import { chatWithClaude, streamChatWithClaude,
         ensureConversation, checkUsageLimits } from '../services/claude.service.js';
import { createCodeJob, getPendingJobsForUser,
         markJobInserted, getJobStatus,
         getUserJobHistory } from '../services/jobs.service.js';
import { db } from '../db/client.js';
import { logger } from '../utils/logger.js';
import Stripe from 'stripe';
import { z } from 'zod';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });

// Input validation helpers
const validate = (schema: z.ZodSchema, body: unknown, res: Response): boolean => {
  const result = schema.safeParse(body);
  if (!result.success) {
    res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    return false;
  }
  return true;
};

// ═══════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════
const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  username: z.string().min(3).max(50).optional(),
});

router.post('/auth/register', authRateLimit, async (req, res) => {
  if (!validate(registerSchema, req.body, res)) return;
  try {
    const { userId, verifyToken } = await registerUser(
      req.body.email, req.body.password, req.body.username
    );
    // TODO: Send verification email with verifyToken
    logger.info('User registered', { userId });
    res.status(201).json({ message: 'Account created. Check your email to verify.' });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'EMAIL_EXISTS') res.status(409).json({ error: 'Email already registered' });
    else { logger.error('Registration error', err); res.status(500).json({ error: 'Registration failed' }); }
  }
});

router.post('/auth/login', authRateLimit, async (req, res) => {
  const schema = z.object({ email: z.string().email(), password: z.string() });
  if (!validate(schema, req.body, res)) return;
  try {
    const tokens = await loginUser(
      req.body.email, req.body.password,
      req.ip || '', req.headers['user-agent'] || ''
    );
    res.json(tokens);
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === 'INVALID_CREDENTIALS') res.status(401).json({ error: 'Invalid email or password' });
    else if (e.code === 'BANNED') res.status(403).json({ error: 'Account suspended' });
    else { logger.error('Login error', err); res.status(500).json({ error: 'Login failed' }); }
  }
});

router.post('/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) { res.status(400).json({ error: 'Refresh token required' }); return; }
  try {
    const tokens = await refreshTokens(refreshToken, req.ip || '');
    res.json(tokens);
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

router.post('/auth/logout', requireAuth, async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) await revokeRefreshToken(refreshToken);
  res.json({ message: 'Logged out' });
});

router.get('/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') { res.status(400).json({ error: 'Token required' }); return; }
  try {
    await verifyEmail(token);
    res.json({ message: 'Email verified successfully' });
  } catch {
    res.status(400).json({ error: 'Invalid or expired verification token' });
  }
});

// ═══════════════════════════════════════════════════
// USER PROFILE
// ═══════════════════════════════════════════════════
router.get('/user/me', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.username, u.display_name, u.roblox_username,
            u.avatar_url, u.email_verified, u.created_at,
            sp.name AS plan_name, sp.display_name AS plan_display_name,
            sp.requests_per_day, sp.requests_per_month, sp.features,
            sub.status AS subscription_status, sub.current_period_end
     FROM users u
     LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
     LEFT JOIN subscriptions sub ON sub.user_id = u.id AND sub.status = 'active'
     WHERE u.id = $1`,
    [req.user!.sub]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }
  res.json(rows[0]);
});

router.patch('/user/me', requireAuth, async (req, res) => {
  const schema = z.object({
    displayName: z.string().max(100).optional(),
    robloxUsername: z.string().max(50).optional(),
  });
  if (!validate(schema, req.body, res)) return;
  const { displayName, robloxUsername } = req.body;
  await db.query(
    `UPDATE users SET display_name = COALESCE($1, display_name),
       roblox_username = COALESCE($2, roblox_username),
       updated_at = NOW()
     WHERE id = $3`,
    [displayName, robloxUsername, req.user!.sub]
  );
  res.json({ message: 'Profile updated' });
});

// ═══════════════════════════════════════════════════
// CHAT / AI ROUTES (the core product)
// ═══════════════════════════════════════════════════
router.post('/chat', requireAuth, checkBanned, planUsageLimit, async (req, res) => {
  const schema = z.object({
    message: z.string().min(1).max(32000),
    conversationId: z.string().uuid().optional(),
    stream: z.boolean().optional().default(false),
  });
  if (!validate(schema, req.body, res)) return;

  const { message, conversationId: rawConvId, stream } = req.body;
  const userId = req.user!.sub;
  const planName = req.user!.plan;

  // Get plan token limits
  const { rows: planRows } = await db.query<{ max_tokens_per_request: number; requests_per_day: number; requests_per_month: number }>(
    `SELECT sp.max_tokens_per_request, sp.requests_per_day, sp.requests_per_month
     FROM users u JOIN subscription_plans sp ON u.plan_id = sp.id WHERE u.id = $1`,
    [userId]
  );
  const plan = planRows[0] ?? { max_tokens_per_request: 2048, requests_per_day: 20, requests_per_month: 100 };

  try {
    const conversationId = await ensureConversation(userId, rawConvId, message);

    // Log analytics event
    await db.query(
      `INSERT INTO analytics_events (user_id, event_type, properties)
       VALUES ($1, 'chat_sent', $2)`,
      [userId, JSON.stringify({ conversationId, messageLength: message.length, stream })]
    );

    if (stream) {
      await streamChatWithClaude({
        userId, userMessage: message, conversationId,
        planName, maxTokens: plan.max_tokens_per_request, res,
      });
    } else {
      const result = await chatWithClaude({
        userId, userMessage: message, conversationId,
        planName, maxTokens: plan.max_tokens_per_request,
      });
      res.json({ conversationId, ...result });
    }
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'LIMIT_DAILY' || e.code === 'LIMIT_MONTHLY') {
      res.status(429).json({ error: e.message, upgradeUrl: `${process.env.DASHBOARD_URL}/billing` });
    } else {
      logger.error('Chat error', { error: e.message, userId });
      res.status(500).json({ error: 'AI request failed. Please try again.' });
    }
  }
});

// ═══════════════════════════════════════════════════
// CONVERSATIONS
// ═══════════════════════════════════════════════════
router.get('/conversations', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const { rows } = await db.query(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id) AS message_count,
            MAX(m.created_at) AS last_message_at
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.user_id = $1 AND c.archived = false
     GROUP BY c.id, c.title, c.created_at, c.updated_at
     ORDER BY COALESCE(MAX(m.created_at), c.created_at) DESC
     LIMIT $2 OFFSET $3`,
    [req.user!.sub, limit, offset]
  );
  res.json({ conversations: rows, limit, offset });
});

router.get('/conversations/:id', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.*, array_agg(
       json_build_object('id', m.id, 'role', m.role, 'content', m.content, 'created_at', m.created_at)
       ORDER BY m.created_at
     ) AS messages
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.id = $1 AND c.user_id = $2
     GROUP BY c.id`,
    [req.params.id, req.user!.sub]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Conversation not found' }); return; }
  res.json(rows[0]);
});

router.delete('/conversations/:id', requireAuth, async (req, res) => {
  await db.query(
    `UPDATE conversations SET archived = true WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user!.sub]
  );
  res.json({ message: 'Conversation archived' });
});

// ═══════════════════════════════════════════════════
// USAGE STATS
// ═══════════════════════════════════════════════════
router.get('/usage', requireAuth, async (req, res) => {
  const userId = req.user!.sub;

  const [daily, monthly, planInfo] = await Promise.all([
    db.query<{ count: string; tokens_in: string; tokens_out: string }>(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(tokens_input), 0) AS tokens_in,
              COALESCE(SUM(tokens_output), 0) AS tokens_out
       FROM usage_logs WHERE user_id = $1 AND success = true
         AND created_at >= DATE_TRUNC('day', NOW())`,
      [userId]
    ),
    db.query<{ count: string; tokens_in: string; tokens_out: string; cost: string }>(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(tokens_input), 0) AS tokens_in,
              COALESCE(SUM(tokens_output), 0) AS tokens_out,
              COALESCE(SUM(cost_usd), 0) AS cost
       FROM usage_logs WHERE user_id = $1 AND success = true
         AND created_at >= DATE_TRUNC('month', NOW())`,
      [userId]
    ),
    db.query<{ requests_per_day: number; requests_per_month: number }>(
      `SELECT sp.requests_per_day, sp.requests_per_month
       FROM users u JOIN subscription_plans sp ON u.plan_id = sp.id
       WHERE u.id = $1`,
      [userId]
    ),
  ]);

  res.json({
    today: {
      requests: parseInt(daily.rows[0].count),
      tokensInput: parseInt(daily.rows[0].tokens_in),
      tokensOutput: parseInt(daily.rows[0].tokens_out),
      limit: planInfo.rows[0]?.requests_per_day ?? 20,
    },
    month: {
      requests: parseInt(monthly.rows[0].count),
      tokensInput: parseInt(monthly.rows[0].tokens_in),
      tokensOutput: parseInt(monthly.rows[0].tokens_out),
      costUsd: parseFloat(monthly.rows[0].cost).toFixed(4),
      limit: planInfo.rows[0]?.requests_per_month ?? 100,
    },
  });
});

// ═══════════════════════════════════════════════════
// BILLING / STRIPE
// ═══════════════════════════════════════════════════
router.post('/billing/create-checkout', requireAuth, async (req, res) => {
  const schema = z.object({ planName: z.enum(['pro', 'team', 'enterprise']) });
  if (!validate(schema, req.body, res)) return;

  const { rows: plan } = await db.query(
    `SELECT * FROM subscription_plans WHERE name = $1`, [req.body.planName]
  );
  if (!plan[0]?.stripe_price_id) { res.status(400).json({ error: 'Plan not available' }); return; }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: plan[0].stripe_price_id, quantity: 1 }],
    success_url: `${process.env.DASHBOARD_URL}/billing?success=true`,
    cancel_url: `${process.env.DASHBOARD_URL}/billing?canceled=true`,
    metadata: { userId: req.user!.sub, planName: req.body.planName },
  });
  res.json({ url: session.url });
});

router.post('/billing/portal', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 LIMIT 1`,
    [req.user!.sub]
  );
  if (!rows[0]?.stripe_customer_id) { res.status(400).json({ error: 'No billing account' }); return; }

  const session = await stripe.billingPortal.sessions.create({
    customer: rows[0].stripe_customer_id,
    return_url: `${process.env.DASHBOARD_URL}/billing`,
  });
  res.json({ url: session.url });
});

// ═══════════════════════════════════════════════════
// CODE JOBS — Website → Studio bridge
// ═══════════════════════════════════════════════════

// POST /jobs — Website submits a "please code this" request
router.post('/jobs', requireAuth, checkBanned, planUsageLimit, async (req, res) => {
  const schema = z.object({
    prompt:         z.string().min(5).max(4000),
    scriptType:     z.enum(['Script', 'LocalScript', 'ModuleScript']).default('Script'),
    insertLocation: z.string().max(100).default('ServerScriptService'),
  });
  if (!validate(schema, req.body, res)) return;

  const { prompt, scriptType, insertLocation } = req.body;
  const userId = req.user!.sub;

  try {
    const { jobId } = await createCodeJob(userId, prompt, scriptType, insertLocation);
    res.status(202).json({
      jobId,
      message: 'Job created. Claude is generating your code. The Studio plugin will insert it automatically.',
    });
  } catch (err) {
    logger.error('Create job error', err);
    res.status(500).json({ error: 'Failed to create code job' });
  }
});

// GET /jobs/pending — Plugin polls this every 3 seconds to pick up new code
router.get('/jobs/pending', requireAuth, async (req, res) => {
  try {
    const result = await getPendingJobsForUser(req.user!.sub);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pending jobs' });
  }
});

// GET /jobs/:id/status — Website polls this to show progress to the user
router.get('/jobs/:id/status', requireAuth, async (req, res) => {
  const status = await getJobStatus(req.params.id, req.user!.sub);
  if (!status) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(status);
});

// POST /jobs/:id/inserted — Plugin calls this after it inserts the code into Studio
router.post('/jobs/:id/inserted', requireAuth, async (req, res) => {
  try {
    await markJobInserted(req.params.id, req.user!.sub);
    res.json({ message: 'Job marked as inserted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark job inserted' });
  }
});

// GET /jobs — Website shows history of all code jobs
router.get('/jobs', requireAuth, async (req, res) => {
  const history = await getUserJobHistory(req.user!.sub);
  res.json({ jobs: history });
});

// ═══════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════
router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const search = req.query.search as string;

  let query = `SELECT u.id, u.email, u.username, u.is_banned, u.created_at,
                       sp.name AS plan_name, u.last_login_at
               FROM users u LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
               WHERE 1=1`;
  const params: unknown[] = [];

  if (search) {
    params.push(`%${search}%`);
    query += ` AND (u.email ILIKE $${params.length} OR u.username ILIKE $${params.length})`;
  }
  params.push(limit, offset);
  query += ` ORDER BY u.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const { rows } = await db.query(query, params);
  res.json({ users: rows });
});

router.post('/admin/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
  const { reason } = req.body;
  await db.query(
    `UPDATE users SET is_banned = true, ban_reason = $1 WHERE id = $2`,
    [reason, req.params.id]
  );
  await db.query(
    `INSERT INTO audit_logs (actor_id, user_id, action, resource, resource_id, new_value)
     VALUES ($1, $2, 'ban_user', 'user', $2, $3)`,
    [req.user!.sub, req.params.id, JSON.stringify({ reason })]
  );
  res.json({ message: 'User banned' });
});

router.get('/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  const [users, revenue, usage] = await Promise.all([
    db.query(`SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS new_30d
              FROM users`),
    db.query(`SELECT COALESCE(SUM(amount_cents), 0) AS total_cents,
              COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())), 0) AS month_cents
              FROM billing_records WHERE status = 'paid'`),
    db.query(`SELECT COUNT(*) AS total_requests,
              COALESCE(SUM(tokens_input + tokens_output), 0) AS total_tokens
              FROM usage_logs WHERE success = true
                AND created_at >= DATE_TRUNC('month', NOW())`),
  ]);
  res.json({
    users: users.rows[0],
    revenue: revenue.rows[0],
    usage: usage.rows[0],
  });
});

export default router;
