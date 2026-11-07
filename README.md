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
- **Practice streak**: see consecutive days with completed exams and your longest streak on the dashboard.
- **Guided reading**: see past-paper answering tips, high-yield passages, and key-point summaries from your own notes; track reading progress and save personal notes without using AI requests.
- **Dark mode**: follows your device preference by default, with a saved in-app toggle.
- **OCR for scans and photos**: scanned PDFs and phone photos of past papers are read locally with Tesseract (no API, no limits).
- **Multiple courses**: add any course and switch between them while studying. Each course has its own topics, source library, exams, and progress; MBBS 214 is only the sample course.
- **Private accounts**: students can sign up with an email and password. Courses, lecturers, uploads, exams, and results are scoped to the signed-in account; another account cannot access them.
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
- **Lower-credit mode.** Exact repeated AI requests and embeddings are cached in Postgres. Low-credit mode is on by default, caps an exam at five questions and skips the separate AI answer-verification call; switch it off for longer exams with verification.
- **Fair shared AI access.** Students can create multiple, independently varied exams, subject to a daily allowance of 40 provider requests per account and a platform-wide 1,000-request cap. Cache hits do not count; provider retries and fallbacks do. The app shows remaining usage on the source and exam pages, and stops new provider requests when either cap is reached. Set `AI_USER_DAILY_CALL_LIMIT` and `AI_GLOBAL_DAILY_CALL_LIMIT` in the deployment environment to match the provider plan; these count requests, not dollars, so also configure the provider's own billing limit.
- **Private AI cache.** Cached AI answers and embeddings are scoped to the signed-in account; one student's material is not used to serve another student's cached result.
- **Built for free-tier limits.** Questions are written in parallel batches, the answer check runs in the background so the exam opens sooner, topic embeddings are cached, and prompts are kept small.
- **Shared rules engine.** Exam plans use the lecturer's question mix and a recency-weighted past-paper bank; source retrieval, deterministic answer checks, mistake labels and topic readiness use the same tested engine as `engine.test.mjs`. Written answers that need judgement still go to the AI marker.
- **No vector-database dependency.** Embeddings live in plain Postgres `jsonb` and are compared in application code, so it runs on any Postgres install.
- **Defensive handling of LLM output.** MCQ options, question types and topic ids are normalised before saving, because models return them in inconsistent shapes.
- **Safe by default.** Parameterised SQL everywhere and HTML-escaped rendering in the frontend.

## Tech stack

Node.js, TypeScript, Express, PostgreSQL, vanilla JavaScript single-page frontend (hash router), `pdf-parse`, LLM and embedding APIs over plain `fetch`.

## Install on a phone or computer

Exam Focus is an installable Progressive Web App. Deploy it over HTTPS, open the site in a supported browser, and choose **Install** in the app or the browser's **Add to Home Screen / Install app** option. On iPhone or iPad, open the site in Safari, tap **Share**, then **Add to Home Screen**. The app shell can open offline, but signing in, loading course data, and saving progress require a connection. Private API responses are never cached offline.

## Run it locally

Requires Node 20+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env        # then fill in your keys
psql -U postgres -c "CREATE DATABASE pqprep;"
psql -U postgres -d pqprep -f schema.sql
psql -U postgres -d pqprep -f seed.sql      # prints your demo user id
npm run dev                 # http://localhost:3000
```

Open the app and create an account or sign in. The first run applies the account/session and course-ownership migration to the existing database. Existing course ownership is inferred from its source and exam records; if a course has records from multiple users, startup stops rather than expose them across accounts. Add a course on the Courses page, then upload your own past questions and notes. For the demo course, upload the PDFs in `sample-data/` (the two past papers as "Past questions" with years 2023 and 2024, and the lecture notes as "Notes") and generate an exam.

The app also creates the reading-progress, personal-note, and study-day tables at startup. Run `schema_v2.sql` and `schema_v3.sql` after the base schema to install the remaining optional study features and reading-coverage view.

Each account has a private copy of its courses and study data; this version does not yet support shared class workspaces. Use HTTPS when hosting publicly so session cookies and browser-to-app traffic are protected. Remote PostgreSQL connections require TLS with certificate verification; local loopback/socket connections are left unencrypted for development. Do not use an untrusted/self-signed database certificate. Enable encryption at rest for the managed database, storage volumes, and backups in your hosting provider, and store API/database secrets only in deployment secrets or an untracked `.env` file. Email verification and password-reset emails are not configured yet, so users should use an email address they can access and remember their password. Daily AI allowances reset at 00:00 UTC; they govern uncached provider requests, not exact provider charges.

Free API keys are enough to try it: see `.env.example` for the providers supported.

### Deploy on Render

Create a Render Web Service for this repository and use:

- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Node version:** 20 or newer

Configure the required database and AI provider environment variables in Render. The service listens on the port provided by Render.

## Limitations and roadmap

- No shared course workspaces, email verification, or self-service password reset yet.
- OCR accuracy depends on scan quality; only the first 40 pages of a scanned PDF are read.
- Uploaded files are parsed but not stored.

## Licence

MIT
