-- PQ exam-prep platform: plain Postgres schema

CREATE TYPE doc_kind AS ENUM ('past_question', 'note', 'textbook', 'ccmas');
CREATE TYPE doc_status AS ENUM ('uploaded', 'parsing', 'ready', 'failed');
CREATE TYPE difficulty AS ENUM ('easy', 'medium', 'hard');
CREATE TYPE q_type AS ENUM ('mcq', 'short_answer', 'theory', 'calculation');
CREATE TYPE cog_level AS ENUM ('recall', 'application', 'analysis');

-- Accounts
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text,
  created_at timestamptz DEFAULT now()
);

-- Course catalogue
CREATE TABLE courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,              -- e.g. CSC 201
  title text NOT NULL,
  department text,
  level int,
  UNIQUE (code)
);

CREATE TABLE lecturers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  institution text
);

-- NUC CCMAS syllabus topics (tree) per course
CREATE TABLE ccmas_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES ccmas_topics(id),
  title text NOT NULL,
  position int DEFAULT 0,
  weight numeric DEFAULT 1          -- default share of marks; refined from PQ frequency
);

-- Uploaded files (private per user)
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id),
  lecturer_id uuid REFERENCES lecturers(id),   -- mainly for PQs
  kind doc_kind NOT NULL,
  year int,                                    -- exam year for PQs
  storage_key text NOT NULL,
  status doc_status DEFAULT 'uploaded',
  needs_ocr boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX ON documents (user_id, course_id, kind);

-- Embedded text chunks from notes / textbooks / CCMAS
CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  topic_id uuid REFERENCES ccmas_topics(id),
  page int,
  content text NOT NULL,
  embedding jsonb                   -- array of floats, compared in the app
);
CREATE INDEX ON chunks (document_id);

-- Questions parsed out of past papers
CREATE TABLE pq_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id),
  lecturer_id uuid REFERENCES lecturers(id),
  topic_id uuid REFERENCES ccmas_topics(id),
  section text,                     -- e.g. Section A
  position int,
  q_type q_type,
  marks numeric,
  cognitive cog_level,
  command_verb text,                -- "differentiate", "explain", "calculate"
  text text NOT NULL,
  embedding jsonb
);
CREATE INDEX ON pq_questions (course_id, lecturer_id);

-- Learned lecturer style, rebuilt as more PQs are uploaded
CREATE TABLE style_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id),
  lecturer_id uuid REFERENCES lecturers(id),
  profile jsonb NOT NULL,           -- format mix, marks split, topic freq, verbs, layout
  sample_size int NOT NULL,         -- number of PQs used
  confidence numeric,               -- shown to user; low when sample_size is small
  version int DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  UNIQUE (course_id, lecturer_id, version)
);

-- Generated mock exams
CREATE TABLE exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id),
  style_profile_id uuid REFERENCES style_profiles(id),
  difficulty difficulty NOT NULL,
  duration_minutes int,
  total_marks numeric,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE exam_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  topic_id uuid REFERENCES ccmas_topics(id),
  position int NOT NULL,
  section text,
  q_type q_type NOT NULL,
  marks numeric NOT NULL,
  difficulty difficulty,
  text text NOT NULL,
  options jsonb,                    -- MCQ choices
  answer text,                      -- model answer / marking guide
  explanation text,
  source_chunk_ids uuid[],          -- grounding for the answer key
  verified boolean DEFAULT false    -- passed the second-pass check
);
CREATE INDEX ON exam_questions (exam_id, position);

-- Taking an exam
CREATE TABLE attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz DEFAULT now(),
  submitted_at timestamptz,
  score numeric
);

CREATE TABLE attempt_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  exam_question_id uuid NOT NULL REFERENCES exam_questions(id),
  response text,
  score numeric,
  time_spent_seconds int,
  feedback text,
  UNIQUE (attempt_id, exam_question_id)
);
