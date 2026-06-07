// ============================================================
// Lime AI — Code Jobs Service
// Bridge between website requests and Studio code insertion
// ============================================================

import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from '../db/client.js';
import { logger } from '../utils/logger.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL = 'gemini-1.5-flash';

// ─────────────────────────────────────────────
// SYSTEM PROMPT — tuned for code generation
// ─────────────────────────────────────────────
const CODE_GEN_SYSTEM = `You are Lime AI, an expert Roblox Luau code generator.

When the user describes what they want, you generate COMPLETE, WORKING Luau code for Roblox Studio.

RULES:
- Always output a JSON object with this exact structure:
  {
    "scriptName": "DescriptiveName",
    "code": "-- full luau code here",
    "explanation": "One sentence explaining what the code does and where to put it"
  }
- The "code" field must contain ONLY valid Luau code, no markdown, no backticks
- Always write production-ready code with error handling (pcall where needed)
- Use proper Roblox services (Players, ReplicatedStorage, etc.)
- Add clear comments in the code
- The scriptName should be PascalCase, descriptive, no spaces
- Output ONLY the JSON object. No preamble, no explanation outside the JSON.`;

// ─────────────────────────────────────────────
// CREATE A NEW CODE JOB (from website)
// ─────────────────────────────────────────────
export async function createCodeJob(
  userId: string,
  prompt: string,
  scriptType: 'Script' | 'LocalScript' | 'ModuleScript',
  insertLocation: string
): Promise<{ jobId: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO code_jobs (user_id, prompt, script_type, insert_location, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [userId, prompt, scriptType, insertLocation]
  );

  const jobId = rows[0].id;

  // Process asynchronously — don't make the website wait
  setImmediate(() => processCodeJob(jobId, userId, prompt, scriptType));

  return { jobId };
}

// ─────────────────────────────────────────────
// PROCESS A JOB — call Claude, save result
// ─────────────────────────────────────────────
async function processCodeJob(
  jobId: string,
  userId: string,
  prompt: string,
  scriptType: string
): Promise<void> {
  // Mark as processing
  await db.query(
    `UPDATE code_jobs SET status = 'processing' WHERE id = $1`,
    [jobId]
  );

  try {
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: CODE_GEN_SYSTEM,
      messages: [{
        role: 'user',
        content: `Generate a ${scriptType} for Roblox Studio that does the following:\n\n${prompt}`,
      }],
    });

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('');

    // Parse the JSON response from Claude
    let parsed: { scriptName: string; code: string; explanation: string };
    try {
      // Strip any accidental markdown fences
      const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      throw new Error('Claude returned invalid JSON: ' + rawText.slice(0, 200));
    }

    // Validate fields
    if (!parsed.code || !parsed.scriptName) {
      throw new Error('Claude response missing code or scriptName');
    }

    await db.query(
      `UPDATE code_jobs
       SET status = 'completed',
           generated_code = $1,
           explanation = $2,
           script_name = $3,
           completed_at = NOW()
       WHERE id = $4`,
      [parsed.code, parsed.explanation, parsed.scriptName, jobId]
    );

    logger.info('Code job completed', { jobId, scriptName: parsed.scriptName });

    // Track usage
    await db.query(
      `INSERT INTO analytics_events (user_id, event_type, properties)
       VALUES ($1, 'code_job_completed', $2)`,
      [userId, JSON.stringify({ jobId, scriptType, promptLength: prompt.length,
        tokensInput: response.usage.input_tokens,
        tokensOutput: response.usage.output_tokens })]
    );

  } catch (err: unknown) {
    const error = err as Error;
    logger.error('Code job failed', { jobId, error: error.message });
    await db.query(
      `UPDATE code_jobs SET status = 'failed', error_message = $1 WHERE id = $2`,
      [error.message, jobId]
    );
  }
}

// ─────────────────────────────────────────────
// GET PENDING JOBS FOR USER (polled by plugin)
// Returns completed jobs not yet inserted
// ─────────────────────────────────────────────
export async function getPendingJobsForUser(userId: string): Promise<{
  jobs: Array<{
    id: string;
    scriptName: string;
    scriptType: string;
    insertLocation: string;
    code: string;
    explanation: string;
    createdAt: string;
  }>;
}> {
  const { rows } = await db.query<{
    id: string; script_name: string; script_type: string;
    insert_location: string; generated_code: string;
    explanation: string; created_at: Date;
  }>(
    `SELECT id, script_name, script_type, insert_location,
            generated_code, explanation, created_at
     FROM code_jobs
     WHERE user_id = $1 AND status = 'completed'
     ORDER BY created_at ASC
     LIMIT 10`,
    [userId]
  );

  return {
    jobs: rows.map(r => ({
      id: r.id,
      scriptName: r.script_name,
      scriptType: r.script_type,
      insertLocation: r.insert_location,
      code: r.generated_code,
      explanation: r.explanation,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

// ─────────────────────────────────────────────
// MARK JOB AS INSERTED (called by plugin)
// ─────────────────────────────────────────────
export async function markJobInserted(jobId: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE code_jobs
     SET status = 'inserted', inserted_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );

  await db.query(
    `INSERT INTO analytics_events (user_id, event_type, properties)
     VALUES ($1, 'code_inserted_to_studio', $2)`,
    [userId, JSON.stringify({ jobId })]
  );
}

// ─────────────────────────────────────────────
// GET JOB STATUS (for website polling)
// ─────────────────────────────────────────────
export async function getJobStatus(jobId: string, userId: string): Promise<{
  status: string;
  explanation?: string;
  scriptName?: string;
  error?: string;
} | null> {
  const { rows } = await db.query<{
    status: string; explanation: string;
    script_name: string; error_message: string;
  }>(
    `SELECT status, explanation, script_name, error_message
     FROM code_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  if (!rows[0]) return null;
  return {
    status: rows[0].status,
    explanation: rows[0].explanation,
    scriptName: rows[0].script_name,
    error: rows[0].error_message,
  };
}

// ─────────────────────────────────────────────
// LIST USER'S JOB HISTORY
// ─────────────────────────────────────────────
export async function getUserJobHistory(userId: string, limit = 20): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT id, prompt, script_name, script_type, status,
            created_at, completed_at, inserted_at
     FROM code_jobs WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}
