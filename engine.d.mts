export type ExamBankQuestion = {
  id: string;
  q_type: string;
  topic_id: string | null;
  cognitive?: string | null;
  text?: string;
};

export function buildExam(options: {
  pool: ExamBankQuestion[];
  typeMix?: Record<string, number>;
  difficulty?: string;
  count?: number;
  topicWeights?: Record<string, number>;
  focus?: string[] | null;
  seed?: number;
}): { picked: ExamBankQuestion[]; gaps: { q_type: string; topic_id: string | null }[]; aiShare: number };

export function bankerTopics(
  rows: { topic_id: string; year?: number | null; n?: number; marks?: number }[],
  options?: { halfLifeYears?: number },
): { topic_id: string; share: number; [key: string]: unknown }[];

export function topChunks<T extends { embedding: number[] }>(
  queryEmbedding: number[],
  chunks: T[],
  options?: { k?: number; minSim?: number },
): (T & { sim: number })[];

export function markAnswer(
  question: { q_type: string; answer?: string | null; marks: number | string },
  response: string,
): { score: number; needsAI: boolean; markedBy: "algorithm" };

export function classifyMistakes<T extends {
  position: number;
  score: number;
  max: number;
  response?: string | null;
  confidence?: "sure" | "unsure" | "guess";
  time_spent_seconds?: number;
  q_type: string;
}>(answers: T[]): { answers: (T & { error_type: string | null })[]; summary: Record<string, number> };

export function readiness<T extends {
  topic_id: string;
  title: string;
  weight?: number;
  earned?: number;
  possible?: number;
  last_seen?: Date | string | null;
}>(topics: T[]): { score: number; label: string; topics: (T & { mastery: number; status: string })[] };

export function streak(days: (Date | string)[], today?: Date): { current: number; longest: number };

export function examTerms(questions: { text?: string; marks?: number }[]): Map<string, number>;
export function scoreSentences(text: string, options: { terms: Map<string, number> }): {
  index: number; text: string; score: number; matched: string[]; kind: string | null; level: "high" | "medium" | null;
}[];
export function extractiveSummary(text: string, options: { terms: Map<string, number>; max?: number }): string[];
export function howAsked(rows: {
  document_id?: string; year?: number | null; command_verb?: string | null; marks?: number | null; q_type?: string | null;
}[], options?: { papers?: number | null }): {
  askedInPapers: number; ofPapers: number | null; verbs: { command_verb: string; n: number }[];
  avgMarks: number | null; typicalType: string | null; years: number[]; guide: string | null;
};
export function readingQueue<T extends {
  topic_id: string; title: string; share?: number; tier?: string; mastery?: number; readFraction?: number;
}>(topics: T[]): (T & { priority: number; reason: string })[];
