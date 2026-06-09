import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from '../db/client.js';
import { logger } from '../utils/logger.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL = 'gemini-3.5-flash';

const CODE_GEN_SYSTEM = `You are Lychee AI, a master Roblox Luau developer with full control of Roblox Studio.

When the user describes what they want, generate COMPLETE, WORKING Luau code that builds EVERYTHING programmatically.

CRITICAL RULES:
- If the feature needs multiple scripts in different locations, output a JSON array:
  [
    {"scriptName": "Name1", "scriptType": "Script", "insertLocation": "ServerScriptService", "code": "-- server code", "explanation": "one sentence"},
    {"scriptName": "Name2", "scriptType": "LocalScript", "insertLocation": "StarterGui", "code": "-- client code", "explanation": "one sentence"}
  ]
- If only one script is needed, output a single JSON object:
  {"scriptName": "Name", "scriptType": "Script", "insertLocation": "ServerScriptService", "code": "-- code here", "explanation": "one sentence"}
- Choose scriptType AND insertLocation automatically:
  - Server game logic, datastores, events → scriptType: "Script", insertLocation: "ServerScriptService"
  - GUI screens, shop menus, HUDs → scriptType: "LocalScript", insertLocation: "StarterGui"
  - Player client code → scriptType: "LocalScript", insertLocation: "StarterPlayerScripts"
  - Character movement, animations → scriptType: "LocalScript", insertLocation: "StarterCharacterScripts"
  - Tools, weapons, swords → scriptType: "Script", insertLocation: "StarterPack"
  - Shared modules → scriptType: "ModuleScript", insertLocation: "ReplicatedStorage"
- Build ALL visuals using Instance.new() — create every Part, Model, WeldConstraint, SpecialMesh, ScreenGui, Frame, TextLabel in code
- NEVER assume anything exists in the game — create everything from scratch
- Use pcall for error handling
- Output ONLY the JSON, no markdown, no extra text`;

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

    const items = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
      if (!item.code || !item.scriptName) continue;
      const scriptType = item.scriptType || 'Script';
      const insertLocation = item.insertLocation || 'ServerScriptService';

      await db.query(
        `INSERT INTO code_jobs (user_id, prompt, script_type, insert_location, status, generated_code, explanation, script_name, completed_at)
         VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, NOW())`,
        [userId, prompt, scriptType, insertLocation, item.code, item.explanation, item.scriptName]
      );
    }

    // Mark original job as completed
    await db.query(
      `UPDATE code_jobs SET status = 'completed', script_name = $1, completed_at = NOW() WHERE id = $2`,
      [items[0]?.scriptName || 'LimeAI_Script', jobId]
    );

    logger.info('Code job completed', { jobId, count: items.length });

    await db.query(
      `INSERT INTO analytics_events (user_id, event_type, properties) VALUES ($1, 'code_job_completed', $2)`,
      [userId, JSON.stringify({ jobId, count: items.length })]
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
     ORDER BY created_at ASC LIMIT 20`,
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
