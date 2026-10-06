import pdf from "pdf-parse/lib/pdf-parse.js";
import { db, llmJson } from "./lib.js";
import { buildStyleProfile } from "./style.js";
import { ocr } from "./ocr.js";

export function setupRoutes(app: any, h: any, uid: (r: any) => string, upload: any) {
  const rows = async (sql: string, p: any[]) => (await db.query(sql, p)).rows;

  app.post("/courses", h(async (req: any, res: any) => {
    const { code, title, department, level } = req.body;
    if (!code?.trim() || !title?.trim()) throw new Error("Course code and title are required.");
    try {
      const [c] = await rows(`INSERT INTO courses (code, title, department, level) VALUES ($1,$2,$3,$4) RETURNING id`,
        [code.trim(), title.trim(), department || null, level ? Number(level) : null]);
      res.json(c);
    } catch (e: any) { throw new Error(e.code === "23505" ? "That course code already exists." : e.message); }
  }));

  app.post("/lecturers", h(async (req: any, res: any) => {
    const name = req.body.name?.trim();
    if (!name) throw new Error("Lecturer name is required.");
    res.json((await rows(`INSERT INTO lecturers (name) VALUES ($1) RETURNING id`, [name]))[0]);
  }));

  app.get("/courses/:id/topics", h(async (req: any, res: any) =>
    res.json(await rows(`SELECT id, title FROM ccmas_topics WHERE course_id=$1 ORDER BY position, title`, [req.params.id]))));

  // Suggest topics from pasted CCMAS text or an uploaded CCMAS page. Nothing is saved until the user confirms.
  app.post("/courses/:id/topics/extract", upload.single("file"), h(async (req: any, res: any) => {
    let text: string = req.body.text;
    if (req.file) { // text PDFs directly, scans and photos through OCR
      text = req.file.mimetype.includes("pdf") ? (await pdf(req.file.buffer)).text : "";
      if (text.trim().length < 100) text = await ocr(req.file.buffer, req.file.mimetype);
    }
    if (!text || text.trim().length < 20) throw new Error("Paste the CCMAS course content or upload its PDF page.");
    const out = await llmJson<any[]>(
      "You read the course description from a Nigerian university CCMAS document and list its teachable topics.",
      `List the main topics from this course content as a JSON array of short topic names (2-6 words each, no numbering, no duplicates, 6-20 items).\n\n${text.slice(0, 20000)}`);
    res.json({ topics: out.map((t) => String(t?.title ?? t?.name ?? t).trim()).filter(Boolean).slice(0, 40) });
  }));

  app.post("/courses/:id/topics", h(async (req: any, res: any) => {
    const list = [...new Set<string>((req.body.topics ?? []).map((t: any) => String(t).trim()).filter(Boolean))];
    for (const t of list) await db.query(
      `INSERT INTO ccmas_topics (course_id, title) SELECT $1::uuid, $2::text
       WHERE NOT EXISTS (SELECT 1 FROM ccmas_topics WHERE course_id=$1::uuid AND lower(title)=lower($2::text))`, [req.params.id, t]);
    res.json({ saved: list.length });
  }));

  app.delete("/sources/:id", h(async (req: any, res: any) => {
    const [d] = await rows(`DELETE FROM documents WHERE id=$1 AND user_id=$2 RETURNING course_id, lecturer_id, kind`, [req.params.id, uid(req)]);
    if (!d) throw new Error("Source not found.");
    if (d.kind === "past_question") await buildStyleProfile(d.course_id, d.lecturer_id).catch(() => null);
    res.json({ ok: true });
  }));

  // The user's three lowest-scoring topics, for weak-topic practice
  app.get("/weak-topics", h(async (req: any, res: any) => res.json(await rows(
    `SELECT t.id, t.title, round(100*sum(aa.score)/greatest(sum(eq.marks),1))::int pct
     FROM attempt_answers aa JOIN attempts a ON a.id=aa.attempt_id JOIN exam_questions eq ON eq.id=aa.exam_question_id
     JOIN exams e ON e.id=a.exam_id JOIN ccmas_topics t ON t.id=eq.topic_id
     WHERE a.user_id=$1 AND e.course_id=$2 GROUP BY t.id, t.title ORDER BY pct ASC LIMIT 3`, [uid(req), req.query.courseId]))));
}
