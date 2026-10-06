import express from "express";
import multer from "multer";
import { db, normOptions } from "./lib.js";
import { ingest } from "./ingest.js";
import { buildStyleProfile } from "./style.js";
import { generateExam } from "./generate.js";
import { submitAttempt } from "./mark.js";
import { dashRoutes } from "./dash.js";
import { setupRoutes } from "./setup.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// TODO: replace with real auth. For now the caller passes x-user-id.
const uid = (req: any) => req.header("x-user-id") as string;
const h = (fn: (req: any, res: any) => Promise<any>) => (req: any, res: any) =>
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

// Upload a PQ / note / textbook / CCMAS PDF
app.post("/documents", upload.array("file", 30), h(async (req, res) => {
  const { courseId, kind, lecturerId, year } = req.body;
  if (!req.files?.length) throw new Error("Choose a file first.");
  const documentId = await ingest({
    userId: uid(req), courseId, kind, lecturerId: lecturerId || undefined, year: year ? Number(year) : undefined,
    files: (req.files as any[]).map((f) => ({ buffer: f.buffer, mimetype: f.mimetype, name: f.originalname })), // TODO: persist to S3/R2
  });
  if (kind === "past_question") await buildStyleProfile(courseId, lecturerId || null);
  res.json({ documentId });
}));

// Generate a mock exam
app.post("/exams", h(async (req, res) => {
  const { courseId, lecturerId, difficulty, count, focus } = req.body;
  res.json(await generateExam({ userId: uid(req), courseId, lecturerId: lecturerId ?? null, difficulty, count, focus }));
}));

// Fetch an exam (answers withheld until you build the submit flow)
app.get("/exams/:id", h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, position, section, q_type, marks, text, options FROM exam_questions WHERE exam_id=$1 ORDER BY position`, [req.params.id]);
  const [e] = (await db.query(`SELECT duration_minutes FROM exams WHERE id=$1`, [req.params.id])).rows;
  res.json({ duration_minutes: e?.duration_minutes ?? null, questions: rows.map((r: any) => ({ ...r, options: normOptions(r.options) })) });
}));

// Topic heat map: how often each CCMAS topic shows up in past questions
app.get("/courses/:id/heatmap", h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.title, count(q.id)::int AS questions FROM ccmas_topics t
     LEFT JOIN pq_questions q ON q.topic_id=t.id WHERE t.course_id=$1 GROUP BY t.id ORDER BY questions DESC`, [req.params.id]);
  res.json(rows);
}));

// Submit answers: MCQs marked directly, written answers marked by the LLM against the model answer
app.post("/exams/:id/submit", h(async (req, res) => {
  res.json(await submitAttempt(uid(req), req.params.id, req.body.answers ?? []));
}));

app.get("/courses", h(async (_req, res) => {
  res.json((await db.query(`SELECT id, code, title FROM courses ORDER BY code`)).rows);
}));
app.get("/lecturers", h(async (_req, res) => {
  res.json((await db.query(`SELECT id, name FROM lecturers ORDER BY name`)).rows);
}));

dashRoutes(app, h, uid);
setupRoutes(app, h, uid, upload);

app.listen(3000, () => console.log("PQ prep API on :3000"));
