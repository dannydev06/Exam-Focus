import { db, llmJson, normOptions } from "./lib.js";

type Ans = { examQuestionId: string; response?: string; timeSpent?: number };
const letterOf = (s: string) => /^\(?([A-Da-d])(?:[).:]|$)/.exec(s.trim())?.[1]?.toUpperCase() ?? null;

function correctLetter(q: any): string | null {
  const a = (q.answer ?? "").trim();
  if (!a) return null;
  if (letterOf(a)) return letterOf(a);
  const opts: string[] = normOptions(q.options) ?? [];
  const i = opts.findIndex((o) => { const x = o.toLowerCase(), y = a.toLowerCase(); return x.includes(y) || y.includes(x); });
  return i >= 0 ? String.fromCharCode(65 + i) : null;
}

export async function submitAttempt(userId: string, examId: string, answers: Ans[]) {
  const { rows: qs } = await db.query(`SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY position`, [examId]);
  if (!qs.length) throw new Error("Exam not found.");
  const given = new Map(answers.map((a) => [a.examQuestionId, a]));
  const res = new Map<string, { score: number; feedback: string }>();
  const open: any[] = [];

  for (const q of qs) {
    const r = (given.get(q.id)?.response ?? "").trim();
    const max = Number(q.marks);
    if (!r) res.set(q.id, { score: 0, feedback: "No answer given." });
    else if (q.q_type === "mcq") {
      const ok = letterOf(r) !== null && letterOf(r) === correctLetter(q);
      res.set(q.id, { score: ok ? max : 0, feedback: ok ? "Correct." : "Incorrect." });
    } else open.push({ id: q.id, question: q.text, model_answer: q.answer, max_marks: max, student_answer: r });
  }

  if (open.length) {
    const graded = await llmJson<{ id: string; score: number; feedback: string }[]>(
      `You are a fair university examiner. Mark each student answer against the model answer. Give partial credit.
score must be between 0 and max_marks. feedback: one or two sentences on what was good or missing.
Return array of {"id","score","feedback"}.`,
      JSON.stringify(open));
    for (const g of graded) {
      const o = open.find((x) => x.id === g.id);
      if (o) res.set(g.id, { score: Math.max(0, Math.min(o.max_marks, Number(g.score) || 0)), feedback: g.feedback });
    }
    for (const o of open) if (!res.has(o.id)) res.set(o.id, { score: 0, feedback: "Could not be marked automatically." });
  }

  const total = qs.reduce((s, q) => s + Number(q.marks), 0);
  const score = [...res.values()].reduce((s, r) => s + r.score, 0);
  const { rows: [att] } = await db.query(
    `INSERT INTO attempts (exam_id, user_id, submitted_at, score) VALUES ($1,$2,now(),$3) RETURNING id`, [examId, userId, score]);
  for (const q of qs) {
    const a = given.get(q.id);
    await db.query(
      `INSERT INTO attempt_answers (attempt_id, exam_question_id, response, score, time_spent_seconds, feedback) VALUES ($1,$2,$3,$4,$5,$6)`,
      [att.id, q.id, a?.response ?? null, res.get(q.id)!.score, a?.timeSpent ?? null, res.get(q.id)!.feedback]);
  }
  return {
    attemptId: att.id, score, total,
    results: qs.map((q) => ({
      position: q.position, max: Number(q.marks), response: given.get(q.id)?.response ?? "",
      answer: q.answer, explanation: q.explanation, ...res.get(q.id)!,
    })),
  };
}
