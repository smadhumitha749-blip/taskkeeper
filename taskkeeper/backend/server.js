// Task Keeper backend — v2
// Express + JSON-file or MongoDB storage, hardened with security headers, rate
// limiting and strict input validation. Adds Web Push (VAPID) so reminders
// reach the phone/desktop even when the browser tab is closed, plus a
// built-in scheduler that pushes notifications at each reminder time while the
// server is running.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const webpush = require("web-push");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const PORT = process.env.PORT || 4000;
// Keep data outside the application directory when a host provides a durable
// mount (Render, Docker, etc.).  Local development keeps using backend/data.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const DATA_FILE = path.join(DATA_DIR, "tasks.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SECRET_FILE = path.join(DATA_DIR, "secret.json");
const SESSION_COOKIE = "tk_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const VAPID_FILE = path.join(DATA_DIR, "vapid.json");
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

// Optional MongoDB backend (recommended for hosted deploys). When MONGODB_URI
// is set, all data (tasks, users, push subscriptions, VAPID/session keys) is
// stored in the managed database — durable and secure — instead of local JSON
// files. Hosts like Render's free tier wipe the local filesystem whenever the
// instance restarts or redeploys, so local files are only safe for local
// development or when mounted on a persistent disk.
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "";
const USE_MONGO = MONGO_URI.length > 0;
const MONGO_DB_NAME =
  process.env.MONGODB_DB ||
  (() => {
    try {
      // Prefer the database name embedded in the connection string.
      return new URL(MONGO_URI).pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    } catch (err) {
      return "";
    }
  })() ||
  "taskkeeper";
const MAX_SUBSCRIPTIONS = Number(process.env.MAX_SUBSCRIPTIONS || 1000);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // for rate limiting behind a reverse proxy

// ---------- security middleware ----------

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(cors({ origin: [/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/], credentials: true }));
app.use(express.json({ limit: "100kb" }));

// Loose API-wide limiter + a strict one for subscription writes.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please try again in a minute." },
});
const subscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many subscription changes — please wait a minute." },
});

// Small request log (method, url, status, duration).
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use("/api", apiLimiter);

// ---------- storage helpers ----------
//
// Two interchangeable backends behind the same interface:
//   • MongoDB (managed, durable) — used when MONGODB_URI is set. Every task,
//     user, and push subscription is stored as its own document, so data
//     survives restarts, redeploys and instance changes on any host.
//   • JSON files in backend/data — used when MONGODB_URI is unset (local dev).
//
// All read/write helpers are async: the Mongo driver is asynchronous and the
// same call sites are shared by both backends.

let db = null; // connected Mongo database handle (null in JSON-file mode)

function ensureJsonStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");
  if (!fs.existsSync(SUBS_FILE)) fs.writeFileSync(SUBS_FILE, "[]", "utf8");
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf8");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8") || "[]");
  } catch (err) {
    console.error(`Failed to read ${file}, starting fresh:`, err);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureJsonStore();
  // Write-then-rename prevents a partially written JSON file if the process is
  // interrupted while saving a task.
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempFile, file);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

// Mongo documents carry a driver-owned `_id`; drop it so API responses (and
// the rest of the app) only ever see the plain objects the JSON store had.
const stripId = (doc) => {
  if (doc && doc._id) delete doc._id;
  return doc;
};

async function connectMongo() {
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    // Atlas (`mongodb+srv://`) always uses TLS. For self-hosted servers you can
    // force it with MONGODB_TLS=true.
    tls: process.env.MONGODB_TLS ? process.env.MONGODB_TLS !== "false" : MONGO_URI.startsWith("mongodb+srv://"),
  });
  await client.connect();
  db = client.db(MONGO_DB_NAME);
  // Indexes keep the most common queries fast and enforce the same uniqueness
  // the app already relies on (one account per email, one task per id).
  await db.collection("tasks").createIndex({ owner: 1, date: 1 });
  await db.collection("tasks").createIndex({ id: 1 }, { unique: true });
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("subscriptions").createIndex({ endpoint: 1 });
  console.log(`MongoDB connected (database "${MONGO_DB_NAME}").`);
}

// Verify the active store is reachable. Used at boot and by /api/health.
async function ensureStore() {
  if (USE_MONGO) {
    if (!db) throw new Error("MongoDB is not connected");
    await db.command({ ping: 1 });
    return;
  }
  ensureJsonStore();
}

// Replace a whole collection's documents with `docs`, mirroring the
// "load all, mutate, save all" semantics of the JSON-file store. Documents are
// keyed by `idField` (id / endpoint), so updated docs are $set and anything
// removed in memory is deleted.
async function replaceAll(collName, docs, idField) {
  const coll = db.collection(collName);
  const ids = docs.map((d) => d[idField]);
  const ops = docs.map((d) => ({
    updateOne: {
      filter: { [idField]: d[idField] },
      update: { $set: d },
      upsert: true,
    },
  }));
  if (ids.length === 0) {
    await coll.deleteMany({});
  } else {
    await coll.deleteMany({ [idField]: { $nin: ids } });
  }
  if (ops.length) await coll.bulkWrite(ops, { ordered: false });
}

async function readTasks() {
  if (USE_MONGO) {
    if (!db) throw new Error("MongoDB is not connected yet");
    return (await db.collection("tasks").find({}).toArray()).map(stripId);
  }
  return readJson(DATA_FILE, []);
}

// Tasks are private per account: only the user identified by `userId` (the
// task's owner) can see or change them.
async function tasksForUser(userId) {
  return (await readTasks()).filter((t) => t.owner === userId);
}

async function writeTasks(tasks) {
  if (USE_MONGO) return replaceAll("tasks", tasks, "id");
  writeJson(DATA_FILE, tasks);
}

async function readSubs() {
  if (USE_MONGO) {
    if (!db) throw new Error("MongoDB is not connected yet");
    return (await db.collection("subscriptions").find({}).toArray()).map(stripId);
  }
  return readJson(SUBS_FILE, []);
}

async function writeSubs(subs) {
  if (USE_MONGO) return replaceAll("subscriptions", subs, "endpoint");
  writeJson(SUBS_FILE, subs);
}

async function readUsers() {
  if (USE_MONGO) {
    if (!db) throw new Error("MongoDB is not connected yet");
    return (await db.collection("users").find({}).toArray()).map(stripId);
  }
  return readJson(USERS_FILE, []);
}

async function writeUsers(users) {
  if (USE_MONGO) return replaceAll("users", users, "id");
  writeJson(USERS_FILE, users);
}

// One-time migration: if the Mongo database is empty but the local JSON files
// contain data (an existing local install or a paid Render disk), copy them
// over so nothing is silently left behind.
async function migrateJsonOnce() {
  if (!USE_MONGO) return;
  const hasTasks = (await db.collection("tasks").countDocuments({})) > 0;
  if (hasTasks) return;
  const jsonTasks = readJson(DATA_FILE, []);
  const jsonUsers = readJson(USERS_FILE, []);
  const jsonSubs = readJson(SUBS_FILE, []);
  if (!jsonTasks.length && !jsonUsers.length && !jsonSubs.length) return;
  if (jsonTasks.length) await writeTasks(jsonTasks);
  if (jsonUsers.length) await writeUsers(jsonUsers);
  if (jsonSubs.length) await writeSubs(jsonSubs);
  console.log(
    `Imported existing local data into MongoDB: ${jsonTasks.length} task(s), ${jsonUsers.length} user(s), ${jsonSubs.length} subscription(s).`
  );
}

// Sessions use a signing secret that is generated once and persisted in the
// durable store (MongoDB `meta` collection, or data/secret.json), so existing
// sessions survive server restarts. Set SESSION_SECRET in the environment to
// pin a fixed value instead. Populated during boot() before listen().
let SESSION_SECRET = "";

async function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (USE_MONGO) {
    const doc = await db.collection("meta").findOne({ _id: "sessionSecret" }, { projection: { value: 1, _id: 0 } });
    if (doc && typeof doc.value === "string" && doc.value.length >= 32) return doc.value;
    const secret = crypto.randomBytes(32).toString("hex");
    // $setOnInsert makes concurrent boots generate the same value.
    await db.collection("meta").updateOne(
      { _id: "sessionSecret" },
      { $setOnInsert: { value: secret } },
      { upsert: true }
    );
    return secret;
  }
  try {
    const existing = readJson(SECRET_FILE, null);
    if (typeof existing === "string" && existing.length >= 32) return existing;
  } catch (err) {
    /* fall through and generate a fresh secret */
  }
  const secret = crypto.randomBytes(32).toString("hex");
  writeJson(SECRET_FILE, secret);
  return secret;
}

// ---------- VAPID keys (Web Push) ----------

let vapidKeys = null; // filled during boot() from env / durable store

async function initVapidKeys() {
  // 1. Environment variables win (great for hosted platforms).
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    return;
  }
  // 2. Otherwise reuse or generate a keypair and persist it durably.
  if (USE_MONGO) {
    const doc = await db.collection("meta").findOne({ _id: "vapid" }, { projection: { value: 1, _id: 0 } });
    if (doc && doc.value && doc.value.publicKey && doc.value.privateKey) {
      vapidKeys = doc.value;
      return;
    }
    const keys = webpush.generateVAPIDKeys();
    await db.collection("meta").updateOne({ _id: "vapid" }, { $setOnInsert: { value: keys } }, { upsert: true });
    vapidKeys = keys;
    return;
  }
  if (fs.existsSync(VAPID_FILE)) {
    try {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
      return;
    } catch (err) {
      /* fall through and regenerate */
    }
  }
  const keys = webpush.generateVAPIDKeys();
  ensureJsonStore();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), "utf8");
  vapidKeys = keys;
  console.log("Generated new VAPID keys for Web Push (saved to backend/data/vapid.json).");
}

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || "mailto:taskkeeper@" + (require("os").hostname() || "localhost");

// ---------- auth: accounts & sessions ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user) {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch (err) {
      out[key] = raw;
    }
  }
  return out;
}

async function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    const users = await readUsers();
    return users.find((u) => u.id === payload.sub) || null;
  } catch (err) {
    return null;
  }
}

// Protect a route: 401 unless a valid session cookie is present. The signed-in
// user is attached as req.user so task routes can scope data to that account.
async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Please sign in to continue." });
    req.user = user;
    next();
  } catch (err) {
    console.error("Auth storage error:", err && err.message ? err.message : err);
    return res.status(503).json({ error: "Storage is unavailable. Please try again shortly." });
  }
}

// Wrap an async route handler so a storage failure always returns a clean JSON
// error instead of hanging the request (Express 4 does not await async throws).
const asyncRoute = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error("Request error:", err && err.stack ? err.stack : err);
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: "The server could not save your changes. Please try again." });
  });
};

function setSessionCookie(res, userId) {
  const token = jwt.sign({ sub: userId }, SESSION_SECRET, { expiresIn: "30d" });
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
}

function clearSessionCookie(res) {
  const opts = { ...sessionCookieOptions() };
  delete opts.maxAge;
  res.clearCookie(SESSION_COOKIE, opts);
}

// ---------- validation & time helpers ----------

function isValidDate(str) {
  return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function isValidTime(str) {
  return typeof str === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(str);
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function to12h(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hhmmNow() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function computeReminders(startTime, endTime) {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (end <= start) return [];
  const midpoint = start + Math.floor((end - start) / 2);
  const reminders = [];
  for (let t = midpoint; t <= end; t += 15) {
    const h = String(Math.floor(t / 60)).padStart(2, "0");
    const m = String(t % 60).padStart(2, "0");
    reminders.push(`${h}:${m}`);
  }
  if (reminders.length === 0) reminders.push(startTime);
  return reminders;
}

function sanitizeNotes(notes) {
  return typeof notes === "string" ? notes.slice(0, 1000).trim() : "";
}

// ---------- task model: time / snooze / repeat ----------

const SNOOZE_OPTIONS = new Set([0, 2, 3, 5, 10]);
const REPEAT_MODES = new Set(["none", "daily", "weekly"]);
// How many future instances a repeating task gets materialized into.
const REPEAT_FORWARD_DAILY = Number(process.env.REPEAT_DAILY_DAYS || 60);
const REPEAT_FORWARD_WEEKLY = Number(process.env.REPEAT_WEEKLY_WEEKS || 13);

// Tasks with a single `time` get a reminder at that time. If an "early
// reminder" is set (snoozeMinutes) they also get one that many minutes BEFORE
// the event time, so options read "Remind 2/3/5/10 min early". Range tasks keep
// the old midpoint rule; checklist-only items have no reminders.
function remindersForTask(time, startTime, endTime, snoozeMinutes) {
  if (time && isValidTime(time)) {
    const list = [];
    const early = Number(snoozeMinutes) || 0;
    if (early > 0 && SNOOZE_OPTIONS.has(early)) {
      const t = toMinutes(time) - early;
      if (t >= 0) {
        const h = String(Math.floor(t / 60)).padStart(2, "0");
        const m = String(t % 60).padStart(2, "0");
        list.push(`${h}:${m}`);
      }
    }
    list.push(time);
    return list;
  }
  if (isValidTime(startTime) && isValidTime(endTime)) {
    return computeReminders(startTime, endTime);
  }
  return []; // no time set — checklist-only item
}

function buildTask(fields) {
  const task = {
    id: crypto.randomUUID(),
    owner: fields.owner || null,
    date: fields.date,
    title: fields.title.trim(),
    notes: sanitizeNotes(fields.notes),
    time: fields.time && isValidTime(fields.time) ? fields.time : null,
    startTime: fields.startTime && isValidTime(fields.startTime) ? fields.startTime : null,
    endTime: fields.endTime && isValidTime(fields.endTime) ? fields.endTime : null,
    snoozeMinutes: Number(fields.snoozeMinutes) || 0,
    repeat: REPEAT_MODES.has(fields.repeat) ? fields.repeat : "none",
    reminders: [],
    createdAt: new Date().toISOString(),
  };
  task.reminders = remindersForTask(task.time, task.startTime, task.endTime, task.snoozeMinutes);
  return task;
}

// For daily/weekly repeat, materialize future copies so the mini-calendar shows
// them, the scheduler pushes them, and past days keep their history.
function futureDates(dateStr, repeat, maxInstances) {
  const out = [];
  if (repeat !== "daily" && repeat !== "weekly") return out;
  const step = repeat === "daily" ? 1 : 7;
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + step);
  const cap = new Date(d.getTime() + 400 * 86400000).getTime();
  for (let i = 0; i < maxInstances && d.getTime() <= cap; i++) {
    out.push(formatDate(d));
    d.setDate(d.getDate() + step);
  }
  return out;
}

// ---------- Web Push: subscriptions + reminder scheduler ----------

async function removeSubscription(endpoint) {
  const subs = await readSubs();
  await writeSubs(subs.filter((s) => s.endpoint !== endpoint));
}

function sendPush(task, time, subs) {
  // Time-only tasks have no startTime/endTime — build the text from the
  // effective event time so we never touch null values.
  const eventTime = task.time || task.startTime;
  const isRange = task.startTime && task.endTime;
  const whenText = isRange
    ? `${to12h(task.startTime)}–${to12h(task.endTime)}`
    : eventTime
      ? `${to12h(eventTime)}${task.snoozeMinutes ? ` · early ${task.snoozeMinutes}m` : ""}`
      : "Anytime";
  const payload = {
    title: task.title,
    body: `${whenText} · Reminder for ${to12h(time)}`,
    tag: `${task.id}|${task.date}|${time}`,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    id: task.id,
    date: task.date,
    time,
    startTime: task.startTime || null,
    endTime: task.endTime || null,
  };
  const json = JSON.stringify(payload);
  let failed = 0;
  for (const sub of subs) {
    webpush.sendNotification(sub, json).catch((err) => {
      failed += 1;
      const code = err && err.statusCode ? err.statusCode : 0;
      if (code === 404 || code === 410) {
        // Gone / no longer valid — drop this device.
        console.log("Removing stale push subscription:", sub.endpoint);
        removeSubscription(sub.endpoint).catch(() => { /* best-effort cleanup */ });
      } else if (code === 429 || code === 500) {
        console.error(`Push rate-limited/server error (${code}), will retry later.`);
      } else if (code) {
        console.error(`Push failed (${code}) for ${sub.endpoint}`);
      } else {
        console.error("Push failed:", err.message);
      }
    });
  }
  return { total: subs.length, failed };
}

// Each device can live in a different timezone (a cloud server runs in UTC;
// the user may be in IST/CEST/PST...). We store the device's UTC offset in
// minutes with its subscription and evaluate reminders per offset group.
// Server-local UTC offset (in minutes). Subscriptions created before the
// timezone feature had no stored offset; for those, use the server's own
// timezone — which is correct when the server runs on the same device/location
// as the user (like this dev setup).
const SERVER_UTC_OFFSET_MINUTES = -new Date().getTimezoneOffset();

function offsetOf(sub) {
  const n = Number(sub && sub.utcOffsetMinutes);
  return Number.isInteger(n) && n >= -840 && n <= 840 ? n : SERVER_UTC_OFFSET_MINUTES;
}

// "What time and date is it at UTC offset `offset` minutes from nowMs?"
// Independent of the server's own timezone: `nowMs + offset*60000` marks that
// instant in UTC, so its UTC clock-fields ARE the local clock at that offset.
function clockAtOffset(nowMs, offset) {
  const d = new Date(nowMs + Number(offset) * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    hhmm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

async function checkDueReminders() {
  const tasks = await readTasks();
  const subs = await readSubs();
  const nowMs = Date.now();

  // If there are no subscribers yet, still check using UTC+0 so the log shows
  // the scheduler running; real devices adjust to their own offset.
  const offsets = [...new Set(subs.length ? subs.map(offsetOf) : [SERVER_UTC_OFFSET_MINUTES])];
  let touched = false;

  for (const offset of offsets) {
    const { date: today, hhmm: nowHHMM } = clockAtOffset(nowMs, offset);

    const due = tasks.filter(
      (t) =>
        t.date === today &&
        !t.done &&
        Array.isArray(t.reminders) &&
        t.reminders.includes(nowHHMM) &&
        !(Array.isArray(t.pushedTimes) && t.pushedTimes.includes(nowHHMM))
    );

    if (due.length === 0) continue;

    const groupSubs = subs.filter((s) => offsetOf(s) === offset);
    const sign = offset >= 0 ? "+" : "";
    console.log(`[reminders] ${today} ${nowHHMM} (UTC${sign}${offset}): ${due.length} task(s) due, ${groupSubs.length} subscriber(s)`);

    for (const task of due) {
      try {
        // A task only wakes the devices that belong to its owner — subscribers
        // from other accounts never see someone else's reminder.
        const ownerSubs = task.owner
          ? groupSubs.filter((s) => s.owner === task.owner)
          : groupSubs; // legacy ownerless tasks -> notify everyone at that offset
        const { total, failed } = sendPush(task, nowHHMM, ownerSubs);
        if (total > 0) {
          console.log(`[reminders] pushed "${task.title}" for ${nowHHMM} to ${total} device(s), ${failed} failed`);
        } else {
          console.log(`[reminders] "${task.title}" due at ${nowHHMM} — no subscribers yet. Install the app / enable notifications.`);
        }
      } catch (err) {
        console.error(`[reminders] push failed for task ${task.id}:`, err && err.message ? err.message : err);
      } finally {
        // Always mark the reminder as handled so a single failure can't cause
        // repeated spam on every scheduler tick.
        task.pushedTimes = [...(task.pushedTimes || []), nowHHMM];
        touched = true;
      }
    }
  }

  if (touched) await writeTasks(tasks);
}

const PUSH_INTERVAL_MS = Number(process.env.PUSH_INTERVAL_MS || 15000);
setInterval(() => {
  try {
    checkDueReminders().catch((err) => {
      console.error("Reminder scheduler error:", err && err.stack ? err.stack : err);
    });
  } catch (err) {
    console.error("Reminder scheduler error:", err && err.stack ? err.stack : err);
  }
}, PUSH_INTERVAL_MS);

// Public key so the browser can create a VAPID push subscription.
app.get("/api/push/public-key", (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Register a push subscription (one per device/browser) and tie it to the
// signed-in account so reminders only reach that user's devices.
app.post("/api/subscribe", subscribeLimiter, requireAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const keys = body.keys && typeof body.keys === "object" ? body.keys : {};

  if (!/^https:\/\/.+/.test(endpoint)) {
    return res.status(400).json({ error: "endpoint must be a valid https push URL" });
  }
  if (typeof keys.p256dh !== "string" || !/^[A-Za-z0-9+/_-]{10,}=*$/.test(keys.p256dh)) {
    return res.status(400).json({ error: "keys.p256dh must be a base64url key" });
  }
  if (typeof keys.auth !== "string" || !/^[A-Za-z0-9+/_-]{10,}=*$/.test(keys.auth)) {
    return res.status(400).json({ error: "keys.auth must be a base64url key" });
  }

  let utcOffsetMinutes = 0;
  if (body.utcOffsetMinutes !== undefined) {
    const n = Number(body.utcOffsetMinutes);
    if (!Number.isInteger(n) || n < -840 || n > 840) {
      return res.status(400).json({ error: "utcOffsetMinutes must be an integer between -840 and 840" });
    }
    utcOffsetMinutes = n;
  }

  const subs = await readSubs();
  const existing = subs.find((s) => s.endpoint === endpoint);
  if (existing) {
    // Re-subscribing on a later app load: keep the device, but refresh its
    // timezone offset and last-seen time (the user may have changed timezone).
    // If a device was previously used by a different account, it now belongs
    // to whoever is signed in on it.
    existing.owner = req.user.id;
    if (body.utcOffsetMinutes !== undefined && body.utcOffsetMinutes !== null) {
      existing.utcOffsetMinutes = Number(body.utcOffsetMinutes);
    }
    existing.lastSeenAt = new Date().toISOString();
    await writeSubs(subs);
    return res.json({ ok: true, already: true, offsetUpdated: existing.utcOffsetMinutes });
  }
  if (subs.length >= MAX_SUBSCRIPTIONS) {
    return res.status(400).json({ error: "subscription limit reached" });
  }

  subs.push({
    endpoint,
    owner: req.user.id,
    expirationTime: typeof body.expirationTime === "string" && body.expirationTime ? body.expirationTime : null,
    utcOffsetMinutes,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    createdAt: new Date().toISOString(),
  });
  await writeSubs(subs);
  res.status(201).json({ ok: true });
}));

// Unregister a push subscription (called by the app when notifications are off).
app.post("/api/unsubscribe", requireAuth, asyncRoute(async (req, res) => {
  const endpoint = req.body && typeof req.body.endpoint === "string" ? req.body.endpoint.trim() : "";
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
  const subs = await readSubs();
  await writeSubs(subs.filter((s) => !(s.endpoint === endpoint && s.owner === req.user.id)));
  res.json({ ok: true });
}));

// ---------- auth routes ----------

app.post("/api/auth/signup", asyncRoute(async (req, res) => {
  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 72) {
    return res.status(400).json({ error: "Password must be 8–72 characters." });
  }

  const users = await readUsers();
  if (users.some((u) => u.email === email)) {
    return res.status(409).json({ error: "An account with that email already exists — try signing in." });
  }

  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash: bcrypt.hashSync(body.password, 10),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await writeUsers(users);

  // Tasks created before accounts existed have no owner. The first person to
  // create an account keeps that earlier data so nothing is lost.
  const tasks = await readTasks();
  let adopted = 0;
  for (const t of tasks) {
    if (!t.owner) {
      t.owner = user.id;
      adopted += 1;
    }
  }
  if (adopted > 0) await writeTasks(tasks);

  setSessionCookie(res, user.id);
  console.log(`[auth] signup ${user.email} (adopted ${adopted} legacy task(s))`);
  res.status(201).json({ user: publicUser(user) });
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const users = await readUsers();
  const user = users.find((u) => u.email === email);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  setSessionCookie(res, user.id);
  console.log(`[auth] login ${user.email}`);
  res.json({ user: publicUser(user) });
}));

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", asyncRoute(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  res.json({ user: publicUser(user) });
}));

// ---------- API routes: tasks ----------

// Used by Render to verify that both the HTTP server and its writable store
// are available before directing users to this instance.
app.get("/api/health", asyncRoute(async (req, res) => {
  try {
    await ensureStore();
    if (!USE_MONGO) {
      fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
    }
    res.json({ ok: true, storage: USE_MONGO ? "mongodb" : "json-file" });
  } catch (err) {
    console.error("Storage health check failed:", err && err.stack ? err.stack : err);
    res.status(503).json({ ok: false, error: "task storage is unavailable" });
  }
}));

// List tasks for the signed-in user. Optional ?date=YYYY-MM-DD to filter to one day.
app.get("/api/tasks", requireAuth, asyncRoute(async (req, res) => {
  const { date } = req.query;
  let tasks = await tasksForUser(req.user.id);
  if (date) {
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
    }
    tasks = tasks.filter((t) => t.date === date);
  }
  const timeOf = (t) => (t.time || t.startTime || "23:59");
  tasks.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  res.json(tasks);
}));

// Dates that have at least one task, with a count — used to mark the calendar.
app.get("/api/tasks/summary", requireAuth, asyncRoute(async (req, res) => {
  const tasks = await tasksForUser(req.user.id);
  const counts = {};
  for (const t of tasks) counts[t.date] = (counts[t.date] || 0) + 1;
  res.json(counts);
}));

app.post("/api/tasks", requireAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const { date, title, time, startTime, endTime, notes, snoozeMinutes, repeat } = body;

  if (!isValidDate(date)) {
    return res.status(400).json({ error: "date is required as YYYY-MM-DD" });
  }
  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  if (title.trim().length > 120) {
    return res.status(400).json({ error: "title must be 120 characters or fewer" });
  }

  const hasTime = time !== undefined && time !== null && time !== "";
  if (hasTime && !isValidTime(time)) {
    return res.status(400).json({ error: "time must be HH:MM" });
  }
  const hasRange = startTime !== undefined && startTime !== null && startTime !== "" && endTime;
  if (hasRange && (!isValidTime(startTime) || !isValidTime(endTime))) {
    return res.status(400).json({ error: "startTime/endTime must be HH:MM" });
  }
  if (hasRange && toMinutes(endTime) <= toMinutes(startTime)) {
    return res.status(400).json({ error: "endTime must be after startTime" });
  }
  const snooze = snoozeMinutes === undefined || snoozeMinutes === null || snoozeMinutes === "" ? 0 : Number(snoozeMinutes);
  if (!SNOOZE_OPTIONS.has(snooze)) {
    return res.status(400).json({ error: "snoozeMinutes must be one of 0, 2, 3, 5, 10" });
  }
  if (repeat !== undefined && repeat !== null && repeat !== "" && !REPEAT_MODES.has(repeat)) {
    return res.status(400).json({ error: "repeat must be none, daily or weekly" });
  }

  const tasks = await readTasks();
  const fields = {
    owner: req.user.id,
    date,
    title,
    notes,
    time: hasTime ? time : null,
    startTime: hasRange ? startTime : null,
    endTime: hasRange ? endTime : null,
    snoozeMinutes: snooze,
    repeat: repeat && REPEAT_MODES.has(repeat) ? repeat : "none",
  };

  const task = buildTask(fields);
  tasks.push(task);

  const extraCount =
    fields.repeat === "daily" ? REPEAT_FORWARD_DAILY : fields.repeat === "weekly" ? REPEAT_FORWARD_WEEKLY : 0;
  if (extraCount > 0) {
    for (const fd of futureDates(date, fields.repeat, extraCount)) {
      tasks.push(buildTask({ ...fields, date: fd }));
    }
  }

  await writeTasks(tasks);
  res.status(201).json({ task, created: 1 + extraCount });
}));

app.put("/api/tasks/:id", requireAuth, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === id && t.owner === req.user.id);
  if (idx === -1) return res.status(404).json({ error: "task not found" });

  const existing = tasks[idx];
  const { date, title, startTime, endTime, time, snoozeMinutes, repeat, notes, done } = req.body || {};

  const updated = {
    ...existing,
    date: date !== undefined ? date : existing.date,
    title: title !== undefined ? String(title).trim() : existing.title,
    startTime: startTime !== undefined ? (startTime === "" || startTime === null ? null : startTime) : existing.startTime,
    endTime: endTime !== undefined ? (endTime === "" || endTime === null ? null : endTime) : existing.endTime,
    time: time !== undefined ? (time === "" || time === null ? null : time) : existing.time,
    snoozeMinutes: snoozeMinutes !== undefined ? Number(snoozeMinutes) || 0 : existing.snoozeMinutes,
    repeat: repeat !== undefined ? repeat : existing.repeat,
    notes: notes !== undefined ? sanitizeNotes(notes) : existing.notes,
    done: done !== undefined ? Boolean(done) : Boolean(existing.done),
  };

  if (!isValidDate(updated.date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }
  if (!updated.title || updated.title.length > 120) {
    return res.status(400).json({ error: "title is required (max 120 chars)" });
  }
  if (updated.time !== null && !isValidTime(updated.time)) {
    return res.status(400).json({ error: "time must be HH:MM" });
  }
  const hasRange = updated.startTime !== null && updated.startTime !== undefined && updated.endTime;
  if (hasRange && (!isValidTime(updated.startTime) || !isValidTime(updated.endTime))) {
    return res.status(400).json({ error: "startTime/endTime must be HH:MM" });
  }
  if (hasRange && toMinutes(updated.endTime) <= toMinutes(updated.startTime)) {
    return res.status(400).json({ error: "endTime must be after startTime" });
  }
  if (!SNOOZE_OPTIONS.has(Number(updated.snoozeMinutes) || 0)) {
    return res.status(400).json({ error: "snoozeMinutes must be one of 0, 2, 3, 5, 10" });
  }
  if (updated.repeat !== "none" && !REPEAT_MODES.has(updated.repeat)) {
    return res.status(400).json({ error: "repeat must be none, daily or weekly" });
  }

  updated.reminders = remindersForTask(updated.time, updated.startTime, updated.endTime, updated.snoozeMinutes);
  tasks[idx] = updated;
  await writeTasks(tasks);
  res.json(updated);
}));

app.delete("/api/tasks/:id", requireAuth, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const tasks = await readTasks();
  const next = tasks.filter((t) => !(t.id === id && t.owner === req.user.id));
  if (next.length === tasks.length) {
    return res.status(404).json({ error: "task not found" });
  }
  await writeTasks(next);
  res.status(204).end();
}));

// ---------- serve the frontend ----------

app.use(
  express.static(FRONTEND_DIR, {
    extensions: ["html"],
    index: "index.html",
    // The app shell must always be re-validated so updates reach browsers fast;
    // the service worker handles offline caching itself.
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css|json|svg|png)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  })
);
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// ---------- start ----------

async function boot() {
  try {
    if (USE_MONGO) await connectMongo();
    await ensureStore();
    SESSION_SECRET = await getSessionSecret();
    await initVapidKeys();
    webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);
    await migrateJsonOnce();
    console.log(
      USE_MONGO
        ? `Storage: MongoDB ("${MONGO_DB_NAME}") — data is durable across restarts.`
        : `Storage: local JSON files in ${DATA_DIR} — for local development only; set MONGODB_URI to persist on hosted platforms.`
    );
  } catch (err) {
    console.error("Storage failed to initialise:", err && err.stack ? err.stack : err);
    if (USE_MONGO) {
      console.error("Check that MONGODB_URI is correct and the database is reachable (and allow-listed by IP if applicable).");
    }
    process.exit(1); // fail fast — never serve while the durable store is unavailable
  }
  app.listen(PORT, () => {
    console.log(`Task Keeper running at http://localhost:${PORT}`);
    console.log(`Web Push public key: ${vapidKeys.publicKey.slice(0, 24)}…`);
  });
}

boot();

// Always return JSON for API errors. The client can then show a useful save
// error instead of the unhelpful "Unexpected token <" from an HTML error page.
app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ error: "The server could not save your changes. Please try again." });
  }
  res.status(500).send("Server error");
});
