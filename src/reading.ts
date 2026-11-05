import { assertCourseOwner, db } from "./lib.js";
import { bankerTopics, examTerms, extractiveSummary, howAsked, readingQueue, readiness, scoreSentences } from "../engine.mjs";

type ReadingChunk = { id: string; content: string; created_at: Date | string };

async function loadCourse(courseId: string, userId: string) {
  await assertCourseOwner(courseId, userId);
  const [topics, questions, chunks, progress, mastery, papers] = await Promise.all([
    db.query(`SELECT id, title, weight FROM ccmas_topics WHERE course_id=$1 ORDER BY position, title`, [courseId]),
    db.query(
      `SELECT q.id, q.topic_id, q.document_id, q.command_verb, q.marks, q.q_type, q.text, d.year
       FROM pq_questions q JOIN documents d ON d.id=q.document_id
       WHERE d.user_id=$1 AND q.course_id=$2 AND d.status='ready'`, [userId, courseId]),
    db.query(
      `SELECT c.id, c.content, d.created_at FROM chunks c JOIN documents d ON d.id=c.document_id
       WHERE d.user_id=$1 AND d.course_id=$2 AND d.status='ready' AND d.kind IN ('note','textbook','ccmas')
       ORDER BY d.created_at, c.id`, [userId, courseId]),
    db.query(`SELECT chunk_id, seconds FROM reading_progress WHERE user_id=$1`, [userId]),
    db.query(
      `SELECT t.id AS topic_id, t.title, t.weight,
              coalesce(sum(aa.score),0)::float AS earned,
              coalesce(sum(CASE WHEN aa.id IS NOT NULL THEN eq.marks ELSE 0 END),0)::float AS possible,
              max(a.submitted_at) AS last_seen
       FROM ccmas_topics t
       LEFT JOIN exam_questions eq ON eq.topic_id=t.id
       LEFT JOIN attempts a ON a.exam_id=eq.exam_id AND a.user_id=$2 AND a.submitted_at IS NOT NULL
       LEFT JOIN attempt_answers aa ON aa.attempt_id=a.id AND aa.exam_question_id=eq.id
       WHERE t.course_id=$1 GROUP BY t.id ORDER BY t.position, t.title`, [courseId, userId]),
    db.query(
      `SELECT count(DISTINCT d.id)::int AS count FROM documents d
       WHERE d.user_id=$1 AND d.course_id=$2 AND d.kind='past_question' AND d.status='ready'`, [userId, courseId]),
  ]);
  const mastered = readiness(mastery.rows.map((t: any) => ({
    ...t,
    weight: t.weight == null ? 1 : Number(t.weight),
    earned: Number(t.earned) || 0,
    possible: Number(t.possible) || 0,
  }))).topics;
  const seen = new Set(progress.rows.filter((r: any) => Number(r.seconds) >= 30).map((r: any) => r.chunk_id));
  const qByTopic = new Map<string, any[]>();
  for (const q of questions.rows) if (q.topic_id) qByTopic.set(q.topic_id, [...(qByTopic.get(q.topic_id) ?? []), q]);
  const bank = new Map(bankerTopics(questions.rows).map((t: any) => [t.topic_id, t]));
  const masteryByTopic = new Map(mastered.map((t: any) => [t.topic_id, t]));

  const chunksByTopic = (topicId: string) => {
    const qs = qByTopic.get(topicId) ?? [];
    const terms = examTerms(qs);
    const ranked = (chunks.rows as ReadingChunk[]).map((chunk) => {
      const sentences = scoreSentences(chunk.content, { terms });
      return { ...chunk, sentences, relevance: sentences.reduce((sum, sentence) => sum + sentence.score, 0) };
    });
    const relevant = ranked.some((chunk) => chunk.relevance > 0)
      ? ranked.filter((chunk) => chunk.relevance > 0).sort((a, b) => b.relevance - a.relevance)
      : ranked;
    return { terms, chunks: relevant.slice(0, 40), qs };
  };
  const queue = readingQueue(topics.rows.map((topic: any) => {
    const group = chunksByTopic(topic.id).chunks;
    const done = group.filter((c) => seen.has(c.id)).length;
    const b: any = bank.get(topic.id);
    const m: any = masteryByTopic.get(topic.id);
    return {
      topic_id: topic.id, title: topic.title, weight: Number(topic.weight) || 1,
      share: b?.share ?? 0, tier: b?.tier ?? "low", mastery: m?.mastery ?? 0,
      readFraction: group.length ? done / group.length : 0,
      readChunks: done, chunkCount: group.length,
    };
  }));
  return {
    topics: queue,
    chunksByTopic,
    seen,
    paperCount: papers.rows[0]?.count ?? 0,
  };
}

export async function ensureReadingSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS study_days (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day date NOT NULL,
    minutes int NOT NULL DEFAULT 0,
    cards_reviewed int NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS reading_progress (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    first_read_at timestamptz NOT NULL DEFAULT now(),
    last_read_at timestamptz NOT NULL DEFAULT now(),
    seconds int NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, chunk_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS user_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    quote text,
    note text,
    created_at timestamptz DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS user_notes_chunk ON user_notes (user_id, chunk_id)`);
}

export function readingRoutes(app: any, h: any, uid: (req: any) => string) {
  app.get("/reading", h(async (req: any, res: any) => {
    const data = await loadCourse(String(req.query.courseId ?? ""), uid(req));
    res.json({
      topics: data.topics,
      sources: data.topics.reduce((n: number, t: any) => n + t.chunkCount, 0),
    });
  }));

  app.get("/reading/topics/:topicId", h(async (req: any, res: any) => {
    const courseId = String(req.query.courseId ?? ""), data = await loadCourse(courseId, uid(req));
    const topic = data.topics.find((t: any) => t.topic_id === req.params.topicId);
    if (!topic) return res.status(404).json({ error: "Topic not found." });
    const { terms, chunks, qs } = data.chunksByTopic(req.params.topicId);
    const ids = chunks.map((c: any) => c.id);
    const notes = ids.length ? await db.query(
      `SELECT id, chunk_id, quote, note, created_at FROM user_notes
       WHERE user_id=$1 AND chunk_id=ANY($2::uuid[]) ORDER BY created_at DESC`, [uid(req), ids]) : { rows: [] };
    res.json({
      topic,
      howAsked: howAsked(qs, { papers: data.paperCount }),
      chunks: chunks.map((chunk: any) => ({
        id: chunk.id,
        sentences: chunk.sentences.map((s: any) => ({ text: s.text, level: s.level, kind: s.kind })),
        summary: extractiveSummary(chunk.content, { terms }),
        read: data.seen.has(chunk.id),
      })),
      notes: notes.rows,
    });
  }));

  app.post("/reading/progress", h(async (req: any, res: any) => {
    const userId = uid(req), chunkId = String(req.body.chunkId ?? ""), seconds = Number(req.body.seconds);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300)
      return res.status(400).json({ error: "Reading time must be between 1 and 300 seconds." });
    const { rows: [chunk] } = await db.query(
      `SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document_id
       JOIN courses co ON co.id=d.course_id
       WHERE c.id=$1 AND d.user_id=$2 AND co.owner_id=$2 AND d.status='ready' AND d.kind IN ('note','textbook','ccmas')`,
      [chunkId, userId]);
    if (!chunk) return res.status(404).json({ error: "Reading passage not found." });
    const { rows: [saved] } = await db.query(
      `INSERT INTO reading_progress (user_id, chunk_id, seconds)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, chunk_id) DO UPDATE
       SET seconds=reading_progress.seconds+EXCLUDED.seconds, last_read_at=now()
       RETURNING seconds`, [userId, chunkId, seconds]);
    const minutes = Math.floor(saved.seconds / 60) - Math.floor((saved.seconds - seconds) / 60);
    await db.query(
      `INSERT INTO study_days (user_id, day, minutes) VALUES ($1,(now() AT TIME ZONE 'UTC')::date,$2)
       ON CONFLICT (user_id, day) DO UPDATE SET minutes=study_days.minutes+EXCLUDED.minutes`,
      [userId, minutes]);
    res.json({ seconds: saved.seconds });
  }));

  app.post("/reading/notes", h(async (req: any, res: any) => {
    const userId = uid(req), chunkId = String(req.body.chunkId ?? "");
    const quote = String(req.body.quote ?? "").trim(), note = String(req.body.note ?? "").trim();
    if ((!quote && !note) || quote.length > 2000 || note.length > 2000)
      return res.status(400).json({ error: "Add a note or highlighted passage (up to 2,000 characters each)." });
    const { rows: [chunk] } = await db.query(
      `SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document_id
       JOIN courses co ON co.id=d.course_id
       WHERE c.id=$1 AND d.user_id=$2 AND co.owner_id=$2 AND d.status='ready' AND d.kind IN ('note','textbook','ccmas')`,
      [chunkId, userId]);
    if (!chunk) return res.status(404).json({ error: "Reading passage not found." });
    const { rows: [saved] } = await db.query(
      `INSERT INTO user_notes (user_id, chunk_id, quote, note) VALUES ($1,$2,$3,$4)
       RETURNING id, chunk_id, quote, note, created_at`, [userId, chunkId, quote || null, note || null]);
    res.status(201).json(saved);
  }));

  app.delete("/reading/notes/:id", h(async (req: any, res: any) => {
    const { rowCount } = await db.query(
      `DELETE FROM user_notes n USING chunks c, documents d, courses co
       WHERE n.id=$1 AND n.user_id=$2 AND c.id=n.chunk_id AND d.id=c.document_id
         AND co.id=d.course_id AND co.owner_id=$2`, [req.params.id, uid(req)]);
    if (!rowCount) return res.status(404).json({ error: "Note not found." });
    res.json({ ok: true });
  }));
}
