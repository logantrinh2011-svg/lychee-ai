import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from '../db/client.js';
import { logger } from '../utils/logger.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL = 'gemini-3.5-flash';

const CODE_GEN_SYSTEM = `You are Lime AI, an expert Roblox Luau code generator. When the user describes what they want, generate COMPLETE, WORKING Luau code.

CRITICAL RULES:
- Always output ONLY a JSON object with this exact structure:
  {"scriptName": "DescriptiveName", "scriptType": "Script", "insertLocation": "ServerScriptService", "code": "-- full luau code here", "explanation": "One sentence"}
- Choose scriptType automatically: "Script" for server code, "LocalScript" for client/GUI code, "ModuleScript" for shared logic
- Choose insertLocation automatically based on what is being built:
  - Server scripts → "ServerScriptService"
  - GUI/client code → "StarterGui"
  - Client player scripts → "StarterPlayerScripts"
  - Shared modules → "ReplicatedStorage"
  - Character scripts → "StarterCharacterScripts"
- The code field must contain ONLY valid Luau code, no markdown, no backticks
- Create ALL required instances in code using Instance.new()
- Output ONLY the JSON object, nothing else`;

export async function createCodeJob(
  userId: string, prompt: string,
  scriptType: 'Script' | 'LocalScript' | 'ModuleScript',
  insertLocation: string
): Promise<{ jobId: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO code_jobs (user_id, prompt, script_type, insert_location, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
    [userId, prompt, scriptType, insertLocation]
  );
  const jobId = rows[0].id;
  setImmediate(() => processCodeJob(jobId, userId, prompt));
  return { jobId };
}

async function processCodeJob(
  jobId: string, userId: string, prompt: string
): Promise<void> {
  await db.query(`UPDATE code_jobs SET status = 'processing' WHERE id = $1`, [jobId]);
  try {
    const model = genAI.getGenerativeModel({ model: MODEL, systemInstruction: CODE_GEN_SYSTEM });
    const result = await model.generateContent(`Generate Roblox Studio code for: ${prompt}`);
    const rawText = result.response.text();
    const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.code || !parsed.scriptName) throw new Error('Missing code or scriptName');

    const scriptType = parsed.scriptType || 'Script';
    const insertLocation = parsed.insertLocation || 'ServerScriptService';

    await db.query(
      `UPDATE code_jobs SET status = 'completed', generated_code = $1,
       explanation = $2, script_name = $3, script_type = $4, insert_location = $5, completed_at = NOW() WHERE id = $6`,
      [parsed.code, parsed.explanation, parsed.scriptName, scriptType, insertLocation, jobId]
    );
    logger.info('Code job completed', { jobId, scriptName: parsed.scriptName, scriptType, insertLocation });
    await db.query(
      `INSERT INTO analytics_events (user_id, event_type, properties) VALUES ($1, 'code_job_completed', $2)`,
      [userId, JSON.stringify({ jobId, scriptType, insertLocation })]
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

export async function getPendingJobsForUser(userId: string) {
  const { rows } = await db.query(
    `SELECT id, script_name, script_type, insert_location,
            generated_code, explanation, created_at
     FROM code_jobs WHERE user_id = $1 AND status = 'completed'
     ORDER BY created_at ASC LIMIT 10`,
    [userId]
  );
  return {
    jobs: rows.map((r: any) => ({
      id: r.id, scriptName: r.script_name, scriptType: r.script_type,
      insertLocation: r.insert_location, code: r.generated_code,
      explanation: r.explanation, createdAt: r.created_at,
    })),
  };
}

export async function markJobInserted(jobId: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE code_jobs SET status = 'inserted', inserted_at = NOW() WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
}

export async function getJobStatus(jobId: string, userId: string) {
  const { rows } = await db.query(
    `SELECT status, explanation, script_name, error_message FROM code_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  if (!rows[0]) return null;
  return { status: rows[0].status, explanation: rows[0].explanation, scriptName: rows[0].script_name, error: rows[0].error_message };
}

export async function getUserJobHistory(userId: string, limit = 20) {
  const { rows } = await db.query(
    `SELECT id, prompt, script_name, script_type, status, created_at, completed_at, inserted_at, insert_location
     FROM code_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}
