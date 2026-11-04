import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db } from "./lib.js";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "exam_focus_session";
const SESSION_DAYS = 30;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    await scrypt(password, "exam-focus-invalid-account", 64);
    return false;
  }
  const [algorithm, saltHex, keyHex] = stored.split("$");
  if (algorithm !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
  };
}

function sessionToken(req: any): string | undefined {
  const cookies = String(req.headers.cookie ?? "").split(";");
  const value = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return value?.slice(SESSION_COOKIE.length + 1);
}

async function createSession(userId: string, res: any) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO app_sessions (token_hash, user_id, expires_at)
     VALUES ($1,$2,now()+($3::int * interval '1 day'))`,
    [hashToken(token), userId, SESSION_DAYS]);
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 });
}

export async function ensureTenantSchema() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text`);
    await client.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE CASCADE`);
    await client.query(`ALTER TABLE lecturers ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE CASCADE`);
    await client.query(`CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions(expires_at)`);

    await client.query(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM (
          SELECT course_id, user_id FROM documents
          UNION
          SELECT e.course_id, e.user_id FROM exams e
        ) owners GROUP BY course_id HAVING count(DISTINCT user_id)>1
      ) THEN
        RAISE EXCEPTION 'Tenant migration stopped: a course has records belonging to multiple users; separate those records before retrying.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM documents WHERE lecturer_id IS NOT NULL
        GROUP BY lecturer_id HAVING count(DISTINCT user_id)>1
      ) THEN
        RAISE EXCEPTION 'Tenant migration stopped: a lecturer has records belonging to multiple users; separate those records before retrying.';
      END IF;
    END $$`);

    await client.query(`UPDATE courses c SET owner_id=COALESCE(
      (SELECT min(d.user_id::text)::uuid FROM documents d WHERE d.course_id=c.id),
      (SELECT min(e.user_id::text)::uuid FROM exams e WHERE e.course_id=c.id),
      (SELECT id FROM users ORDER BY created_at, id LIMIT 1))
      WHERE c.owner_id IS NULL`);
    await client.query(`UPDATE lecturers l SET owner_id=COALESCE(
      (SELECT min(d.user_id::text)::uuid FROM documents d WHERE d.lecturer_id=l.id),
      (SELECT id FROM users ORDER BY created_at, id LIMIT 1))
      WHERE l.owner_id IS NULL`);
    await client.query(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM courses WHERE owner_id IS NULL)
         OR EXISTS (SELECT 1 FROM lecturers WHERE owner_id IS NULL) THEN
        RAISE EXCEPTION 'Tenant migration requires at least one existing user to assign legacy records.';
      END IF;
    END $$`);
    await client.query(`ALTER TABLE courses ALTER COLUMN owner_id SET NOT NULL`);
    await client.query(`ALTER TABLE lecturers ALTER COLUMN owner_id SET NOT NULL`);

    await client.query(`DO $$
    DECLARE constraint_name text;
    BEGIN
      FOR constraint_name IN
        SELECT conname FROM pg_constraint
        WHERE conrelid='courses'::regclass AND contype='u'
          AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='courses'::regclass AND attname='code')]::smallint[]
      LOOP
        EXECUTE format('ALTER TABLE courses DROP CONSTRAINT %I', constraint_name);
      END LOOP;
    END $$`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS courses_owner_code_unique ON courses(owner_id,code)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS lecturers_owner_name_unique ON lecturers(owner_id,lower(name))`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users(lower(email))`);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export function authRoutes(app: any, h: any) {
  app.post("/auth/signup", h(async (req: any, res: any) => {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const name = String(req.body.name ?? "").trim();
    const password = String(req.body.password ?? "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      return res.status(400).json({ error: "Enter a valid email address." });
    if (!name || name.length > 80)
      return res.status(400).json({ error: "Enter a name up to 80 characters." });
    if (password.length < 10 || password.length > 128)
      return res.status(400).json({ error: "Use a password between 10 and 128 characters." });

    try {
      const passwordHash = await hashPassword(password);
      const { rows: [user] } = await db.query(
        `INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id,email,name`,
        [email, name, passwordHash]);
      await createSession(user.id, res);
      res.status(201).json(user);
    } catch (e: any) {
      if (e.code === "23505") return res.status(409).json({ error: "An account with that email already exists." });
      throw e;
    }
  }));

  app.post("/auth/login", h(async (req: any, res: any) => {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    const { rows: [user] } = await db.query(
      `SELECT id,email,name,password_hash FROM users WHERE lower(email)=$1`, [email]);
    if (!await verifyPassword(password, user?.password_hash ?? null))
      return res.status(401).json({ error: "Email or password is incorrect." });
    await createSession(user.id, res);
    res.json({ id: user.id, email: user.email, name: user.name });
  }));

  app.post("/auth/logout", h(async (req: any, res: any) => {
    const token = sessionToken(req);
    if (token) await db.query(`DELETE FROM app_sessions WHERE token_hash=$1`, [hashToken(token)]);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.json({ ok: true });
  }));
}

export async function authenticate(req: any, res: any, next: any) {
  try {
    const token = sessionToken(req);
    if (!token) return res.status(401).json({ error: "Sign in to continue." });
    const { rows: [session] } = await db.query(
      `SELECT user_id FROM app_sessions WHERE token_hash=$1 AND expires_at>now()`, [hashToken(token)]);
    if (!session) {
      res.clearCookie(SESSION_COOKIE, cookieOptions());
      return res.status(401).json({ error: "Your session expired. Please sign in again." });
    }
    req.userId = session.user_id;
    next();
  } catch (e) {
    next(e);
  }
}

export function requireSameOrigin(req: any, res: any, next: any) {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host.toLowerCase() !== String(req.get("host")).toLowerCase())
          return res.status(403).json({ error: "Cross-origin requests are not allowed." });
      } catch {
        return res.status(403).json({ error: "Invalid request origin." });
      }
    }
    if (req.get("sec-fetch-site") === "cross-site")
      return res.status(403).json({ error: "Cross-site requests are not allowed." });
  }
  next();
}
