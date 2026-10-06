import { db } from "./lib.js";

export function dashRoutes(app: any, h: any, uid: (r: any) => string) {
  const rows = async (sql: string, p: any[]) => (await db.query(sql, p)).rows;
  const attempts = (u: string, courseId: string) => rows(
    `SELECT a.id, e.difficulty, a.submitted_at, round(100*a.score/greatest(e.total_marks,1))::int pct,
            (SELECT count(*)::int FROM exam_questions WHERE exam_id=e.id) n
     FROM attempts a JOIN exams e ON e.id=a.exam_id
     WHERE a.user_id=$1 AND e.course_id=$2 AND a.submitted_at IS NOT NULL ORDER BY a.submitted_at DESC LIMIT 50`, [u, courseId]);

  // Readiness = average % of the last 5 attempts. Topic % = share of past papers containing that topic.
  app.get("/dashboard", h(async (req: any, res: any) => {
    const { courseId } = req.query, lec = req.query.lecturerId || null, u = uid(req);
    const [p] = await rows(`SELECT count(distinct document_id)::int n FROM pq_questions WHERE course_id=$1 AND ($2::uuid IS NULL OR lecturer_id=$2::uuid)`, [courseId, lec]);
    const topics = await rows(
      `SELECT t.title, round(100.0*count(distinct q.document_id)/greatest(1,$3::int))::int pct
       FROM ccmas_topics t JOIN pq_questions q ON q.topic_id=t.id AND ($2::uuid IS NULL OR q.lecturer_id=$2::uuid)
       WHERE t.course_id=$1 GROUP BY t.title ORDER BY pct DESC LIMIT 6`, [courseId, lec, p.n]);
    const recent = await attempts(u, courseId), last5 = recent.slice(0, 5);
    const [src] = await rows(`SELECT count(*)::int n FROM documents WHERE user_id=$1 AND course_id=$2 AND status='ready'`, [u, courseId]);
    const [weak] = await rows(
      `SELECT t.title FROM attempt_answers aa JOIN attempts a ON a.id=aa.attempt_id
       JOIN exam_questions eq ON eq.id=aa.exam_question_id JOIN exams e ON e.id=a.exam_id JOIN ccmas_topics t ON t.id=eq.topic_id
       WHERE a.user_id=$1 AND e.course_id=$2 GROUP BY t.title ORDER BY sum(aa.score)/greatest(sum(eq.marks),1) ASC LIMIT 1`, [u, courseId]);
    res.json({
      readiness: last5.length ? Math.round(last5.reduce((s, r) => s + r.pct, 0) / last5.length) : null,
      topics, recent: recent.slice(0, 3), sources: src.n, weak: weak?.title ?? null,
    });
  }));

  app.get("/attempts", h(async (req: any, res: any) => res.json(await attempts(uid(req), req.query.courseId))));

  app.get("/attempts/:id", h(async (req: any, res: any) => {
    const [a] = await rows(
      `SELECT a.id, a.score::float score, e.total_marks::float total, e.difficulty
       FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.id=$1 AND a.user_id=$2`, [req.params.id, uid(req)]);
    if (!a) return res.status(404).json({ error: "Attempt not found." });
    const results = await rows(
      `SELECT eq.position, eq.text question, eq.marks::float max, aa.response, aa.score::float score, aa.feedback, eq.answer, eq.explanation, eq.verified, t.title topic
       FROM attempt_answers aa JOIN exam_questions eq ON eq.id=aa.exam_question_id LEFT JOIN ccmas_topics t ON t.id=eq.topic_id
       WHERE aa.attempt_id=$1 ORDER BY eq.position`, [a.id]);
    res.json({ ...a, results });
  }));

  app.get("/sources", h(async (req: any, res: any) => res.json(await rows(
    `SELECT d.id, d.kind, d.year, d.status, d.needs_ocr, d.storage_key name, d.created_at, l.name lecturer
     FROM documents d LEFT JOIN lecturers l ON l.id=d.lecturer_id
     WHERE d.user_id=$1 AND d.course_id=$2 ORDER BY d.created_at DESC`, [uid(req), req.query.courseId]))));

  app.get("/pattern", h(async (req: any, res: any) => {
    const [sp] = await rows(
      `SELECT profile, sample_size, confidence::float confidence FROM style_profiles
       WHERE course_id=$1 AND lecturer_id IS NOT DISTINCT FROM $2::uuid ORDER BY version DESC LIMIT 1`,
      [req.query.courseId, req.query.lecturerId || null]);
    res.json(sp ?? null);
  }));
}
