-- Exam Focus v3: reading mode. Run AFTER schema.sql and schema_v2.sql. Safe to re-run.

-- What the student has read, per passage (chunk). Time spent also feeds study_days for streaks.
CREATE TABLE IF NOT EXISTS reading_progress (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  first_read_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  seconds int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chunk_id)
);

-- The student's own highlights and margin notes
CREATE TABLE IF NOT EXISTS user_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  quote text,                        -- the highlighted text
  note text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_notes_chunk ON user_notes (user_id, chunk_id);

-- Reading coverage per topic: readFraction = read_chunks / chunks (input to readingQueue)
CREATE OR REPLACE VIEW topic_reading AS
SELECT d.user_id, c.topic_id,
       count(*) AS chunks,
       count(rp.chunk_id) AS read_chunks,
       coalesce(sum(rp.seconds), 0) AS seconds
FROM chunks c
JOIN documents d ON d.id = c.document_id
LEFT JOIN reading_progress rp ON rp.chunk_id = c.id AND rp.user_id = d.user_id
WHERE c.topic_id IS NOT NULL
GROUP BY d.user_id, c.topic_id;
