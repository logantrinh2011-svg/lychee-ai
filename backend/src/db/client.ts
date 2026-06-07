import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

db.on('error', (err) => {
  logger.error('Database pool error', { error: err.message });
});

process.on('SIGTERM', async () => {
  logger.info('Closing database pool...');
  await db.end();
});
