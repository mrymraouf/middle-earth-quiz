import "dotenv/config";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";

const { Pool } = pg;
const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const questions = JSON.parse(fs.readFileSync(new URL("./questions.json", import.meta.url), "utf8"));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!process.env.DATABASE_URL || !ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error("Set DATABASE_URL, ADMIN_PASSWORD and SESSION_SECRET environment variables.");
  process.exit(1);
}

await pool.query(`
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  faction TEXT NOT NULL,
  h_score INTEGER NOT NULL,
  u_score INTEGER NOT NULL,
  question_ids JSONB NOT NULL
)`);

app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static("public"));

const shuffle = a => [...a].sort(() => Math.random() - 0.5);
const admin = (req, res, next) => req.session?.admin ? next() : res.status(401).json({ error: "unauthorized" });

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/quiz", (req, res) => {
  const selected = shuffle(questions).slice(0, 5).map(q => ({
    id: q.id, text: q.text, options: q.options.map((o, index) => ({ index, text: o.text }))
  }));
  const token = crypto.randomUUID();
  req.session.quiz = { ...req.session.quiz, [token]: selected.map(q => q.id) };
  res.json({ token, questions: selected });
});

app.post("/api/submit", async (req, res) => {
  const { token, answers } = req.body || {};
  const ids = req.session.quiz?.[token];
  if (!ids || !Array.isArray(answers) || answers.length !== 5) {
    return res.status(400).json({ error: "آزمون معتبر نیست یا قبلاً ارسال شده است." });
  }

  const answerMap = new Map(answers.map(a => [Number(a.id), Number(a.option)]));
  if (ids.some(id => !Number.isInteger(answerMap.get(id)) || answerMap.get(id) < 0 || answerMap.get(id) > 3) ||
      answerMap.size !== 5 || ids.some(id => !answerMap.has(id))) {
    return res.status(400).json({ error: "لطفاً به همه سؤال‌ها پاسخ بده." });
  }

  let h = 0, u = 0;
  for (const qid of ids) {
    const q = questions.find(x => x.id === qid);
    const option = q.options[answerMap.get(qid)];
    h += option.h;
    u += option.u;
  }

  // h is the hidden Heirs score out of 10. Probability is applied only when counts are tied.
  const heirsProbability = h >= 9 ? 1 : h >= 6 ? 0.7 : h === 5 ? 0.5 : 0.3;
  const participantId = crypto.randomUUID();
  const client = await pool.connect();
  let faction;

  try {
    await client.query("BEGIN");
    // Serialize assignments so simultaneous requests cannot break the balance rule.
    await client.query("SELECT pg_advisory_xact_lock(724202611)");
    const counts = await client.query(
      "SELECT faction, COUNT(*)::int AS n FROM participants GROUP BY faction"
    );
    const hc = counts.rows.find(x => x.faction === "وارثان")?.n || 0;
    const uc = counts.rows.find(x => x.faction === "اوروک‌ها")?.n || 0;

    if (hc > uc) faction = "اوروک‌ها";
    else if (uc > hc) faction = "وارثان";
    else faction = Math.random() < heirsProbability ? "وارثان" : "اوروک‌ها";

    await client.query(
      "INSERT INTO participants (id, created_at, faction, h_score, u_score, question_ids) VALUES ($1, NOW(), $2, $3, $4, $5::jsonb)",
      [participantId, faction, h, u, JSON.stringify(ids)]
    );
    await client.query("COMMIT");
    delete req.session.quiz[token];
    res.json({
      faction,
      message: faction === "وارثان"
        ? "راهت به سوی میراث و اتحاد گشوده شد."
        : "قدرت و اراده‌ات تو را به صف اوروک‌ها فراخوانده است."
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Assignment failed:", error);
    res.status(500).json({ error: "ثبت نتیجه با مشکل روبه‌رو شد. دوباره تلاش کن." });
  } finally {
    client.release();
  }
});

app.post("/api/admin/login", (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "رمز عبور نادرست است." });
  req.session.admin = true;
  res.json({ ok: true });
});
app.post("/api/admin/logout", admin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get("/api/admin/results", admin, async (_req, res) => {
  const result = await pool.query("SELECT id, created_at, faction, h_score, u_score FROM participants ORDER BY created_at DESC");
  const rows = result.rows;
  const heirs = rows.filter(x => x.faction === "وارثان").length;
  res.json({ total: rows.length, heirs, uruks: rows.length - heirs, rows });
});
app.get("/api/admin/export", admin, async (_req, res) => {
  const result = await pool.query("SELECT id, created_at, faction, h_score, u_score FROM participants ORDER BY created_at");
  const quote = value => '"' + String(value ?? "").replaceAll('"', '""') + '"';
  const csv = [
    ["شناسه", "زمان ثبت", "جبهه", "امتیاز وارثان", "امتیاز اوروک‌ها"].map(quote).join(","),
    ...result.rows.map(r => [r.id, r.created_at.toISOString(), r.faction, r.h_score, r.u_score].map(quote).join(","))
  ].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="middle-earth-results.csv"');
  res.send("\uFEFF" + csv);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Quiz running on port ${port}`));
