import { assertCourseOwner, assertLecturerOwner, db, embed, llmJson, normOptions } from "./lib.js";
import { bankerTopics, buildExam, topChunks } from "../engine.mjs";

type Diff = "easy" | "medium" | "hard";
const DIFF: Record<Diff, string> = {
  easy: "mostly recall/definition questions; single step; plain wording",
  medium: "application questions needing 2-3 steps",
  hard: "analysis, multi-part or calculation questions; higher marks; probe topics students find tricky",
};
const QTYPES = new Set(["mcq", "short_answer", "theory", "calculation"]);
const topicVec = new Map<string, number[]>(); // cached topic-title embeddings (cleared on restart)

export async function generateExam(o: { userId: string; courseId: string; lecturerId: string | null; difficulty: Diff; count?: number; focus?: string[]; lowCredit?: boolean }) {
  await assertCourseOwner(o.courseId, o.userId);
  if (o.lecturerId) await assertLecturerOwner(o.lecturerId, o.userId);
  const { rows: [sp] } = await db.query(
    `SELECT * FROM style_profiles WHERE course_id=$1 AND lecturer_id IS NOT DISTINCT FROM $2::uuid ORDER BY version DESC LIMIT 1`,
    [o.courseId, o.lecturerId]);
  if (!sp) throw new Error("Upload at least one past question paper first.");
  const { rows: topics } = await db.query(`SELECT id, title, weight FROM ccmas_topics WHERE course_id=$1`, [o.courseId]);
  if (!topics.length) throw new Error("No CCMAS topics for this course yet.");

  // 1. Use the lecturer's question mix and past-paper bank to plan question slots.
  const n = Math.min(Math.max(o.count ?? 10, 1), o.lowCredit ? 5 : 30);
  const { rows: bank } = await db.query(
    `SELECT q.id, q.topic_id, q.q_type, q.cognitive, q.text, d.year
     FROM pq_questions q JOIN documents d ON d.id=q.document_id
     WHERE d.user_id=$1 AND q.course_id=$2 AND d.status='ready'
       AND ($3::uuid IS NULL OR q.lecturer_id=$3::uuid)`,
    [o.userId, o.courseId, o.lecturerId]);
  const mixRows = Array.isArray(sp.profile?.typeMix) ? sp.profile.typeMix : [];
  const typeMix = Object.fromEntries(mixRows
    .filter((r: any) => QTYPES.has(r.q_type))
    .map((r: any) => [r.q_type, Number(r.n) || 0]));
  const topicMap = new Map(topics.map((t: any) => [t.id, t]));
  const allowedTopics = o.focus?.length ? topics.filter((t: any) => o.focus!.includes(t.id)) : topics;
  const rankedTopics = new Map(bankerTopics(bank).map((t) => [t.topic_id, t.share]));
  const topicWeights = Object.fromEntries(allowedTopics.map((t: any) => [
    t.id, (Number(t.weight) || 1) * (1 + (rankedTopics.get(t.id) ?? 0)),
  ]));
  const selection = buildExam({
    pool: o.focus?.length ? bank.filter((q: any) => o.focus!.includes(q.topic_id)) : bank,
    typeMix,
    difficulty: o.difficulty,
    count: n,
    topicWeights,
    focus: o.focus,
  });
  const plan = [
    ...selection.picked.map((q) => {
      const topic = topicMap.get(q.topic_id) ?? topics[0];
      return { topic, q_type: q.q_type, cognitive: q.cognitive, styleExample: q.text };
    }),
    ...selection.gaps.map((gap) => ({
      topic: topicMap.get(gap.topic_id) ?? topics[0],
      q_type: gap.q_type,
      cognitive: null,
      styleExample: null,
    })),
  ];
  const uniq = [...new Map(plan.map((t) => [t.topic.id, t.topic])).values()];

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
    const compatible = all.filter((c) => Array.isArray(c.embedding) && c.embedding.length === v.length);
    context[t.id] = topChunks(v, compatible, { k: 3, minSim: -1 })
      .map(({ id, content }) => ({ id, content }));
  }

  // 3. Write the questions in parallel batches (at most 3 at once)
  const system = `You write university exam questions that mimic one lecturer's style.
STYLE PROFILE: ${JSON.stringify(sp.profile)}
DIFFICULTY (${o.difficulty}): ${DIFF[o.difficulty]}
Use only facts present in the provided source chunks. Follow the requested question type and cognitive level. Past-paper examples are style references only: do not copy their question or use them as factual sources. For mcq include "options" (4) and put the correct option letter in "answer". Keep explanations to one or two sentences.`;
  const size = Math.max(5, Math.ceil(n / 3));
  const jobs: Promise<any>[] = [];
  for (let s = 0; s < n; s += size) {
    const slice = plan.slice(s, s + size), ctx: Record<string, unknown> = {};
    slice.forEach((t) => (ctx[t.topic.id] = context[t.topic.id]));
    jobs.push(llmJson<any>(system,
      `Write ${slice.length} questions, one per plan entry, in order.
PLAN: ${JSON.stringify(slice.map((t, j) => ({
        i: s + j,
        topic_id: t.topic.id,
        topic: t.topic.title,
        q_type: t.q_type,
        cognitive: t.cognitive,
        style_example: t.styleExample,
      })))}
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
      [exam.id, plan[i]?.topic.id ?? (validTopic.has(q.topic_id) ? q.topic_id : null), i + 1,
       QTYPES.has(plan[i]?.q_type) ? plan[i].q_type : QTYPES.has(q.q_type) ? q.q_type : "short_answer",
       Number(q.marks) || 1, o.difficulty, String(q.text ?? ""),
       normOptions(q.options) ? JSON.stringify(normOptions(q.options)) : null, q.answer == null ? null : String(q.answer), q.explanation ?? null,
       (q.source_chunk_ids ?? []).filter((id: string) => chunkText.has(id))]);
    return rows[0].id;
  }));

  // 5. Check answers against the sources in the background, so the exam opens right away
  if (!o.lowCredit && process.env.VERIFY_ANSWERS !== "off") llmJson<{ i: number; supported: boolean }[]>(
    "You are a strict exam moderator. Judge whether each answer is correct and fully supported by its source text.",
    `Return array of {"i","supported"}.\n${JSON.stringify(draft.map((q, i) => ({
      i, question: q.text, answer: q.answer, sources: (q.source_chunk_ids ?? []).map((id: string) => chunkText.get(id)).filter(Boolean) })))}`)
    .then((checks) => {
      const ok = checks.filter((c) => c.supported).map((c) => ids[c.i]).filter(Boolean);
      return ok.length ? db.query(`UPDATE exam_questions SET verified=true WHERE id = ANY($1::uuid[])`, [ok]) : null;
    })
    .catch((e) => console.warn("Answer check skipped:", String(e.message).slice(0, 120)));

  return {
    examId: exam.id as string,
    confidence: sp.confidence,
    unverified: o.lowCredit ? draft.length : 0,
    lowCredit: Boolean(o.lowCredit),
  };
}
