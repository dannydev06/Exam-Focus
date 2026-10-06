# Exam Focus

**AI mock exams that mimic how *your* lecturer sets questions.**

Upload past questions, lecture notes and the course syllabus. Exam Focus learns the lecturer's style (question formats, marks, command verbs, which topics keep coming back), then generates realistic Easy / Medium / Hard practice exams from your own material, marks them, and shows what to revise next.

![Dashboard](docs/dashboard.png)

## Features

- **Lecturer pattern**: past papers are parsed into structured questions; a profile of question formats, marks, common verbs and topic frequency is built from them.
- **Exam generation**: Easy / Medium / Hard exams written in that lecturer's style, grounded in the student's own notes (retrieval over embedded chunks).
- **Exam mode**: countdown timer, question navigator, flagging, auto-submit when time runs out.
- **Marking**: multiple-choice marked deterministically; written answers marked by an LLM against the model answer, with partial credit and saved feedback.
- **Insights**: readiness score, topics tested most, results by topic, and weak-topic practice that builds an exam from the lowest-scoring topics.
- **Course setup**: add courses and lecturers in the app, and extract a topic list from pasted CCMAS course content (reviewed before saving).

## How it works

```
PDF upload -> text extraction -> LLM turns past papers into structured questions
          -> lecturer style profile (SQL aggregation over parsed questions)
notes/textbook -> chunks -> embeddings (stored as jsonb)

Generate:  weighted topic plan -> cosine-similarity retrieval over the student's chunks
           -> questions written in parallel batches -> saved immediately
           -> answers checked against sources in the background
Submit:    MCQ marked in code, written answers marked by the LLM -> results + analytics
```

## Engineering decisions

- **Provider-agnostic AI layer.** One `llmJson()` function supports Groq, Mistral, Cerebras, OpenRouter, Gemini and Anthropic. Providers are tried in order; a rate-limited one fails over instantly, and the last one retries with backoff that honours `Retry-After`.
- **Built for free-tier limits.** Questions are written in parallel batches, the answer check runs in the background so the exam opens sooner, topic embeddings are cached, and prompts are kept small.
- **No vector-database dependency.** Embeddings live in plain Postgres `jsonb` and are compared in application code, so it runs on any Postgres install.
- **Defensive handling of LLM output.** MCQ options, question types and topic ids are normalised before saving, because models return them in inconsistent shapes.
- **Safe by default.** Parameterised SQL everywhere and HTML-escaped rendering in the frontend.

## Tech stack

Node.js, TypeScript, Express, PostgreSQL, vanilla JavaScript single-page frontend (hash router), `pdf-parse`, LLM and embedding APIs over plain `fetch`.

## Run it locally

Requires Node 18+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env        # then fill in your keys
psql -U postgres -c "CREATE DATABASE pqprep;"
psql -U postgres -d pqprep -f schema.sql
psql -U postgres -d pqprep -f seed.sql      # prints your demo user id
npm run dev                 # http://localhost:3000
```

Open the app, paste the user id when asked, then upload the PDFs in `sample-data/` (the two past papers as "Past questions" with years 2023 and 2024, and the lecture notes as "Notes") and generate an exam.

Free API keys are enough to try it: see `.env.example` for the providers supported.

## Limitations and roadmap

- Single-user prototype: no login yet.
- Scanned (image-only) PDFs are flagged but not read; OCR is planned.
- Uploaded files are parsed but not stored.

## Licence

MIT
