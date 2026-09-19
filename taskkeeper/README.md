# Dayline — Task Keeper

A small day-planner app: add a task with a start and end time, and it shows up on a
visual timeline for that day. Tasks are saved to disk, so picking the same date again —
tomorrow, next week, whenever — brings the tasks right back.

**Reminder rule:** for a task from 5:00–6:00 PM, you get reminded starting at the midpoint
of the window (5:30), then every 15 minutes until it ends (5:30, 5:45, 6:00). Tasks with a
single time get a reminder exactly at that time, plus an optional **early reminder**
2/3/5/10 minutes *before* it (pick one in the "Early reminder" dropdown). All of this is
computed automatically from the times you set.

## What makes this version special

- **Web + mobile (PWA).** The app is a responsive progressive web app: it looks great in a
  browser, and can be installed to your phone home screen or desktop launcher so it opens
  full-screen like a native app.
- **Notifications everywhere.** Using the Web Push API + VAPID keys, reminders are pushed
  by the server to your laptop **and** your phone — even when the tab/app is closed.
  Works on Chrome, Edge, Firefox, and Safari (iOS 16.4+, installed to home screen).
- **Reminder warning sound.** When a reminder fires, a short warning chime plays (Web Audio
  API — no audio files, works offline). There's a sound on/off toggle in the sidebar.
- **See past days.** Browse any previous day with the mini-calendar or the ‹ Today › buttons
  in the header — all past tasks and times are right where you left them.
- **Private per-account tasks.** Everyone who uses the deployed app signs up with an email
  and password (sessions via a secure HTTP-only cookie). Each account only sees its own
  tasks, so two people can use the same deployment without mixing data. Tasks created
  before accounts existed are kept by the first account that signs up.
- **Security.** Helmet security headers + CSP, API rate limiting, strict input validation,
  restricted CORS, no exposed server internals.
- **Deployment-ready.** Dockerfile included; deploy on Render, Railway, Fly.io, a VPS, or
  any Node host. Set `MONGODB_URI` to a managed MongoDB (e.g. free MongoDB Atlas) and all
  data is stored securely in the database — no persistent disk or volume needed. Without
  it, data persists locally in `backend/data/` (tasks, push subscriptions, VAPID keys).

## What's inside

```
taskkeeper/
├── backend/          Express API + JSON-file storage (also serves the frontend)
│   ├── server.js     security + API + Web Push scheduler
│   ├── make-icons.js generates the PNG app icons (run: npm run make-icons)
│   └── data/         created automatically on first run (tasks, subscriptions, users, vapid)
├── frontend/         Plain HTML/CSS/JS — no build step
│   ├── index.html / styles.css / app.js
│   ├── manifest.json + sw.js        (PWA manifest + service worker for offline & push)
│   └── icons/                       app icons (SVG + generated PNGs)
├── Dockerfile        single-container deployment
└── README.md
```

There is no separate database install needed for local development — data is stored in
`backend/data/`. For hosted deploys you can (and on hosts with an ephemeral filesystem,
*survival depends on it*) point the app at a managed MongoDB via the `MONGODB_URI`
environment variable; everything then lives in the database. One process serves both the
API and the web page, so there's only one thing to start.

## Run it locally

Requires [Node.js](https://nodejs.org) 16 or later.

```bash
cd taskkeeper/backend
npm install
npm start
```

Then open **http://localhost:4000**.

To use a different port:

```bash
PORT=5000 npm start
```

### First-run tips

1. Click **📲 Install** (if your browser offers it) to install the app on your phone/laptop.
2. In the **Notifications & sound** card, tap **Enable notifications**, then **🔔 Test alert**
   to confirm the OS notification and the warning sound work on this device.
3. Turn the **Reminder sound** toggle on/off any time.
4. Use the mini-calendar or the ‹ Today › arrows to revisit past days.

## Notifications on your phone

Phone browsers only allow push notifications from a **secure HTTPS** origin (not plain http).

- **Android / Chrome, Edge:** open the deployed HTTPS URL, install the app (or just allow
  notifications) — push works even with the browser in the background.
- **iPhone / Safari:** add the app to your Home Screen (Share → *Add to Home Screen*), then
  open it and enable notifications. Requires iOS 16.4 or later.
- Push subscriptions are saved server-side in `backend/data/subscriptions.json`. The server
  checks every ~15 seconds and sends a push at each reminder time, so it works even when
  nobody has the app open.

## Security notes

- **Helmet** sets secure HTTP headers (CSP, X-Content-Type-Options, frame-ancestors, etc.)
  that prevent click-jacking and content injection.
- **Rate limiting** (`express-rate-limit`) throttles the API (180 req/min) and subscription
  changes (10/min) per IP.
- **Input validation** on every endpoint: dates, times, title length (120), notes length
  (1000), and push subscription format are all validated server-side.
- **CORS** is restricted to localhost origins; the app normally runs same-origin anyway.
- **VAPID keys** are generated once and stored in `backend/data/vapid.json` (keep this file
  when you redeploy — old subscriptions would otherwise be rejected). You can also set them
  via environment variables (see below).

## Deploying it

> **Before you deploy to a hosted platform, create a database.** The app can store data in
> local JSON files (fine for local development only) or in a managed MongoDB. Hosts like
> Render's free tier use an **ephemeral filesystem** — anything saved to local files is
> erased whenever the instance restarts or redeploys. With `MONGODB_URI` set, all data
> lives in the database and survives restarts, redeploys and instance changes.

### Step 0 — Get a free MongoDB database (2 minutes)

1. Create a free **M0** cluster at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
   (512 MB of storage — plenty for a task list).
2. Under **Database Access**, add a user with read/write access.
3. Under **Network Access**, click **Add IP Address** → **Allow access from anywhere**
   (`0.0.0.0/0`). This is fine because Atlas still requires the username/password, TLS,
   and the API key; for extra security you can instead allow Render's egress IP later.
4. Click **Connect → Drivers** and copy the connection string, e.g.
   `mongodb+srv://user:pass@cluster0.mongodb.net/taskkeeper?retryWrites=true&w=majority`.
   Give the web service the `MONGODB_URI` environment variable with this value
   (on Render: Dashboard → your service → **Environment**).

On first boot the backend creates its collections, indexes, VAPID keys and session secret
automatically. If `backend/data/*.json` already contains data from a previous run, it is
imported into MongoDB once.

### Option A — Docker (works on any VPS, Render, Railway, Fly.io)

```bash
docker build -t dayline .
docker run -d -p 4000:4000 -e MONGODB_URI=mongodb+srv://... dayline
```

Without `MONGODB_URI`, mount a persistent volume instead:

```bash
docker run -d -p 4000:4000 -v dayline-data:/app/backend/data dayline
```

### Option B — Render (recommended)

This repository includes `render.yaml`. In Render, select **New → Blueprint**
and choose this repository. It deploys one Docker-based **Web Service**, not a
Static Site, so the website and `/api/tasks` API always use the same HTTPS
origin on desktop and mobile.

Then, on the web service: add `MONGODB_URI` under **Environment** and redeploy.
The free plan works fine — a persistent disk is **not** needed because data is
stored in MongoDB, not on the instance's filesystem. Keep the service at one
instance: the app is intentionally single-instance.

After the deploy is live, open the Render URL on a phone or computer. On iPhone,
use Safari's **Share → Add to Home Screen** before enabling notifications.

### Option C — Railway / Fly.io / manual Node host

1. Point the platform at this repo, **Root directory**: `backend` (or the repo root with the
   Dockerfile).
2. Build command: `npm install` — Start command: `node server.js`.
3. Set the env vars you want (below), and give the service a public **HTTPS** URL.

### Option D — VPS with pm2

```bash
npm install -g pm2
cd taskkeeper/backend
npm install
pm2 start server.js --name dayline
pm2 save
```

Put a reverse proxy (nginx, Caddy) with a TLS certificate in front of port 4000 — required
for phone notifications.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MONGODB_URI` | *(unset)* | **Recommended for hosted deploys.** Managed MongoDB connection string, e.g. `mongodb+srv://user:pass@cluster.mongodb.net/taskkeeper`. When set, all data is stored durably in the database; otherwise local JSON files are used |
| `MONGODB_DB` | database name from the URI, else `taskkeeper` | MongoDB database name to use |
| `MONGODB_TLS` | `mongodb+srv://` → on, else off | Force TLS for self-hosted MongoDB (set `true`) |
| `PORT` | `4000` | HTTP port the server listens on |
| `DATA_DIR` | `backend/data` | directory for tasks, subscriptions, users, and VAPID keys (JSON-file mode only) |
| `SESSION_SECRET` | auto-generated, stored in the database / `data/secret.json` | secret used to sign login session cookies |
| `VAPID_PUBLIC_KEY` | auto-generated | Web Push public key (base64url) |
| `VAPID_PRIVATE_KEY` | auto-generated | Web Push private key (base64url) |
| `VAPID_SUBJECT` | mailto from hostname | contact URL/mailto for the push service |
| `MAX_SUBSCRIPTIONS` | `1000` | max registered devices |
| `PUSH_INTERVAL_MS` | `15000` | how often the server checks for due reminders |

## API reference

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/signup` | Create an account: `{ email, password }` -> sets a session cookie |
| POST | `/api/auth/login` | Sign in: `{ email, password }` -> sets a session cookie |
| POST | `/api/auth/logout` | Clear the session cookie |
| GET | `/api/auth/me` | Current signed-in user, or `401` |
| GET | `/api/tasks?date=` | List *your* tasks for a given `YYYY-MM-DD` date (requires auth) |
| GET | `/api/tasks/summary` | `{ "YYYY-MM-DD": count, ... }` for all days with *your* tasks (requires auth) |
| POST | `/api/tasks` | Create a task: `{ date, title, startTime, endTime, notes }` (requires auth) |
| PUT | `/api/tasks/:id` | Update a task (any subset, plus `done`) — you can only change your own |
| DELETE | `/api/tasks/:id` | Delete a task — you can only delete your own |
| GET | `/api/push/public-key` | VAPID public key for the browser to subscribe |
| POST | `/api/subscribe` | Register this device for push notifications (requires auth) |
| POST | `/api/unsubscribe` | Remove a device push subscription (requires auth) |

All task and subscription endpoints require a session cookie (sent automatically by the
browser once signed in); without one they return `401`. Tasks belong to the signed-in
account, so user A can never read or modify user B's tasks.

Times are `HH:MM` 24-hour strings. The server computes and stores `reminders` (an array of
`HH:MM` strings) whenever a task is created or its times change.

## Notes on the reminder system

Reminders fire two ways, so nothing is missed:

1. **Server push (Web Push)** — the backend scheduler pushes to every registered device at
   each reminder time, even with the app closed. This is the main channel on phones.
2. **In-page poller** — the open tab also checks every 30 seconds and plays the warning
   sound + toast. Great for local development where no HTTPS push is set up.

Sound is generated client-side with the Web Audio API, so it needs the app to be open in
that browser to be heard; the OS notification itself uses your device's normal alert sound.
