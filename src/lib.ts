import dotenv from "dotenv";
dotenv.config({ override: true }); // values in .env win over leftover shell variables like PGPASSWORD
import pg from "pg";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
db.query("SELECT 1").then(
  () => console.log("Database connected ✓"),
  (e) => console.error("Database connection failed:", e.message, "| user:", process.env.PGUSER, "| password length:", process.env.PGPASSWORD?.length),
);
const env = process.env;
const aiUser = new AsyncLocalStorage<string>();
export function runWithAIUser<T>(userId: string | undefined, fn: () => T): T {
  return userId ? aiUser.run(userId, fn) : fn();
}

function configuredLimit(name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive whole number.`);
  return value;
}

const userDailyAICallLimit = configuredLimit("AI_USER_DAILY_CALL_LIMIT", 40);
const globalDailyAICallLimit = configuredLimit("AI_GLOBAL_DAILY_CALL_LIMIT", 1000);
let aiUsageReady: Promise<void> | undefined;

async function ensureAIUsageTable(): Promise<void> {
  if (!aiUsageReady) {
    aiUsageReady = db.query(`CREATE TABLE IF NOT EXISTS ai_request_usage (
      usage_day date NOT NULL,
      scope text NOT NULL,
      calls int NOT NULL DEFAULT 0,
      PRIMARY KEY (usage_day, scope)
    )`).then(() => undefined);
  }
  return aiUsageReady;
}

export async function aiUsage(userId: string) {
  await ensureAIUsageTable();
  const { rows: [row] } = await db.query(
    `SELECT
       coalesce(max(calls) FILTER (WHERE scope=$1),0)::int AS user_calls,
       coalesce(max(calls) FILTER (WHERE scope='global'),0)::int AS global_calls
     FROM ai_request_usage
     WHERE usage_day=(now() AT TIME ZONE 'UTC')::date AND scope IN ($1,'global')`,
    [`user:${userId}`]);
  return {
    user: { used: row.user_calls, limit: userDailyAICallLimit, remaining: Math.max(0, userDailyAICallLimit - row.user_calls) },
    platform: { used: row.global_calls, limit: globalDailyAICallLimit, remaining: Math.max(0, globalDailyAICallLimit - row.global_calls) },
    resetsAt: "00:00 UTC",
  };
}

async function reserveAIRequest(): Promise<void> {
  const userId = aiUser.getStore();
  if (!userId) throw Object.assign(new Error("AI requests must be made from a signed-in account."), { statusCode: 401 });
  await ensureAIUsageTable();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const day = "(now() AT TIME ZONE 'UTC')::date";
    const global = await client.query(
      `INSERT INTO ai_request_usage (usage_day, scope, calls) VALUES (${day},'global',1)
       ON CONFLICT (usage_day,scope) DO UPDATE SET calls=ai_request_usage.calls+1
       WHERE ai_request_usage.calls < $1 RETURNING calls`, [globalDailyAICallLimit]);
    if (!global.rowCount)
      throw Object.assign(new Error("The shared AI allowance is temporarily exhausted for today. Please try again after 00:00 UTC."), { statusCode: 429 });
    const user = await client.query(
      `INSERT INTO ai_request_usage (usage_day, scope, calls) VALUES (${day},$1,1)
       ON CONFLICT (usage_day,scope) DO UPDATE SET calls=ai_request_usage.calls+1
       WHERE ai_request_usage.calls < $2 RETURNING calls`, [`user:${userId}`, userDailyAICallLimit]);
    if (!user.rowCount)
      throw Object.assign(new Error("You’ve reached today’s AI request allowance. You can still study your notes and review saved results; your allowance resets at 00:00 UTC."), { statusCode: 429 });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function assertCourseOwner(courseId: string, userId: string) {
  const { rows } = await db.query(`SELECT id FROM courses WHERE id=$1 AND owner_id=$2`, [courseId, userId]);
  if (!rows.length) throw Object.assign(new Error("Course not found."), { statusCode: 404 });
}
export async function assertLecturerOwner(lecturerId: string, userId: string) {
  const { rows } = await db.query(`SELECT id FROM lecturers WHERE id=$1 AND owner_id=$2`, [lecturerId, userId]);
  if (!rows.length) throw Object.assign(new Error("Lecturer not found."), { statusCode: 404 });
}
// small automatic migration: saved feedback on written answers
db.query("ALTER TABLE attempt_answers ADD COLUMN IF NOT EXISTS feedback text").catch(() => null);
const EMB = env.EMBED_PROVIDER ?? "gemini"; // gemini | mistral | openrouter | openai
// AI models return MCQ options in different shapes (list, {"A": ...} object, or a string). Always give back a list of strings.
export function normOptions(o: any): string[] | null {
  if (o == null) return null;
  if (typeof o === "string") {
    try { return normOptions(JSON.parse(o)); }
    catch { const parts = o.split(/\n|(?=\b[A-D][).]\s)/).map((s) => s.trim()).filter(Boolean); return parts.length > 1 ? parts : null; }
  }
  if (Array.isArray(o)) return o.map((x) => (typeof x === "string" ? x : String(x?.text ?? x?.option ?? x?.label ?? JSON.stringify(x))));
  if (typeof o === "object") return Object.keys(o).sort().map((k) => `${k}. ${o[k]}`);
  return null;
}
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
let aiCacheReady: Promise<boolean> | undefined;

async function ensureAICache(): Promise<boolean> {
  if (!aiCacheReady) {
    aiCacheReady = db.query(`CREATE TABLE IF NOT EXISTS ai_cache (
      key text PRIMARY KEY,
      kind text NOT NULL,
      payload jsonb NOT NULL,
      hits int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )`).then(() => true).catch((e: Error) => {
      console.warn("AI response cache unavailable; continuing without cache:", e.message);
      return false;
    });
  }
  return aiCacheReady;
}

function cacheKey(kind: string, value: unknown): string {
  return createHash("sha256").update(`${kind}\n${JSON.stringify(value)}`).digest("hex");
}

async function getCached<T>(key: string): Promise<T | undefined> {
  if (!await ensureAICache()) return undefined;
  try {
    const { rows: [row] } = await db.query(`UPDATE ai_cache SET hits=hits+1 WHERE key=$1 RETURNING payload`, [key]);
    return row?.payload as T | undefined;
  } catch (e) {
    console.warn("AI response cache read failed:", e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

async function setCached(key: string, kind: string, value: unknown): Promise<void> {
  if (!await ensureAICache()) return;
  try {
    await db.query(
      `INSERT INTO ai_cache (key, kind, payload) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, kind, JSON.stringify(value)]);
  } catch (e) {
    console.warn("AI response cache write failed:", e instanceof Error ? e.message : String(e));
  }
}

// fetch with retries on rate limits, server errors and dropped connections. retries = 0 fails immediately.
async function call(fn: () => Promise<Response>, retries = 5): Promise<any> {
  for (let n = 0; ; n++) {
    let r: Response;
    await reserveAIRequest();
    try { r = await fn(); }
    catch (e: any) { // network-level failure: no HTTP response at all
      const why = e.cause?.code ?? e.cause?.message ?? e.message;
      if (n < Math.min(retries, 2)) { await sleep(1500); continue; }
      throw new Error(`Network error (${why}): could not reach the AI provider.`);
    }
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && n < retries) {
      const wait = Number(r.headers.get("retry-after")); // honour the provider's own wait time
      await sleep(Math.min(wait > 0 ? wait * 1000 : 2000 * 2 ** n, 30000));
      continue;
    }
    throw new Error(`API error ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

// OpenAI-compatible providers: [base URL, API-key variable, default model]
const OAI_LLM: Record<string, [string, string, string]> = {
  groq: ["https://api.groq.com/openai/v1", "GROQ_API_KEY", "openai/gpt-oss-120b"],
  mistral: ["https://api.mistral.ai/v1", "MISTRAL_API_KEY", "mistral-small-latest"],
  cerebras: ["https://api.cerebras.ai/v1", "CEREBRAS_API_KEY", "gpt-oss-120b"],
  openrouter: ["https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", ""],
};
const OAI_EMB: Record<string, [string, string, string, number]> = {
  openai: ["https://api.openai.com/v1", "OPENAI_API_KEY", "text-embedding-3-small", 64],
  openrouter: ["https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", "nvidia/llama-nemotron-embed-vl-1b-v2:free", 64],
  mistral: ["https://api.mistral.ai/v1", "MISTRAL_API_KEY", "mistral-embed", 16],
};

// Returns JSON strings like "[0.1,0.2,...]" (stored as jsonb). Don't mix embedding providers within one database.
export async function embed(texts: string[]): Promise<string[]> {
  if (!texts.length) return [];
  const model = EMB === "gemini" ? "gemini-embedding-001:768" : env.EMBED_MODEL ?? OAI_EMB[EMB]?.[2] ?? "";
  const kind = `embedding:${EMB}:${model}`;
  const keys = texts.map((text) => cacheKey(kind, text));
  const scopedKeys = keys.map((key) => cacheKey("user-ai-cache", { userId: aiUser.getStore(), key }));
  if (await ensureAICache()) {
    try {
      const { rows } = await db.query(`SELECT key, payload FROM ai_cache WHERE key=ANY($1::text[])`, [scopedKeys]);
      const cached = new Map(rows.map((row) => [row.key, row.payload]));
      if (scopedKeys.every((key) => Array.isArray(cached.get(key))))
        return scopedKeys.map((key) => JSON.stringify(cached.get(key)));
    } catch (e) {
      console.warn("Embedding cache read failed:", e instanceof Error ? e.message : String(e));
    }
  }
  const out: string[] = [];
  const size = EMB === "gemini" ? 100 : OAI_EMB[EMB]?.[3] ?? 32;
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    let vecs: number[][];
    if (EMB === "gemini") {
      const j = await call(() => fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
        body: JSON.stringify({ requests: batch.map((text) => ({
          model: "models/gemini-embedding-001", content: { parts: [{ text }] }, outputDimensionality: 768 })) }),
      }));
      vecs = j.embeddings.map((e: any) => e.values);
    } else {
      const p = OAI_EMB[EMB];
      if (!p) throw new Error(`Unknown EMBED_PROVIDER "${EMB}"`);
      const j = await call(() => fetch(`${p[0]}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env[p[1]]}` },
        body: JSON.stringify({ model: env.EMBED_MODEL ?? p[2], input: batch }),
      }));
      vecs = j.data.map((d: any) => d.embedding);
    }
    out.push(...vecs.map((v) => `[${v.join(",")}]`));
    await Promise.all(vecs.map((v, j) => setCached(scopedKeys[i + j], kind, v)));
  }
  return out;
}

// Providers tried in order: LLM_PROVIDER first, then LLM_FALLBACK (comma-separated). Ones without an API key are skipped.
const KEYVAR: Record<string, string> = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY", cerebras: "CEREBRAS_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const CHAIN = [env.LLM_PROVIDER ?? "gemini", ...(env.LLM_FALLBACK ?? "").split(",")]
  .map((s) => s.trim()).filter((p, i, a) => p && a.indexOf(p) === i && KEYVAR[p] && env[KEYVAR[p]]);

async function llmOnce(p: string, primary: boolean, system: string, user: string, retries: number): Promise<string> {
  const model = (primary ? env.LLM_MODEL : undefined) ?? env[p === "anthropic" ? "CLAUDE_MODEL" : `${p.toUpperCase()}_MODEL`];
  if (p === "anthropic") {
    const j = await call(() => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: model ?? "claude-sonnet-5-5", max_tokens: 8000, system, messages: [{ role: "user", content: user }] }),
    }), retries);
    return j.content.map((b: any) => b.text ?? "").join("");
  }
  if (OAI_LLM[p]) {
    const [base, keyVar, dflt] = OAI_LLM[p];
    const m = model ?? dflt;
    if (!m) throw new Error(`Set ${p.toUpperCase()}_MODEL in .env`);
    const j = await call(() => fetch(`${env[`${p.toUpperCase()}_BASE_URL`] ?? base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env[keyVar]}` },
      body: JSON.stringify({ model: m, temperature: 0.3, max_tokens: 8000,
        ...(primary && env.LLM_REASONING_EFFORT ? { reasoning_effort: env.LLM_REASONING_EFFORT } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    }), retries);
    const c = j.choices?.[0]?.message?.content ?? ""; // reasoning models can return a list of chunks
    return Array.isArray(c) ? c.map((x: any) => x.text ?? "").join("") : c;
  }
  const j = await call(() => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model ?? "gemini-3.8-flash"}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 16000 },
    }),
  }), retries);
  return (j.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? "").join("");
}

export async function llmJson<T>(system: string, user: string): Promise<T> {
  system += "\nReturn ONLY valid JSON, no markdown fences, no commentary.";
  const models = CHAIN.map((p) => [p, env.LLM_MODEL, env[p === "anthropic" ? "CLAUDE_MODEL" : `${p.toUpperCase()}_MODEL`] ?? null]);
  const key = cacheKey("llm-json", { userId: aiUser.getStore(), models, system, user });
  const cached = await getCached<T>(key);
  if (cached !== undefined) return cached;
  if (!CHAIN.length) throw new Error("No AI provider configured: set LLM_PROVIDER and its API key in .env.");
  const errors: string[] = [];
  for (let i = 0; i < CHAIN.length; i++) {
    const p = CHAIN[i], last = i === CHAIN.length - 1;
    try { // earlier providers fail over instantly; only the last one waits and retries
      const text = await llmOnce(p, i === 0, system, user, last ? 3 : 0);
      if (!text.trim()) throw new Error("returned no text");
      const m = text.replace(/```json|```/g, "").match(/[\[{][\s\S]*[\]}]/);
      const value = JSON.parse(m ? m[0] : text) as T;
      await setCached(key, "llm-json", value);
      return value;
    } catch (e: any) {
      if (e.statusCode === 429) throw e;
      errors.push(`${p}: ${String(e.message).slice(0, 160)}`);
      if (!last) console.warn(`AI provider ${p} failed, trying ${CHAIN[i + 1]}: ${String(e.message).slice(0, 120)}`);
    }
  }
  throw new Error("All AI providers are rate-limited or unavailable. Wait a few minutes, or add another provider in .env. Details: " + errors.join(" | "));
}
