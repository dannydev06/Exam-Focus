import express from "express";
import multer from "multer";
import { aiUsage, assertCourseOwner, assertLecturerOwner, db, normOptions, runWithAIUser } from "./lib.js";
import { ingest } from "./ingest.js";
import { buildStyleProfile } from "./style.js";
import { generateExam } from "./generate.js";
import { submitAttempt } from "./mark.js";
import { dashRoutes } from "./dash.js";
import { setupRoutes } from "./setup.js";
import { ensureReadingSchema, readingRoutes } from "./reading.js";
import { authenticate, authRoutes, ensureTenantSchema, requireSameOrigin } from "./auth.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const uid = (req: any) => req.userId as string;
const h = (fn: (req: any, res: any) => Promise<any>) => (req: any, res: any) =>
  runWithAIUser(req.userId, () => fn(req, res).catch((e) => {
    console.error(e);
    res.status(e.statusCode ?? 500).json({ error: e.message });
  }));

await ensureTenantSchema();
await ensureReadingSchema();
app.use(requireSameOrigin);
authRoutes(app, h);
app.get("/auth/me", authenticate, h(async (req, res) => {
  const { rows: [user] } = await db.query(`SELECT id, email, name FROM users WHERE id=$1`, [uid(req)]);
  if (!user) return res.status(401).json({ error: "Sign in to continue." });
  res.json(user);
}));
app.use(authenticate);
app.get("/ai-usage", h(async (req, res) => {
  res.json(await aiUsage(uid(req)));
}));

// Upload a PQ / note / textbook / CCMAS PDF
app.post("/documents", upload.array("file", 30), h(async (req, res) => {
  const { courseId, kind, lecturerId, year } = req.body;
  if (!req.files?.length) throw new Error("Choose a file first.");
  await assertCourseOwner(courseId, uid(req));
  if (lecturerId) await assertLecturerOwner(lecturerId, uid(req));
  const documentId = await ingest({
    userId: uid(req), courseId, kind, lecturerId: lecturerId || undefined, year: year ? Number(year) : undefined,
    files: (req.files as any[]).map((f) => ({ buffer: f.buffer, mimetype: f.mimetype, name: f.originalname })), // TODO: persist to S3/R2
  });
  if (kind === "past_question") await buildStyleProfile(courseId, lecturerId || null);
  res.json({ documentId });
}));

// Generate a mock exam
app.post("/exams", h(async (req, res) => {
  const { courseId, lecturerId, difficulty, count, focus, lowCredit } = req.body;
  res.json(await generateExam({ userId: uid(req), courseId, lecturerId: lecturerId ?? null, difficulty, count, focus, lowCredit: lowCredit === true }));
}));

// Fetch an exam (answers withheld until you build the submit flow)
app.get("/exams/:id", h(async (req, res) => {
  const { rows: [exam] } = await db.query(
    `SELECT e.duration_minutes FROM exams e JOIN courses c ON c.id=e.course_id
     WHERE e.id=$1 AND c.owner_id=$2`, [req.params.id, uid(req)]);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  const { rows } = await db.query(
    `SELECT id, position, section, q_type, marks, text, options FROM exam_questions WHERE exam_id=$1 ORDER BY position`, [req.params.id]);
  res.json({ duration_minutes: exam.duration_minutes, questions: rows.map((r: any) => ({ ...r, options: normOptions(r.options) })) });
}));

// Topic heat map: how often each CCMAS topic shows up in past questions
app.get("/courses/:id/heatmap", h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.title, count(q.id)::int AS questions FROM ccmas_topics t
     LEFT JOIN pq_questions q ON q.topic_id=t.id JOIN courses c ON c.id=t.course_id
     WHERE t.course_id=$1 AND c.owner_id=$2 GROUP BY t.id ORDER BY questions DESC`, [req.params.id, uid(req)]);
  res.json(rows);
}));

// Submit answers: MCQs marked directly, written answers marked by the LLM against the model answer
app.post("/exams/:id/submit", h(async (req, res) => {
  res.json(await submitAttempt(uid(req), req.params.id, req.body.answers ?? []));
}));

app.get("/courses", h(async (_req, res) => {
  res.json((await db.query(`SELECT id, code, title FROM courses WHERE owner_id=$1 ORDER BY code`, [uid(_req)])).rows);
}));
app.get("/lecturers", h(async (_req, res) => {
  res.json((await db.query(`SELECT id, name FROM lecturers WHERE owner_id=$1 ORDER BY name`, [uid(_req)])).rows);
}));

dashRoutes(app, h, uid);
readingRoutes(app, h, uid);
setupRoutes(app, h, uid, upload);

app.listen(Number(process.env.PORT) || 3000, () => console.log(`PQ prep API on :${Number(process.env.PORT) || 3000}`));
