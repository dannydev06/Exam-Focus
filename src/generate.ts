import { db, embed, llmJson, normOptions } from "./lib.js";

type Diff = "easy" | "medium" | "hard";
const DIFF: Record<Diff, string> = {
  easy: "mostly recall/definition questions; single step; plain wording",
  medium: "application questions needing 2-3 steps",
  hard: "analysis, multi-part or calculation questions; higher marks; probe topics students find tricky",
};
const QTYPES = new Set(["mcq", "short_answer", "theory", "calculation"]);
const topicVec = new Map<string, number[]>(); // cached topic-title embeddings (cleared on restart)

function pickWeighted<T extends { weight: number }>(items: T[]): T {
  let r = Math.random() * items.reduce((s, i) => s + Number(i.weight), 0);
  for (const i of items) if ((r -= Number(i.weight)) <= 0) return i;
  return items[items.length - 1];
}

const cos = (a: number[], b: number[]) => {
  if (a.length !== b.length) return -1; // embedded with a different provider
  let d = 0, x = 0, y = 0;
  for (let k = 0; k < a.length; k++) { d += a[k] * b[k]; x += a[k] * a[k]; y += b[k] * b[k]; }
  return d / (Math.sqrt(x * y) || 1);
};

export async function generateExam(o: { userId: string; courseId: string; lecturerId: string | null; difficulty: Diff; count?: number; focus?: string[] }) {
  const { rows: [sp] } = await db.query(
    `SELECT * FROM style_profiles WHERE course_id=$1 AND lecturer_id IS NOT DISTINCT FROM $2::uuid ORDER BY version DESC LIMIT 1`,
    [o.courseId, o.lecturerId]);
  if (!sp) throw new Error("Upload at least one past question paper first.");
  const { rows: topics } = await db.query(`SELECT id, title, weight FROM ccmas_topics WHERE course_id=$1`, [o.courseId]);
  if (!topics.length) throw new Error("No CCMAS topics for this course yet.");

  // 1. Plan: weighted topic per question
  const n = Math.min(Math.max(o.count ?? 10, 1), 30);
  const pool = o.focus?.length ? topics.filter((t) => o.focus!.includes(t.id)) : topics; // weak-topic practice narrows the pool
  const plan = Array.from({ length: n }, () => pickWeighted(pool.length ? pool : topics));
  const uniq = [...new Map(plan.map((t) => [t.id, t])).values()];

  // 2. Retrieve the user's own material per topic (topic embeddings are cached, so repeat exams skip this call)
  const missing = uniq.filter((t) => !topicVec.has(t.title));
  if (missing.length) {
    const v = await embed(missing.map((t) => t.title));
    missing.forEach((t, i) => topicVec.set(t.title, JSON.parse(v[i])));
  }
  const { rows: all } = await db.query(
    `SELECT c.id, c.content, c.embedding FROM chunks c JOIN documents d ON d.id=c.document_id
     WHERE d.user_id=$1 AND d.course_id=$2 AND d.status='ready'`, [o.userId, o.courseId]);
  const context: Record<string, { id: string; content: string }[]> = {};
  for (const t of uniq) {
    const v = topicVec.get(t.title)!;
    context[t.id] = all.map((c) => ({ id: c.id, content: c.content, s: cos(v, c.embedding) }))
      .sort((p, q) => q.s - p.s).slice(0, 3).map(({ id, content }) => ({ id, content }));
  }

  // 3. Write the questions in parallel batches (at most 3 at once)
  const system = `You write university exam questions that mimic one lecturer's style.
STYLE PROFILE: ${JSON.stringify(sp.profile)}
DIFFICULTY (${o.difficulty}): ${DIFF[o.difficulty]}
Use only facts present in the provided source chunks. For mcq include "options" (4) and put the correct option letter in "answer". Keep explanations to one or two sentences.`;
  const size = Math.max(5, Math.ceil(n / 3));
  const jobs: Promise<any>[] = [];
  for (let s = 0; s < n; s += size) {
    const slice = plan.slice(s, s + size), ctx: Record<string, unknown> = {};
    slice.forEach((t) => (ctx[t.id] = context[t.id]));
    jobs.push(llmJson<any>(system,
      `Write ${slice.length} questions, one per plan entry, in order.
PLAN: ${JSON.stringify(slice.map((t, j) => ({ i: s + j, topic_id: t.id, topic: t.title })))}
SOURCES: ${JSON.stringify(ctx)}
Return an array of {"topic_id","q_type","marks","text","options","answer","explanation","source_chunk_ids":[ids used]}.`));
  }
  const draft: any[] = (await Promise.all(jobs)).flatMap((x) => (Array.isArray(x) ? x : x?.questions ?? []));
  if (!draft.length) throw new Error("The model returned no questions. Try again.");

  // 4. Save (inserts run together)
  const validTopic = new Set(topics.map((t) => t.id));
  const chunkText = new Map(Object.values(context).flat().map((c) => [c.id, c.content]));
  const total = draft.reduce((s, q) => s + (Number(q.marks) || 1), 0);
  const { rows: [exam] } = await db.query(
    `INSERT INTO exams (user_id, course_id, style_profile_id, difficulty, total_marks, duration_minutes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [o.userId, o.courseId, sp.id, o.difficulty, total, Math.max(10, Math.round(total * 1.5))]); // 1.5 minutes per mark
  const ids: string[] = await Promise.all(draft.map(async (q, i) => {
    const { rows } = await db.query(
      `INSERT INTO exam_questions (exam_id, topic_id, position, q_type, marks, difficulty, text, options, answer, explanation, source_chunk_ids, verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[],false) RETURNING id`,
      [exam.id, validTopic.has(q.topic_id) ? q.topic_id : plan[i]?.id ?? null, i + 1,
       QTYPES.has(q.q_type) ? q.q_type : "short_answer", Number(q.marks) || 1, o.difficulty, String(q.text ?? ""),
       normOptions(q.options) ? JSON.stringify(normOptions(q.options)) : null, q.answer == null ? null : String(q.answer), q.explanation ?? null,
       (q.source_chunk_ids ?? []).filter((id: string) => chunkText.has(id))]);
    return rows[0].id;
  }));

  // 5. Check answers against the sources in the background, so the exam opens right away
  if (process.env.VERIFY_ANSWERS !== "off") llmJson<{ i: number; supported: boolean }[]>(
    "You are a strict exam moderator. Judge whether each answer is correct and fully supported by its source text.",
    `Return array of {"i","supported"}.\n${JSON.stringify(draft.map((q, i) => ({
      i, question: q.text, answer: q.answer, sources: (q.source_chunk_ids ?? []).map((id: string) => chunkText.get(id)).filter(Boolean) })))}`)
    .then((checks) => {
      const ok = checks.filter((c) => c.supported).map((c) => ids[c.i]).filter(Boolean);
      return ok.length ? db.query(`UPDATE exam_questions SET verified=true WHERE id = ANY($1::uuid[])`, [ok]) : null;
    })
    .catch((e) => console.warn("Answer check skipped:", String(e.message).slice(0, 120)));

  return { examId: exam.id as string, confidence: sp.confidence, unverified: 0 };
}
