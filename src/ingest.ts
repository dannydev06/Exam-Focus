import pdf from "pdf-parse/lib/pdf-parse.js"; // direct path avoids pdf-parse's debug-mode bug in ESM
import { db, embed, llmJson } from "./lib.js";
import { ocr } from "./ocr.js";

type Kind = "past_question" | "note" | "textbook" | "ccmas";
type Opts = { userId: string; courseId: string; kind: Kind; lecturerId?: string; year?: number; files: { buffer: Buffer; mimetype: string; name: string }[] };

function chunk(text: string, size = 1200, overlap = 150) {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) out.push(text.slice(i, i + size));
  return out;
}

export async function ingest(o: Opts): Promise<string> {
  const storageKey = o.files.length > 1 ? `${o.files[0].name} (+${o.files.length - 1} more)` : o.files[0].name;
  const { rows: [doc] } = await db.query(
    `INSERT INTO documents (user_id, course_id, lecturer_id, kind, year, storage_key, status)
     VALUES ($1,$2,$3,$4,$5,$6,'parsing') RETURNING id`,
    [o.userId, o.courseId, o.lecturerId ?? null, o.kind, o.year ?? null, storageKey]);
  try {
    // Text PDFs are read directly; scanned PDFs and photos go through local OCR
    const parts: string[] = [];
    let scanned = false;
    for (const f of o.files) {
      let t = f.mimetype.includes("pdf") ? (await pdf(f.buffer)).text : "";
      if (t.trim().length < 100) { t = await ocr(f.buffer, f.mimetype); scanned = true; }
      parts.push(t);
    }
    const text = parts.join("\n\n");
    if (text.trim().length < 50) throw new Error("Could not read any text from this file. Try a clearer scan or photo.");
    if (scanned) await db.query(`UPDATE documents SET needs_ocr=true WHERE id=$1`, [doc.id]); // flag now means "was read with OCR"
    if (o.kind === "past_question") await extractQuestions(doc.id, o, text);
    else await storeChunks(doc.id, text);
    await db.query(`UPDATE documents SET status='ready' WHERE id=$1`, [doc.id]);
  } catch (e) {
    await db.query(`UPDATE documents SET status='failed' WHERE id=$1`, [doc.id]);
    throw e;
  }
  return doc.id;
}

async function storeChunks(documentId: string, text: string) {
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i += 64) {
    const batch = parts.slice(i, i + 64);
    const vecs = await embed(batch);
    for (let j = 0; j < batch.length; j++)
      await db.query(`INSERT INTO chunks (document_id, content, embedding) VALUES ($1,$2,$3::jsonb)`, [documentId, batch[j], vecs[j]]);
  }
}

async function extractQuestions(documentId: string, o: Opts, text: string) {
  const { rows: topics } = await db.query(`SELECT id, title FROM ccmas_topics WHERE course_id=$1`, [o.courseId]);
  const qs = await llmJson<any[]>(
    "You parse university past exam papers into structured questions.",
    `CCMAS topics: ${JSON.stringify(topics.map((t) => t.title))}
Return a JSON array. Each item: {"section","position","q_type":"mcq|short_answer|theory|calculation","marks","cognitive":"recall|application|analysis","command_verb","topic":<exact title from the topics list or null>,"text"}.

PAPER:
${text.slice(0, 60000)}`);
  // PQ questions are not searched by similarity, so skip embedding them (saves API quota)
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    await db.query(
      `INSERT INTO pq_questions (document_id, course_id, lecturer_id, topic_id, section, position, q_type, marks, cognitive, command_verb, text, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [documentId, o.courseId, o.lecturerId ?? null, topics.find((t) => t.title === q.topic)?.id ?? null,
       q.section, q.position, ["mcq","short_answer","theory","calculation"].includes(q.q_type) ? q.q_type : "short_answer", Number(q.marks) || null,
       ["recall","application","analysis"].includes(q.cognitive) ? q.cognitive : null, String(q.command_verb ?? "").toLowerCase() || null, q.text, null]);
  }
}
