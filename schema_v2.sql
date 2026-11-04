-- Exam Focus v2: additive migration. Run AFTER schema.sql. Safe to re-run.

-- 1. Richer attempt data: confidence, mistake type, who marked it
ALTER TABLE attempt_answers
  ADD COLUMN IF NOT EXISTS confidence text CHECK (confidence IN ('sure','unsure','guess')),
  ADD COLUMN IF NOT EXISTS error_type text CHECK (error_type IN
    ('knowledge_gap','overconfident','careless','incomplete','time_pressure','skipped')),
  ADD COLUMN IF NOT EXISTS marked_by text DEFAULT 'algorithm' CHECK (marked_by IN ('algorithm','ai'));

-- 2. Per-user topic mastery. Updated after every attempt; feeds readiness and weak topics.
--    Marks are recency-decayed in the app (see updateTopicStat in engine.mjs).
CREATE TABLE IF NOT EXISTS topic_stats (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES ccmas_topics(id) ON DELETE CASCADE,
  earned numeric NOT NULL DEFAULT 0,
  possible numeric NOT NULL DEFAULT 0,
  attempts int NOT NULL DEFAULT 0,
  last_seen timestamptz,
  PRIMARY KEY (user_id, topic_id)
);

-- 3. Spaced repetition (SM-2). One card per user per question.
CREATE TABLE IF NOT EXISTS review_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id),
  topic_id uuid REFERENCES ccmas_topics(id),
  source_type text NOT NULL CHECK (source_type IN ('exam_question','pq_question','flashcard')),
  source_id uuid NOT NULL,
  ease numeric NOT NULL DEFAULT 2.5,
  interval_days int NOT NULL DEFAULT 0,
  repetitions int NOT NULL DEFAULT 0,
  lapses int NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  last_reviewed_at timestamptz,
  UNIQUE (user_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS review_cards_due ON review_cards (user_id, course_id, due_at);

CREATE TABLE IF NOT EXISTS review_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES review_cards(id) ON DELETE CASCADE,
  quality int NOT NULL CHECK (quality BETWEEN 0 AND 5),
  confidence text CHECK (confidence IN ('sure','unsure','guess')),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Flashcards generated from the student's own notes (algorithmic first, AI optional)
CREATE TABLE IF NOT EXISTS flashcards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id),
  topic_id uuid REFERENCES ccmas_topics(id),
  chunk_id uuid REFERENCES chunks(id) ON DELETE SET NULL,
  front text NOT NULL,
  back text NOT NULL,
  method text NOT NULL CHECK (method IN ('definition','cloze','ai')),
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, course_id, front)
);

-- 5. AI gateway: content-addressed cache + daily quota counter
CREATE TABLE IF NOT EXISTS ai_cache (
  key text PRIMARY KEY,             -- sha256(kind + input)
  kind text NOT NULL,               -- explanation | model_answer | essay_mark | chat | ...
  payload jsonb NOT NULL,
  hits int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_usage (
  day date NOT NULL,
  provider text NOT NULL,
  calls int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);

-- 6. Study planner
CREATE TABLE IF NOT EXISTS study_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id),
  exam_date date NOT NULL,
  minutes_per_day int NOT NULL DEFAULT 120,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS study_plan_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('learn','review','mock')),
  topic_id uuid REFERENCES ccmas_topics(id),
  minutes int NOT NULL,
  done boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS study_plan_days_plan ON study_plan_days (plan_id, day);

-- 7. Streaks and study time (one row per user per day)
CREATE TABLE IF NOT EXISTS study_days (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  minutes int NOT NULL DEFAULT 0,
  cards_reviewed int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- 8. GPA / CGPA planner (Nigerian 5.0 scale lives in engine.mjs, override per school there)
CREATE TABLE IF NOT EXISTS course_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session text NOT NULL,            -- e.g. 2025/2026
  semester int NOT NULL CHECK (semester IN (1,2)),
  course_code text NOT NULL,
  units int NOT NULL CHECK (units > 0),
  score numeric NOT NULL CHECK (score BETWEEN 0 AND 100),
  UNIQUE (user_id, session, semester, course_code)
);
CREATE TABLE IF NOT EXISTS user_goals (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  target_cgpa numeric NOT NULL DEFAULT 4.5
);

-- 9. Ask-the-course chat (answers grounded in the student's own chunks)
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  source_chunk_ids uuid[],
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages (user_id, course_id, created_at);

-- 10. Data source for banker topics: topic frequency per paper year (scope by user_id)
CREATE OR REPLACE VIEW pq_topic_frequency AS
SELECT d.user_id, q.course_id, q.lecturer_id, q.topic_id, d.year,
       count(*) AS n, coalesce(sum(q.marks), 0) AS marks
FROM pq_questions q
JOIN documents d ON d.id = q.document_id
WHERE q.topic_id IS NOT NULL
GROUP BY d.user_id, q.course_id, q.lecturer_id, q.topic_id, d.year;
