import { db } from "./lib.js";
import { csv } from "./csv.js";

export async function ensureFeedbackSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS user_feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS user_feedback_created_at ON user_feedback (created_at DESC)`);
}

function requireAdmin(req: any, res: any): boolean {
  const adminUserId = process.env.ADMIN_USER_ID?.trim();
  if (!adminUserId || req.userId !== adminUserId) {
    res.status(403).json({ error: "Admin access is not enabled for this account." });
    return false;
  }
  return true;
}

function sendCsv(res: any, filename: string, rows: unknown[][]) {
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  }).send(csv(rows));
}

export function feedbackRoutes(app: any, h: any, uid: (req: any) => string) {
  app.post("/feedback", h(async (req: any, res: any) => {
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!message) return res.status(400).json({ error: "Please enter your feedback." });
    if (message.length > 5000) return res.status(400).json({ error: "Feedback must be 5,000 characters or fewer." });
    await db.query(`INSERT INTO user_feedback (user_id, message) VALUES ($1,$2)`, [uid(req), message]);
    res.status(201).json({ ok: true });
  }));

  app.get("/admin/users.csv", h(async (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    const { rows } = await db.query(`SELECT email, name, created_at FROM users ORDER BY created_at, id`);
    sendCsv(res, "exam-focus-users.csv", [["email", "name", "created_at"], ...rows.map((r: any) => [r.email, r.name, r.created_at])]);
  }));

  app.get("/admin/feedback.csv", h(async (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    const { rows } = await db.query(
      `SELECT u.email, u.name, f.message, f.created_at
       FROM user_feedback f JOIN users u ON u.id=f.user_id
       ORDER BY f.created_at DESC, f.id`);
    sendCsv(res, "exam-focus-feedback.csv", [["email", "name", "message", "created_at"], ...rows.map((r: any) => [r.email, r.name, r.message, r.created_at])]);
  }));
}
