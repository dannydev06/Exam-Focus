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
