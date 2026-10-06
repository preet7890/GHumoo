require("dotenv").config();
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const SECRET = process.env.JWT_SECRET;
if (!SECRET || !process.env.DATABASE_URL) {
  console.error("Set JWT_SECRET and DATABASE_URL in .env (see .env.example).");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Database (Postgres, e.g. free Neon) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});
const q = (sql, params) => pool.query(sql, params);

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS trips (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    destination TEXT NOT NULL,
    budget NUMERIC NOT NULL,
    currency TEXT NOT NULL,
    days INT NOT NULL,
    plan JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now())`);
}

// ---------- Auth ----------
function setSession(req, res, user) {
  const token = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: "7d" });
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 7 * 864e5 });
}
function auth(req, res, next) {
  try { req.user = jwt.verify(req.cookies.token, SECRET); next(); }
  catch { res.status(401).json({ error: "Please log in." }); }
}

app.post("/api/register", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await q("INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email", [email, hash]);
    setSession(req, res, r.rows[0]);
    res.status(201).json({ email });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That email already has an account. Log in instead." });
    console.error(e); res.status(500).json({ error: "Could not create the account." });
  }
});

app.post("/api/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const r = await q("SELECT * FROM users WHERE email = $1", [email]);
  const user = r.rows[0];
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash))) {
    return res.status(401).json({ error: "Wrong email or password." });
  }
  setSession(req, res, user);
  res.json({ email: user.email });
});

app.post("/api/logout", (_req, res) => { res.clearCookie("token"); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => res.json({ email: req.user.email }));

// ---------- Live data (free, no keys): Open-Meteo weather + Frankfurter exchange rates ----------
const getJSON = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(r.status);
  return r.json();
};

async function liveData(destination, currency, convertTo) {
  const live = {};
  try {
    const name = encodeURIComponent(destination.split(",")[0].trim());
    const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${name}&count=1`);
    const p = g.results && g.results[0];
    if (p) {
      const w = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7`);
      live.place = [p.name, p.country].filter(Boolean).join(", ");
      live.weather = w.daily.time.map((t, i) => ({
        date: t, max: w.daily.temperature_2m_max[i], min: w.daily.temperature_2m_min[i],
        rain: w.daily.precipitation_probability_max[i],
      }));
    }
  } catch {}
  try {
    if (convertTo && convertTo !== currency) {
      const f = await getJSON(`https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=${convertTo}`);
      live.rate = { from: currency, to: convertTo, value: f.rates[convertTo] };
    }
  } catch {}
  return live;
}

// ---------- AI generation (any OpenAI-compatible provider) ----------
const SCHEMA = `{
  "destination": "string",
  "summary": "1-2 sentence overview",
  "totalEstimatedCost": number,
  "budgetBreakdown": { "stay": number, "food": number, "activities": number, "transport": number },
  "places": [ { "name": "string", "description": "string" } ],
  "restaurants": [ { "name": "string", "cuisine": "string", "priceRange": "string" } ],
  "days": [
    {
      "day": number,
      "theme": "string",
      "activities": [ { "time": "9:00 AM", "place": "string", "description": "string", "cost": number } ],
      "meals": [ { "meal": "breakfast|lunch|dinner", "restaurant": "string", "cost": number } ]
    }
  ],
  "tips": ["string"]
}`;

async function generatePlan({ destination, budget, currency, days, interests }) {
  const prompt = `Plan a ${days}-day trip to ${destination}.
Total budget: ${budget} ${currency} (the whole trip, per person). Keep totalEstimatedCost within it.
Interests: ${interests || "general sightseeing"}.
Use real, well-known places and restaurants. All costs in ${currency}.
Respond with ONLY valid JSON (no markdown, no commentary) matching this shape:
${SCHEMA}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${process.env.AI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AI_API_KEY}` },
        body: JSON.stringify({ model: process.env.MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) throw new Error(`AI request failed (${res.status})`);
      const data = await res.json();
      const text = data.choices[0].message.content;
      return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch (e) {
      if (attempt === 1) throw e; // retry once: free models sometimes return broken JSON
    }
  }
}

// Simple per-user limit so free AI quotas aren't burned: 10 trips per hour
const hits = new Map();
function allowed(userId) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter((t) => now - t < 36e5);
  if (recent.length >= 10) return false;
  hits.set(userId, [...recent, now]);
  return true;
}

app.post("/api/generate", auth, async (req, res) => {
  const { destination, budget, days, interests } = req.body;
  const currency = /^[A-Z]{3}$/.test(req.body.currency) ? req.body.currency : "INR";
  const convertTo = /^[A-Z]{3}$/.test(req.body.convertTo) ? req.body.convertTo : "";
  const nDays = Number(days), nBudget = Number(budget);
  if (!destination?.trim() || !(nBudget > 0) || !(nDays >= 1 && nDays <= 14)) {
    return res.status(400).json({ error: "Enter a destination, a budget above 0, and 1-14 days." });
  }
  if (!process.env.AI_API_KEY) return res.status(500).json({ error: "Server is missing AI_API_KEY." });
  if (!allowed(req.user.id)) return res.status(429).json({ error: "Limit reached: 10 trips per hour. Try again later." });
  try {
    const dest = destination.trim().slice(0, 100);
    const [plan, live] = await Promise.all([
      generatePlan({ destination: dest, budget: nBudget, currency, days: nDays, interests: String(interests || "").slice(0, 200) }),
      liveData(dest, currency, convertTo),
    ]);
    plan.live = live;
    res.json({ plan, meta: { destination: dest, budget: nBudget, currency, days: nDays } });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "Could not generate the trip. Try again." });
  }
});

// ---------- Trips (each user sees only their own) ----------
app.get("/api/trips", auth, async (req, res) => {
  const r = await q("SELECT id, destination, budget, currency, days, created_at FROM trips WHERE user_id = $1 ORDER BY id DESC", [req.user.id]);
  res.json(r.rows);
});

app.get("/api/trips/:id", auth, async (req, res) => {
  const r = await q("SELECT * FROM trips WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Trip not found." });
  res.json(r.rows[0]);
});

app.post("/api/trips", auth, async (req, res) => {
  const { plan, meta } = req.body;
  if (!plan || !meta?.destination) return res.status(400).json({ error: "Nothing to save." });
  const r = await q(
    "INSERT INTO trips (user_id, destination, budget, currency, days, plan) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [req.user.id, meta.destination, meta.budget, meta.currency, meta.days, JSON.stringify(plan)]
  );
  res.status(201).json({ id: r.rows[0].id });
});

app.delete("/api/trips/:id", auth, async (req, res) => {
  await q("DELETE FROM trips WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
init()
  .then(() => app.listen(port, () => console.log(`Travel planner running at http://localhost:${port}`)))
  .catch((e) => { console.error("Database setup failed:", e.message); process.exit(1); });
