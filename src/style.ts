import { db } from "./lib.js";

// Deterministic lecturer-style profile computed from parsed PQs (no LLM needed).
export async function buildStyleProfile(courseId: string, lecturerId: string | null) {
  const w = `course_id=$1 AND ($2::uuid IS NULL OR lecturer_id=$2::uuid)`;
  const q = async (sql: string) => (await db.query(sql, [courseId, lecturerId])).rows;

  const [papers] = await q(`SELECT count(distinct document_id)::int n, count(*)::int total FROM pq_questions WHERE ${w}`);
  if (!papers.total) throw new Error("No parsed past questions for this course/lecturer yet.");

  const profile = {
    typeMix: await q(`SELECT q_type, count(*)::int n, round(avg(marks),1)::float avg_marks FROM pq_questions WHERE ${w} GROUP BY q_type`),
    cognitiveMix: await q(`SELECT cognitive, count(*)::int n FROM pq_questions WHERE ${w} GROUP BY cognitive`),
    topTopics: await q(`SELECT t.title, count(*)::int n FROM pq_questions p JOIN ccmas_topics t ON t.id=p.topic_id WHERE ${w.replaceAll("course_id", "p.course_id").replaceAll("lecturer_id", "p.lecturer_id")} GROUP BY t.title ORDER BY n DESC LIMIT 10`),
    commonVerbs: await q(`SELECT lower(command_verb) AS command_verb, count(*)::int n FROM pq_questions WHERE ${w} AND command_verb IS NOT NULL GROUP BY lower(command_verb) ORDER BY n DESC LIMIT 10`),
    avgQuestionsPerPaper: Math.round(papers.total / papers.n),
    samples: (await q(`SELECT text FROM pq_questions WHERE ${w} ORDER BY random() LIMIT 5`)).map((r) => r.text),
  };

  // Refine topic weights from how often the lecturer actually tests each topic.
  await db.query(
    `UPDATE ccmas_topics t SET weight = 1 + c.n FROM (
       SELECT topic_id, count(*) n FROM pq_questions WHERE ${w} AND topic_id IS NOT NULL GROUP BY topic_id
     ) c WHERE t.id = c.topic_id`, [courseId, lecturerId]);

  const { rows: [v] } = await db.query(
    `SELECT coalesce(max(version),0)+1 v FROM style_profiles WHERE course_id=$1 AND lecturer_id IS NOT DISTINCT FROM $2::uuid`, [courseId, lecturerId]);
  const { rows: [sp] } = await db.query(
    `INSERT INTO style_profiles (course_id, lecturer_id, profile, sample_size, confidence, version)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [courseId, lecturerId, profile, papers.n, Math.min(1, papers.n / 5), v.v]);
  return sp;
}
