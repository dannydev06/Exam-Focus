import test from "node:test";
import assert from "node:assert/strict";
import * as E from "./engine.mjs";

const d = (s) => new Date(s + "T09:00:00Z");

test("marking: MCQ, text keywords, numbers", () => {
  assert.equal(E.markMcq({ response: "B", answer: "B. Left ventricle", marks: 1 }).score, 1);
  assert.equal(E.markMcq({ response: "C", answer: "B", marks: 1 }).score, 0);
  const model = "Systole is the contraction phase of the cardiac cycle when the ventricles eject blood into the aorta and pulmonary artery.";
  const good = E.markText({ response: "Systole is when ventricles contract and eject blood into aorta and pulmonary artery", answer: model, marks: 4 });
  const bad = E.markText({ response: "It is about the kidney", answer: model, marks: 4 });
  const blank = E.markText({ response: "", answer: model, marks: 4 });
  assert.ok(good.score >= 3, `good scored ${good.score}`);
  assert.equal(bad.score, 0);
  assert.equal(blank.score, 0);
  assert.ok(bad.missing.length > 0);
  assert.equal(E.markCalculation({ response: "GFR = 124.5 mL/min", answer: "125 mL/min", marks: 3 }).score, 3);
  assert.equal(E.markCalculation({ response: "90", answer: "125", marks: 3 }).needsAI, true);
});

test("SM-2 schedules 1, 6, then ~ease x interval; lapses reset", () => {
  const now = d("2026-11-04");
  let c = { ease: 2.5, interval_days: 0, repetitions: 0, lapses: 0 };
  c = E.sm2(c, 5, { now }); assert.equal(c.interval_days, 1);
  c = E.sm2(c, 5, { now }); assert.equal(c.interval_days, 6);
  c = E.sm2(c, 4, { now }); assert.ok(c.interval_days >= 14);
  const lapsed = E.sm2(c, 1, { now }); assert.equal(lapsed.interval_days, 1); assert.equal(lapsed.lapses, 1);
  const capped = E.sm2({ ease: 2.5, interval_days: 6, repetitions: 2, lapses: 0 }, 5, { now, examDate: d("2026-11-14") });
  assert.ok(capped.interval_days <= 5, "must come back before the exam");
  assert.ok(E.qualityFrom({ fraction: 0, confidence: "sure" }) < E.qualityFrom({ fraction: 0, confidence: "guess" }) + 1);
  assert.equal(E.qualityFrom({ fraction: 0, confidence: "sure" }), 0);
});

test("review queue: due only, most overdue first", () => {
  const cards = [
    { id: "a", due_at: d("2026-11-03"), interval_days: 1 },
    { id: "b", due_at: d("2026-10-20"), interval_days: 6 },
    { id: "c", due_at: d("2026-11-09"), interval_days: 6 },
  ];
  assert.deepEqual(E.reviewQueue(cards, { now: d("2026-11-04") }).map((c) => c.id), ["b", "a"]);
});

test("banker topics: recency + marks drive rank, tiers and due-for-return", () => {
  const rows = [
    { topic_id: "cardiac", year: 2022, marks: 10 }, { topic_id: "cardiac", year: 2023, marks: 10 }, { topic_id: "cardiac", year: 2024, marks: 10 },
    { topic_id: "renal", year: 2021, marks: 10 }, { topic_id: "renal", year: 2022, marks: 10 },
    { topic_id: "resp", year: 2024, marks: 2 },
  ];
  const r = E.bankerTopics(rows);
  assert.equal(r[0].topic_id, "cardiac");
  assert.equal(r[0].tier, "banker");
  assert.equal(r.find((x) => x.topic_id === "renal").dueForReturn, true);
  assert.ok(Math.abs(r.reduce((a, x) => a + x.share, 0) - 1) < 0.01);
});

test("style profile: confidence grows with papers", () => {
  const qs = [{ document_id: "p1", q_type: "mcq", marks: 1, command_verb: "state" }, { document_id: "p1", q_type: "theory", marks: 10, command_verb: "explain" },
    { document_id: "p2", q_type: "mcq", marks: 1, command_verb: "state" }];
  const p = E.buildStyleProfile(qs);
  assert.equal(p.sample_size, 2);
  assert.ok(p.confidence > 0.4 && p.confidence < 0.6);
  assert.equal(p.profile.commonVerbs[0].command_verb, "state");
  assert.ok(E.buildStyleProfile(qs, 5).confidence > 0.8);
});

test("exam builder: honours type mix, spreads topics, reports AI gaps", () => {
  const pool = [];
  for (let i = 0; i < 6; i++) pool.push({ id: "m" + i, q_type: "mcq", topic_id: i % 2 ? "cardiac" : "renal", cognitive: "recall" });
  pool.push({ id: "t0", q_type: "theory", topic_id: "cardiac", cognitive: "analysis" });
  const r = E.buildExam({ pool, typeMix: { mcq: 0.6, theory: 0.4 }, count: 10, difficulty: "medium", topicWeights: { cardiac: 0.6, renal: 0.4 } });
  assert.equal(r.picked.length + r.gaps.length, 10);
  assert.equal(r.picked.filter((q) => q.q_type === "mcq").length, 6);
  assert.equal(r.gaps.length, 3, "theory bank had 1 of 4 needed");
  assert.equal(r.aiShare, 0.3);
  const focus = E.buildExam({ pool, typeMix: { mcq: 1 }, count: 2, topicWeights: { cardiac: 0.1, renal: 0.9 }, focus: ["cardiac"] });
  assert.ok(focus.picked.some((q) => q.topic_id === "cardiac"), "weak-topic focus pulls cardiac in");
  assert.deepEqual(E.buildExam({ pool, typeMix: { mcq: 1 }, count: 4, seed: 7 }).picked.map((q) => q.id), E.buildExam({ pool, typeMix: { mcq: 1 }, count: 4, seed: 7 }).picked.map((q) => q.id));
});

test("readiness: untouched = 0, recent strong > stale strong > weak", () => {
  const now = d("2026-11-04");
  const r = E.readiness([
    { topic_id: "a", title: "A", weight: 1, earned: 18, possible: 20, last_seen: d("2026-11-03") },
    { topic_id: "b", title: "B", weight: 1, earned: 18, possible: 20, last_seen: d("2026-08-01") },
    { topic_id: "c", title: "C", weight: 1, earned: 4, possible: 20, last_seen: d("2026-11-03") },
    { topic_id: "d", title: "D", weight: 1, earned: 0, possible: 0, last_seen: null },
  ], { now });
  const m = Object.fromEntries(r.topics.map((t) => [t.topic_id, t]));
  assert.ok(m.a.mastery > m.b.mastery && m.b.mastery > m.c.mastery);
  assert.equal(m.d.status, "untouched"); assert.equal(m.d.mastery, 0);
  assert.equal(m.c.status, "weak");
  assert.equal(r.topics[0].topic_id, "d", "weakest first");
  const s = E.updateTopicStat(null, { score: 3, max: 4, now });
  const s2 = E.updateTopicStat(s, { score: 4, max: 4, now: d("2027-01-18") });
  assert.ok(s2.possible < 8 && s2.attempts === 2, "old evidence decays");
});

test("study plan: weakest gets most time, mock + review before exam, nothing after", () => {
  const topics = [{ topic_id: "weak", weight: 1, mastery: 0.1 }, { topic_id: "mid", weight: 1, mastery: 0.5 }, { topic_id: "strong", weight: 1, mastery: 0.95 }];
  const p = E.studyPlan({ topics, today: d("2026-11-04"), examDate: d("2026-11-14"), minutesPerDay: 120 });
  const mins = {}; p.days.filter((x) => x.kind === "learn").forEach((x) => (mins[x.topic_id] = (mins[x.topic_id] || 0) + x.minutes));
  assert.ok(mins.weak > mins.mid && mins.mid > mins.strong);
  assert.equal(p.days.filter((x) => x.kind === "learn").reduce((a, x) => a + x.minutes, 0), 8 * 120, "8 learn days x 120 min");
  assert.ok(p.days.some((x) => x.kind === "mock" && x.day === "2026-11-12"));
  assert.ok(p.days.every((x) => x.day < "2026-11-14"));
  const days = new Set(p.days.filter((x) => x.kind === "learn" && x.topic_id === "weak").map((x) => x.day));
  assert.ok(days.size >= 4, "weak topic is interleaved across days, not crammed");
  assert.equal(E.studyPlan({ topics, today: d("2026-11-14"), examDate: d("2026-11-14") }).days.length, 0);
});

test("GPA: Nigerian scale, class bands, first-class target", () => {
  assert.deepEqual(E.gradeFor(70), { grade: "A", points: 5 });
  assert.deepEqual(E.gradeFor(44.9), { grade: "E", points: 1 });
  const c = E.cgpa([{ units: 3, score: 75 }, { units: 3, score: 65 }, { units: 2, score: 55 }]);
  assert.equal(c.cgpa, 4.13);
  assert.equal(E.degreeClass(4.5), "First Class"); assert.equal(E.degreeClass(3.49), "Second Class Lower");
  const t = E.targetPlanner({ doneUnits: 60, donePoints: 258, remainingUnits: 60, target: 4.5 });
  assert.equal(t.requiredGpa, 4.7); assert.equal(t.feasible, true); assert.equal(t.aShareIfRestB, 0.7);
  assert.equal(E.targetPlanner({ doneUnits: 60, donePoints: 150, remainingUnits: 20, target: 4.5 }).feasible, false);
});

test("streak: today optional, gap resets", () => {
  const s = E.streak(["2026-11-01", "2026-11-02", "2026-11-03", "2026-10-20", "2026-10-21"], d("2026-11-04"));
  assert.deepEqual(s, { current: 3, longest: 3 });
  assert.equal(E.streak(["2026-11-01"], d("2026-11-04")).current, 0);
});

test("mistakes: overconfidence and time pressure are separated", () => {
  const mk = (o) => ({ q_type: "mcq", max: 1, time_spent_seconds: 40, ...o });
  const { summary } = E.classifyMistakes([
    mk({ position: 1, score: 0, response: "A", confidence: "sure" }),                       // overconfident
    mk({ position: 2, score: 0, response: "" }),                                            // skipped (early)
    mk({ position: 3, score: 0, response: "B", confidence: "unsure" }),                     // knowledge gap
    mk({ position: 4, score: 1, response: "B" }),                                           // correct
    mk({ position: 5, score: 0, response: "C", confidence: "unsure", time_spent_seconds: 5 }), // rushed MCQ
    mk({ position: 6, score: 0, response: "" }),                                            // blank at the end
  ]);
  assert.deepEqual(summary, { overconfident: 1, skipped: 1, knowledge_gap: 1, careless: 1, time_pressure: 1 });
});

test("flashcards from notes, no AI", () => {
  const text = "Glomerular filtration rate is the volume of plasma filtered by the glomeruli per minute. The nephron regulates reabsorption of sodium along the proximal tubule segment.";
  const defs = E.definitionCards(text);
  assert.equal(defs.length, 1); assert.match(defs[0].front, /Glomerular filtration rate/);
  const cl = E.clozeCards(text);
  assert.ok(cl.length >= 1 && cl[0].front.includes("_____"));
});

test("retrieval ranks by cosine similarity", () => {
  const chunks = [{ id: "x", embedding: [1, 0] }, { id: "y", embedding: [0.9, 0.1] }, { id: "z", embedding: [0, 1] }];
  assert.deepEqual(E.topChunks([1, 0], chunks, { k: 2 }).map((c) => c.id), ["x", "y"]);
});

test("gateway: cache hit skips AI, quota moves to next provider, fallback when all fail", async () => {
  const store = new Map(), use = new Map(); let calls = 0;
  const cache = { get: async (k) => store.get(k), set: async (k, _kind, v) => store.set(k, v) };
  const usage = { get: async (d, p) => use.get(d + p) || 0, incr: async (d, p) => use.set(d + p, (use.get(d + p) || 0) + 1) };
  const providers = [
    { name: "groq", dailyLimit: 1, call: async () => (calls++, "from-groq") },
    { name: "openrouter", dailyLimit: 5, call: async () => (calls++, "from-or") },
  ];
  const ask = E.makeGateway({ cache, usage, providers, now: () => d("2026-11-04") });
  assert.equal((await ask({ kind: "explanation", input: { q: 1 }, prompt: "p" })).value, "from-groq");
  const again = await ask({ kind: "explanation", input: { q: 1 }, prompt: "p" });
  assert.equal(again.cached, true); assert.equal(calls, 1);
  assert.equal((await ask({ kind: "explanation", input: { q: 2 }, prompt: "p" })).provider, "openrouter");
  const down = E.makeGateway({ cache, usage, providers: [{ name: "x", dailyLimit: 9, call: async () => { throw new Error("429"); } }] });
  assert.equal((await down({ kind: "k", input: 1, prompt: "p", fallback: "basic" })).degraded, true);
  await assert.rejects(down({ kind: "k", input: 2, prompt: "p" }), /AI_UNAVAILABLE/);
});
