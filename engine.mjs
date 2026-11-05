// Exam Focus hybrid engine. Everything here runs WITHOUT AI except makeGateway(),
// which is the single place a model is ever called (cache first, quota-guarded).
import { createHash } from "node:crypto";

const DAY = 86400000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const startOfDay = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);
export const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

// Split `total` into integer parts proportional to `weights` (largest remainder).
function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (total * w) / sum);
  const base = raw.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - base[i], i]).sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => { if (left > 0) { base[i]++; left--; } });
  return base;
}
function rng(seed = 1) { // mulberry32: deterministic tie-breaking
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ───────────── 1. Text helpers ───────────── */
const STOP = new Set(("a an the of in on at to for and or but is are was were be been being it its this that these " +
  "those with as by from which who whom what when where why how can could may might shall should will would do does " +
  "did not no than then so such into out up down over under between among also very more most other some any each").split(" "));
const SUFFIX = ["ations", "ation", "ments", "ment", "ities", "ity", "ness", "ings", "ing", "ed", "es", "ly", "s"];
export const tokenize = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
export function stem(w) {
  if (w.endsWith("ies") && w.length > 5) return w.slice(0, -3) + "y";
  for (const s of SUFFIX) if (w.length - s.length >= 4 && w.endsWith(s)) { w = w.slice(0, -s.length); break; }
  return w.replace(/e$/, "");
}
function keyTerms(text) { // stem -> { n, word }
  const out = new Map();
  for (const t of tokenize(text)) {
    if (STOP.has(t) || t.length < 3) continue;
    const k = stem(t), cur = out.get(k);
    out.set(k, { n: (cur?.n || 0) + 1, word: cur?.word || t });
  }
  return out;
}

/* ───────────── 2. Marking (algorithm first, AI only when unsure) ───────────── */
export function markMcq({ response, answer, marks }) {
  const pick = (s) => String(s ?? "").trim().match(/^\(?([A-Da-d])\b/)?.[1]?.toUpperCase();
  const ok = pick(response) && pick(response) === pick(answer);
  return { score: ok ? marks : 0, needsAI: false, markedBy: "algorithm" };
}

export function markText({ response, answer, marks, qType = "short_answer" }) {
  const want = keyTerms(answer), got = keyTerms(response);
  if (!want.size) return { score: 0, coverage: 0, missing: [], needsAI: true, markedBy: "algorithm" };
  let total = 0, hit = 0; const missing = [];
  for (const [k, { n, word }] of want) {
    const w = (1 + Math.log(n)) * Math.min(1.5, k.length / 6 + 0.5); // repeated + longer terms matter more
    total += w;
    if (got.has(k)) hit += w; else missing.push([word, w]);
  }
  const coverage = hit / total;
  const score = Math.round(clamp((coverage - 0.2) / 0.6, 0, 1) * marks * 2) / 2; // below 20% = 0, above 80% = full
  const blank = !String(response ?? "").trim();
  return {
    score: blank ? 0 : score, coverage: round(coverage),
    missing: missing.sort((a, b) => b[1] - a[1]).slice(0, 5).map((m) => m[0]),
    // keyword matching can't judge reasoning, so grey-zone essays go to the AI
    needsAI: !blank && coverage > 0.35 && coverage < 0.7 && (qType === "theory" || marks >= 4),
    markedBy: "algorithm",
  };
}

const nums = (s) => (String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
export function markCalculation({ response, answer, marks, tol = 0.01 }) {
  const want = nums(answer).at(-1), got = nums(response).at(-1);
  if (want === undefined) return { score: 0, needsAI: true, markedBy: "algorithm" };
  if (got !== undefined && Math.abs(got - want) <= Math.abs(want) * tol + 1e-9) return { score: marks, needsAI: false, markedBy: "algorithm" };
  return { score: 0, needsAI: marks > 2 && !!String(response ?? "").trim(), markedBy: "algorithm" }; // method marks need a reader
}

export function markAnswer(q, response) {
  const a = { response, answer: q.answer, marks: Number(q.marks), qType: q.q_type };
  if (q.q_type === "mcq") return markMcq(a);
  if (q.q_type === "calculation") return markCalculation(a);
  return markText(a);
}

/* ───────────── 3. Mistake analysis ───────────── */
// answers: [{ position, score, max, response, confidence, time_spent_seconds, q_type }]
export function classifyMistakes(answers) {
  const times = answers.map((a) => a.time_spent_seconds).filter((t) => t > 0).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;
  const n = answers.length;
  const tagged = answers.map((a) => {
    const f = a.max ? a.score / a.max : 0;
    let type = null;
    if (!String(a.response ?? "").trim()) type = a.position > n * 0.7 ? "time_pressure" : "skipped";
    else if (f >= 0.9) type = null;
    else if (a.confidence === "sure" && f < 0.5) type = "overconfident";
    else if (f < 0.5 && a.q_type === "mcq" && median && a.time_spent_seconds < median * 0.4) type = "careless";
    else if (f < 0.5) type = "knowledge_gap";
    else type = "incomplete";
    return { ...a, error_type: type };
  });
  const summary = {};
  for (const t of tagged) if (t.error_type) summary[t.error_type] = (summary[t.error_type] || 0) + 1;
  return { answers: tagged, summary };
}

/* ───────────── 4. Spaced repetition (SM-2 + confidence) ───────────── */
export function qualityFrom({ fraction, confidence = "unsure" }) {
  const row = fraction >= 0.9 ? { sure: 5, unsure: 4, guess: 3 }
    : fraction >= 0.6 ? { sure: 4, unsure: 3, guess: 2 }
    : fraction >= 0.3 ? { sure: 1, unsure: 2, guess: 2 }   // "sure" but wrong is penalised hardest
    : { sure: 0, unsure: 1, guess: 1 };
  return row[confidence] ?? row.unsure;
}

export function sm2(card, quality, { now = new Date(), examDate = null } = {}) {
  let { ease = 2.5, interval_days = 0, repetitions = 0, lapses = 0 } = card;
  if (quality < 3) { repetitions = 0; interval_days = 1; lapses++; }
  else {
    interval_days = repetitions === 0 ? 1 : repetitions === 1 ? 6 : Math.round(interval_days * ease);
    repetitions++;
  }
  ease = Math.max(1.3, ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (examDate) { // never schedule past the exam: keep at least two more looks before it
    const left = Math.floor((startOfDay(examDate) - startOfDay(now)) / DAY);
    interval_days = clamp(interval_days, 1, Math.max(1, Math.floor(left / 2)));
  }
  return { ease: round(ease, 3), interval_days, repetitions, lapses, due_at: addDays(now, interval_days), last_reviewed_at: new Date(now) };
}

export function reviewQueue(cards, { now = new Date(), limit = 20 } = {}) {
  return cards.filter((c) => new Date(c.due_at) <= now)
    .map((c) => ({ c, overdue: (now - new Date(c.due_at)) / DAY / Math.max(1, c.interval_days) }))
    .sort((a, b) => b.overdue - a.overdue).slice(0, limit).map((x) => x.c);
}

/* ───────────── 5. Lecturer pattern + banker topics ───────────── */
export function buildStyleProfile(questions, paperCount) {
  const papers = paperCount ?? new Set(questions.map((q) => q.document_id)).size;
  const tally = (key) => questions.reduce((m, q) => (q[key] ? (m[q[key]] = (m[q[key]] || 0) + 1, m) : m), {});
  const share = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v / questions.length)]));
  const marksSum = {}, marksN = {};
  for (const q of questions) if (q.q_type && q.marks != null) { marksSum[q.q_type] = (marksSum[q.q_type] || 0) + Number(q.marks); marksN[q.q_type] = (marksN[q.q_type] || 0) + 1; }
  const verbs = Object.entries(tally("command_verb")).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([command_verb, n]) => ({ command_verb, n }));
  return {
    sample_size: papers,
    confidence: round(1 - Math.exp(-papers / 3)),   // 1 paper ≈ 28%, 3 ≈ 63%, 5 ≈ 81%
    profile: {
      typeMix: share(tally("q_type")), cognitiveMix: share(tally("cognitive")), topicFreq: tally("topic_id"),
      avgMarks: Object.fromEntries(Object.keys(marksSum).map((t) => [t, round(marksSum[t] / marksN[t])])),
      questionsPerPaper: papers ? round(questions.length / papers, 1) : 0, commonVerbs: verbs,
    },
  };
}

// rows: raw questions OR rows of pq_topic_frequency ({ topic_id, year, n, marks })
export function bankerTopics(rows, { halfLifeYears = 2 } = {}) {
  const maxYear = Math.max(...rows.map((r) => r.year ?? 0), 0);
  const byTopic = new Map();
  for (const r of rows) {
    const n = Number(r.n ?? 1), decay = 0.5 ** ((maxYear - (r.year ?? maxYear)) / halfLifeYears);
    const t = byTopic.get(r.topic_id) || { topic_id: r.topic_id, appearances: 0, weighted: 0, lastYear: 0 };
    t.appearances += n; t.weighted += (Number(r.marks) || n) * decay; t.lastYear = Math.max(t.lastYear, r.year ?? 0);
    byTopic.set(r.topic_id, t);
  }
  const list = [...byTopic.values()].sort((a, b) => b.weighted - a.weighted);
  const sum = list.reduce((a, t) => a + t.weighted, 0) || 1;
  let cum = 0;
  return list.map((t, i) => {
    const share = t.weighted / sum; cum += share;
    return { ...t, rank: i + 1, share: round(share, 3),
      tier: cum - share < 0.5 ? "banker" : cum - share < 0.8 ? "likely" : "low",   // Pareto bands
      dueForReturn: t.appearances >= 2 && t.lastYear < maxYear };                  // set often, skipped last time
  });
}

/* ───────────── 6. Exam builder (question bank first, AI fills gaps) ───────────── */
const COG_TARGET = {
  easy: { recall: 0.7, application: 0.25, analysis: 0.05 },
  medium: { recall: 0.3, application: 0.5, analysis: 0.2 },
  hard: { recall: 0.1, application: 0.4, analysis: 0.5 },
};
export function buildExam({ pool, typeMix = {}, difficulty = "medium", count = 10, topicWeights = {}, focus = null, seed = 1 }) {
  const rand = rng(seed), cog = COG_TARGET[difficulty] || COG_TARGET.medium;
  const types = Object.keys(typeMix).length ? Object.keys(typeMix) : ["mcq", "short_answer", "theory"];
  const slots = apportion(count, types.map((t) => typeMix[t] ?? 1));
  const used = new Set(), perTopic = {}, picked = [], gaps = [];
  const w = (id) => (topicWeights[id] ?? 0.05) * (focus?.includes(id) ? 10 : 1);
  types.forEach((type, ti) => {
    for (let s = 0; s < slots[ti]; s++) {
      let best = null, bestScore = -1;
      for (const q of pool) {
        if (used.has(q.id) || q.q_type !== type) continue;
        const score = (w(q.topic_id) * (0.5 + (cog[q.cognitive] ?? 0.1))) / (1 + 0.8 * (perTopic[q.topic_id] || 0)) + rand() * 1e-6;
        if (score > bestScore) { best = q; bestScore = score; }
      }
      if (best) { used.add(best.id); perTopic[best.topic_id] = (perTopic[best.topic_id] || 0) + 1; picked.push(best); }
      else { // bank has nothing left of this type: ask the AI for exactly this slot
        const topic = Object.keys(topicWeights).sort((a, b) => w(b) / (1 + (perTopic[b] || 0)) - w(a) / (1 + (perTopic[a] || 0)))[0] ?? null;
        if (topic) perTopic[topic] = (perTopic[topic] || 0) + 1;
        gaps.push({ q_type: type, topic_id: topic });
      }
    }
  });
  return { picked, gaps, aiShare: count ? round(gaps.length / count) : 0 };
}

/* ───────────── 7. Mastery + readiness ───────────── */
export function updateTopicStat(stat, { score, max, now = new Date() }) {
  const s = stat ?? { earned: 0, possible: 0, attempts: 0, last_seen: null };
  const days = s.last_seen ? (now - new Date(s.last_seen)) / DAY : 0;
  const decay = 0.5 ** (days / 45);                       // old evidence fades with a 45-day half-life
  return { earned: s.earned * decay + score, possible: s.possible * decay + max, attempts: s.attempts + 1, last_seen: new Date(now) };
}

// topics: [{ topic_id, title, weight, earned, possible, last_seen }]
export function readiness(topics, { now = new Date(), priorMarks = 4 } = {}) {
  const sumW = topics.reduce((a, t) => a + (t.weight ?? 1), 0) || 1;
  const rows = topics.map((t) => {
    const days = t.last_seen ? (now - new Date(t.last_seen)) / DAY : 0;
    const retention = 0.5 + 0.5 * Math.exp(-days / 21);   // forgetting curve, floored at 50%
    const mastery = t.possible > 0 ? ((t.earned + 0.5 * priorMarks) / (t.possible + priorMarks)) * retention : 0;
    return { ...t, mastery: round(mastery), status: t.possible <= 0 ? "untouched" : mastery < 0.5 ? "weak" : mastery < 0.75 ? "shaky" : "strong" };
  });
  const score = Math.round(100 * rows.reduce((a, r) => a + (r.weight ?? 1) * r.mastery, 0) / sumW);
  return { score, label: score >= 75 ? "On track" : score >= 50 ? "Getting there" : "At risk", topics: rows.sort((a, b) => a.mastery - b.mastery) };
}

/* ───────────── 8. Study planner ───────────── */
// topics: [{ topic_id, title, weight, mastery }]  (mastery 0..1, from readiness())
export function studyPlan({ topics, examDate, today = new Date(), minutesPerDay = 120, block = 30 }) {
  const start = startOfDay(today), days = Math.floor((startOfDay(examDate) - start) / DAY);
  if (days < 1 || !topics.length) return { days: [], note: "The exam is today, in the past, or no topics were given." };
  const perDay = Math.max(1, Math.floor(minutesPerDay / block));
  const need = topics.map((t) => ({ ...t, need: (t.weight ?? 1) * (1.05 - clamp(t.mastery ?? 0, 0, 1)) })).sort((a, b) => b.need - a.need);
  const reserved = days >= 5 ? 2 : days >= 2 ? 1 : 0;      // mock day, then a light review day before the exam
  const learnDays = days - reserved, out = [];
  const total = learnDays * perDay, blocks = apportion(total, need.map((t) => t.need));
  // Interleave: spread each topic's blocks evenly across the window instead of cramming one topic per day
  const queue = need.flatMap((t, i) => Array.from({ length: blocks[i] }, (_, j) => ({ t, key: (j + 0.5) / blocks[i] + i * 1e-6 })))
    .sort((a, b) => a.key - b.key).map((x) => x.t);
  for (let d = 0; d < learnDays; d++) {
    const merged = new Map();
    for (const t of queue.slice(d * perDay, (d + 1) * perDay)) merged.set(t.topic_id, (merged.get(t.topic_id) || 0) + block);
    for (const [topic_id, minutes] of merged) out.push({ day: dayKey(addDays(start, d)), kind: "learn", topic_id, minutes });
  }
  if (reserved === 2) out.push({ day: dayKey(addDays(start, days - 2)), kind: "mock", topic_id: null, minutes: minutesPerDay });
  if (reserved >= 1) need.slice(0, 3).forEach((t) => out.push({ day: dayKey(addDays(start, days - 1)), kind: "review", topic_id: t.topic_id, minutes: Math.min(block, Math.floor(minutesPerDay / 3)) }));
  return { days: out, learnDays, blocksPerDay: perDay };
}

/* ───────────── 9. GPA planner (Nigerian 5.0 scale, NUC classes) ───────────── */
export const NG_SCALE = [[70, "A", 5], [60, "B", 4], [50, "C", 3], [45, "D", 2], [40, "E", 1], [0, "F", 0]];
export const gradeFor = (score, scale = NG_SCALE) => { const [, grade, points] = scale.find(([min]) => score >= min); return { grade, points }; };
export function cgpa(results, scale = NG_SCALE) {
  const units = results.reduce((a, r) => a + r.units, 0);
  const points = results.reduce((a, r) => a + r.units * gradeFor(r.score, scale).points, 0);
  return { units, points, cgpa: units ? round(points / units) : 0 };
}
export const degreeClass = (c) => c >= 4.5 ? "First Class" : c >= 3.5 ? "Second Class Upper" : c >= 2.4 ? "Second Class Lower" : c >= 1.5 ? "Third Class" : c >= 1 ? "Pass" : "Fail";
export function targetPlanner({ doneUnits, donePoints, remainingUnits, target = 4.5, maxPoints = 5 }) {
  const required = (target * (doneUnits + remainingUnits) - donePoints) / remainingUnits;
  return { requiredGpa: round(Math.max(required, 0)), feasible: required <= maxPoints,
    // if the rest are B's, this share of remaining units must be A's
    aShareIfRestB: required > 4 && required <= 5 ? round(required - 4) : required <= 4 ? 0 : null };
}

/* ───────────── 10. Streaks ───────────── */
export function streak(days, today = new Date()) {
  const set = new Set(days.map(dayKey));
  let current = 0, d = startOfDay(today);
  if (!set.has(dayKey(d))) d = addDays(d, -1);              // today not studied yet doesn't break the streak
  while (set.has(dayKey(d))) { current++; d = addDays(d, -1); }
  let longest = 0, run = 0, prev = null;
  for (const k of [...set].sort()) { run = prev && (new Date(k) - new Date(prev)) === DAY ? run + 1 : 1; longest = Math.max(longest, run); prev = k; }
  return { current, longest };
}

/* ───────────── 11. Flashcards without AI ───────────── */
const DEF = /^\s*([A-Z][\w\s\-/(),']{2,70}?)\s+(?:is|are|refers to|is defined as|are defined as|means|can be defined as)\s+(.{20,320})$/;
const sentences = (text) => String(text ?? "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim());
export function definitionCards(text) {
  return sentences(text).flatMap((s) => { const m = s.match(DEF); return m ? [{ front: `Define: ${m[1].trim()}`, back: s, method: "definition" }] : []; });
}
export function clozeCards(text, { max = 10 } = {}) {
  const out = [];
  for (const s of sentences(text)) {
    const words = s.split(" ");
    if (words.length < 8 || words.length > 30) continue;
    const term = tokenize(s).filter((t) => t.length >= 7 && !STOP.has(t)).sort((a, b) => b.length - a.length)[0];
    if (!term) continue;
    out.push({ front: s.replace(new RegExp(term, "i"), "_____"), back: term, method: "cloze" });
    if (out.length >= max) break;
  }
  return out;
}

/* ───────────── 12. Retrieval for ask-the-course chat ───────────── */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
export function topChunks(queryEmbedding, chunks, { k = 4, minSim = 0.25 } = {}) {
  return chunks.map((c) => ({ ...c, sim: cosine(queryEmbedding, c.embedding) })).filter((c) => c.sim >= minSim)
    .sort((a, b) => b.sim - a.sim).slice(0, k);
}

/* ───────────── 13. AI gateway: cache → quota → providers → fallback ───────────── */
// cache: { get(key), set(key, kind, value) }   usage: { get(day, provider), incr(day, provider) }
// providers: [{ name, dailyLimit, call(prompt) }]  tried in order; a failing or exhausted one is skipped
export function makeGateway({ cache, usage, providers, now = () => new Date() }) {
  return async function ask({ kind, input, prompt, fallback }) {
    const key = createHash("sha256").update(kind + "\n" + JSON.stringify(input)).digest("hex");
    const hit = await cache.get(key);
    if (hit !== undefined && hit !== null) return { value: hit, cached: true };
    const day = dayKey(now());
    for (const p of providers) {
      if ((await usage.get(day, p.name)) >= p.dailyLimit) continue;
      try {
        const value = await p.call(prompt);
        await usage.incr(day, p.name);
        await cache.set(key, kind, value);
        return { value, cached: false, provider: p.name };
      } catch { /* rate-limited or down: try the next provider */ }
    }
    if (fallback !== undefined) return { value: fallback, cached: false, degraded: true };
    throw new Error("AI_UNAVAILABLE");
  };
}

/* ───────────── 14. Reading mode (study before testing, no AI) ───────────── */
export const COMMAND_GUIDE = {
  define: "One precise sentence, then an example if the marks allow.",
  state: "Short, direct points. No explanation unless the marks ask for it.",
  list: "Numbered points, one line each, matching the number of marks.",
  outline: "Main points only, one line each, in logical order.",
  describe: "Say what it looks like or how it is arranged, step by step. Label the parts.",
  explain: "Give the mechanism: what happens and why. Aim for one reason per mark.",
  discuss: "Cover several aspects or both sides, then a short conclusion.",
  compare: "Go side by side on the same criteria: similarities and differences.",
  differentiate: "Pair each feature of A with the matching feature of B. A table works well.",
  distinguish: "Pair each feature of A with the matching feature of B. A table works well.",
  calculate: "Write the formula, substitute with units, then give the final answer with units.",
  illustrate: "Use a labelled diagram or a worked example.",
  justify: "Give your answer, then the evidence for it.",
  evaluate: "Weigh strengths against weaknesses, then reach a judgement.",
};
const NOT_EXAMINABLE = new Set([...Object.keys(COMMAND_GUIDE).map(stem), "following", "give", "brief", "write", "short", "note", "term", "question", "mark", "answer", "briefly"]);

export function answerGuide(verb, marks = 0) {
  const base = COMMAND_GUIDE[String(verb ?? "").toLowerCase()] ?? null;
  const m = Number(marks) || 0;
  const length = m <= 0 ? null : m <= 2 ? "One to two lines."
    : m <= 5 ? `About ${Math.round(m)} distinct points.`
    : `A short introduction, about ${Math.round(m)} points with examples, then a conclusion.`;
  return [base, length].filter(Boolean).join(" ") || null;
}

// Terms a lecturer keeps asking about, weighted by how many questions use them.
export function examTerms(questions) {
  const df = new Map();
  for (const q of questions) for (const [k] of keyTerms(q.text)) {
    if (NOT_EXAMINABLE.has(k)) continue;
    df.set(k, (df.get(k) || 0) + (Number(q.marks) >= 5 ? 1.5 : 1)); // big-mark questions count more
  }
  return new Map([...df].map(([k, c]) => [k, 1 + Math.log(c)]));
}

// Score every sentence of a passage. level: "high" (top 10%) | "medium" (next 15%) | null.
export function scoreSentences(text, { terms }) {
  const scored = sentences(text).filter(Boolean).map((s, index) => {
    let hit = 0; const matched = [];
    for (const [k, { word }] of keyTerms(s)) { const w = terms.get(k); if (w) { hit += w; matched.push(word); } }
    const isDef = DEF.test(s);
    const score = hit / Math.sqrt(Math.max(8, tokenize(s).length)) + (isDef ? 0.6 : 0);
    return { index, text: s, score: round(score, 3), matched, kind: isDef ? "definition" : null };
  });
  const ranked = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const hi = Math.ceil(scored.length * 0.1), md = Math.ceil(scored.length * 0.25);
  const high = new Set(ranked.slice(0, hi).map((x) => x.index)), med = new Set(ranked.slice(hi, md).map((x) => x.index));
  return scored.map((x) => ({ ...x, level: high.has(x.index) ? "high" : med.has(x.index) ? "medium" : null }));
}

// Key points: highest-scoring sentences, near-duplicates skipped, shown in reading order.
export function extractiveSummary(text, { terms, max = 4 }) {
  const pool = scoreSentences(text, { terms }).filter((s) => s.score > 0 && tokenize(s.text).length >= 6).sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const s of pool) {
    if (chosen.length >= max) break;
    const a = new Set(tokenize(s.text));
    const dup = chosen.some((c) => { const b = new Set(tokenize(c.text)); const inter = [...a].filter((x) => b.has(x)).length; return inter / (a.size + b.size - inter) > 0.6; });
    if (!dup) chosen.push(s);
  }
  return chosen.sort((a, b) => a.index - b.index).map((s) => s.text);
}

// "How this topic is asked": rows are the past questions for ONE topic.
export function howAsked(rows, { papers = null } = {}) {
  if (!rows.length) return { askedInPapers: 0, ofPapers: papers, verbs: [], avgMarks: null, typicalType: null, years: [], guide: null };
  const count = (vals) => Object.entries(vals.reduce((m, v) => (v ? (m[v] = (m[v] || 0) + 1, m) : m), {})).sort((a, b) => b[1] - a[1]);
  const verbs = count(rows.map((r) => r.command_verb?.toLowerCase())).map(([command_verb, n]) => ({ command_verb, n }));
  const marks = rows.map((r) => Number(r.marks)).filter(Number.isFinite);
  const avgMarks = marks.length ? round(marks.reduce((a, b) => a + b, 0) / marks.length, 1) : null;
  return {
    askedInPapers: new Set(rows.map((r) => r.document_id)).size, ofPapers: papers, verbs, avgMarks,
    typicalType: count(rows.map((r) => r.q_type))[0]?.[0] ?? null,
    years: [...new Set(rows.map((r) => r.year).filter(Boolean))].sort((a, b) => b - a),
    guide: verbs[0] ? answerGuide(verbs[0].command_verb, avgMarks ?? 0) : null,
  };
}

// topics: [{ topic_id, title, share, tier, mastery, readFraction }] (share/tier from bankerTopics, mastery from readiness)
export function readingQueue(topics) {
  return topics.map((t) => {
    const mastery = clamp(t.mastery ?? 0, 0, 1), read = clamp(t.readFraction ?? 0, 0, 1), banker = t.tier === "banker";
    const priority = Math.max(t.share ?? 0, 0.02) * (1.05 - mastery) * (1 - 0.9 * read); // examined often, known poorly, not read yet
    const reason = read >= 0.95 ? "done" : read > 0 ? "finish reading" : banker && mastery < 0.6 ? "high-yield and weak"
      : banker ? "high-yield" : mastery < 0.5 ? "weak" : "worth a read";
    return { ...t, priority: round(priority, 4), reason };
  }).filter((t) => t.reason !== "done").sort((a, b) => b.priority - a.priority);
}
