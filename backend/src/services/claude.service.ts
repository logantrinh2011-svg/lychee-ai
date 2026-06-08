import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { Response } from 'express';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL = 'gemini-3.5-flash';

export function buildSystemPrompt(): string {
  return `You are Lime AI, an expert Roblox game development assistant. You have deep expertise in Lua and Luau scripting, Roblox API and all services, RemoteEvents, DataStoreService, and all Roblox Studio workflows. Always write production-quality Luau code with comments. When providing code wrap it in code blocks with lua tag. Label whether code goes in a Script, LocalScript, or ModuleScript and explain where to place it.`;
}

async function loadConversationHistory(conversationId: string, userId: string) {
  const { rows } = await db.query(
    `SELECT role, content FROM messages
     WHERE conversation_id = $1 AND user_id = $2 AND role != 'system'
     ORDER BY created_at DESC LIMIT 20`,
    [conversationId, userId]
  );
  return rows.reverse();
}

async function saveMessage(
  conversationId: string, userId: string, role: string,
  content: string, tokensInput = 0, tokensOutput = 0
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, user_id, role, content, model, tokens_input, tokens_output)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [conversationId, userId, role, content, MODEL, tokensInput, tokensOutput]
  );
  return rows[0].id;
}

export async function ensureConversation(
  userId: string, conversationId?: string, firstMessage?: string
): Promise<string> {
  if (conversationId) {
    const { rows } = await db.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    if (rows.length === 0) throw new Error('Conversation not found');
    return conversationId;
  }
  const title = firstMessage ? firstMessage.slice(0, 50) : 'New Conversation';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
    [userId, title]
  );
  return rows[0].id;
}

export async function checkUsageLimits(
  userId: string,
  planLimits: { requestsPerDay: number; requestsPerMonth: number }
): Promise<void> {
  if (planLimits.requestsPerDay === -1) return;
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*) FROM usage_logs WHERE user_id = $1 AND success = true AND created_at >= DATE_TRUNC('day', NOW())`,
    [userId]
  );
  if (parseInt(rows[0].count) >= planLimits.requestsPerDay) {
    throw Object.assign(new Error('Daily request limit exceeded'), { code: 'LIMIT_DAILY' });
  }
}

export async function chatWithClaude(params: {
  userId: string; userMessage: string; conversationId: string;
  planName: string; model?: string; maxTokens?: number;
}): Promise<{ content: string; messageId: string; tokensInput: number; tokensOutput: number }> {
  const startTime = Date.now();
  await saveMessage(params.conversationId, params.userId, 'user', params.userMessage);
  const history = await loadConversationHistory(params.conversationId, params.userId);

  const model = genAI.getGenerativeModel({ model: MODEL, systemInstruction: buildSystemPrompt() });
  const chatHistory = history.slice(0, -1).map((msg: any) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

  const chat = model.startChat({ history: chatHistory });
  const result = await chat.sendMessage(params.userMessage);
  const content = result.response.text();
  const tokensIn = result.response.usageMetadata?.promptTokenCount ?? 0;
  const tokensOut = result.response.usageMetadata?.candidatesTokenCount ?? 0;

  const messageId = await saveMessage(
    params.conversationId, params.userId, 'assistant', content, tokensIn, tokensOut
  );

  await db.query(
    `INSERT INTO usage_logs (user_id, conversation_id, message_id, plan_name, model, tokens_input, tokens_output, cost_usd, latency_ms, success)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,true)`,
    [params.userId, params.conversationId, messageId, params.planName, MODEL, tokensIn, tokensOut, Date.now() - startTime]
  );

  return { content, messageId, tokensInput: tokensIn, tokensOutput: tokensOut };
}

export async function streamChatWithClaude(params: {
  userId: string; userMessage: string; conversationId: string;
  planName: string; model?: string; maxTokens?: number; res: Response;
}): Promise<void> {
  params.res.setHeader('Content-Type', 'text/event-stream');
  params.res.setHeader('Cache-Control', 'no-cache');
  params.res.setHeader('Connection', 'keep-alive');
  params.res.flushHeaders();

  const send = (data: object) => params.res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'start', conversationId: params.conversationId });

  try {
    await saveMessage(params.conversationId, params.userId, 'user', params.userMessage);
    const history = await loadConversationHistory(params.conversationId, params.userId);
    const model = genAI.getGenerativeModel({ model: MODEL, systemInstruction: buildSystemPrompt() });
    const chatHistory = history.slice(0, -1).map((msg: any) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));

    const chat = model.startChat({ history: chatHistory });
    const result = await chat.sendMessageStream(params.userMessage);
    let fullContent = '';

    for await (const chunk of result.stream) {
      const text = chunk.text();
      fullContent += text;
      send({ type: 'delta', delta: text });
    }

    const finalResponse = await result.response;
    const tokensIn = finalResponse.usageMetadata?.promptTokenCount ?? 0;
    const tokensOut = finalResponse.usageMetadata?.candidatesTokenCount ?? 0;
    const messageId = await saveMessage(
      params.conversationId, params.userId, 'assistant', fullContent, tokensIn, tokensOut
    );
    send({ type: 'done', messageId, fullContent, tokensInput: tokensIn, tokensOutput: tokensOut });
  } catch (err: unknown) {
    send({ type: 'error', error: (err as Error).message });
  } finally {
    params.res.end();
  }
}
