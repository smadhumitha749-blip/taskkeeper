# Dayline — Task Keeper

A small day-planner app: add a task with a start and end time, and it shows up on a
visual timeline for that day. Tasks are saved to disk, so picking the same date again —
tomorrow, next week, whenever — brings the tasks right back.

**Reminder rule:** for a task from 5:00–6:00 PM, you get reminded starting at the midpoint
of the window (5:30), then every 15 minutes until it ends (5:30, 5:45, 6:00). This is
computed automatically from whatever start/end time you set.

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
- **Security.** Helmet security headers + CSP, API rate limiting, strict input validation,
  restricted CORS, no exposed server internals.
- **Deployment-ready.** Dockerfile included; deploy on Render, Railway, Fly.io, a VPS, or
  any Node host. Data persists in `backend/data/` (tasks, push subscriptions, VAPID keys).

## What's inside

```
taskkeeper/
├── backend/          Express API + JSON-file storage (also serves the frontend)
│   ├── server.js     security + API + Web Push scheduler
│   ├── make-icons.js generates the PNG app icons (run: npm run make-icons)
│   └── data/         created automatically on first run (tasks, subscriptions, vapid)
├── frontend/         Plain HTML/CSS/JS — no build step
│   ├── index.html / styles.css / app.js
│   ├── manifest.json + sw.js        (PWA manifest + service worker for offline & push)
│   └── icons/                       app icons (SVG + generated PNGs)
├── Dockerfile        single-container deployment
└── README.md
```

There is no database server to install — everything is stored in `backend/data/`.
One process serves both the API and the web page, so there's only one thing to start.

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

### Option A — Docker (works on any VPS, Render, Railway, Fly.io)

```bash
docker build -t dayline .
docker run -d -p 4000:4000 -v dayline-data:/app/backend/data dayline
```

Make sure `backend/data` is a persistent volume, otherwise tasks/subscriptions are lost on
restart.

### Option B — Render / Railway / Fly.io (click-to-deploy Node)

1. Point the platform at this repo, **Root directory**: `backend` (or the repo root with the
   Dockerfile).
2. Build command: `npm install` — Start command: `node server.js`.
3. Set the env vars you want (below), and give the service a public **HTTPS** URL.

### Option C — VPS with pm2

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
| `PORT` | `4000` | HTTP port the server listens on |
| `VAPID_PUBLIC_KEY` | auto-generated | Web Push public key (base64url) |
| `VAPID_PRIVATE_KEY` | auto-generated | Web Push private key (base64url) |
| `VAPID_SUBJECT` | mailto from hostname | contact URL/mailto for the push service |
| `MAX_SUBSCRIPTIONS` | `1000` | max registered devices |
| `PUSH_INTERVAL_MS` | `15000` | how often the server checks for due reminders |

## API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks?date=` | List tasks for a given `YYYY-MM-DD` date |
| GET | `/api/tasks/summary` | `{ "YYYY-MM-DD": count, ... }` for all days with tasks |
| POST | `/api/tasks` | Create a task: `{ date, title, startTime, endTime, notes }` |
| PUT | `/api/tasks/:id` | Update a task (any subset, plus `done`) |
| DELETE | `/api/tasks/:id` | Delete a task |
| GET | `/api/push/public-key` | VAPID public key for the browser to subscribe |
| POST | `/api/subscribe` | Register this device for push notifications |
| POST | `/api/unsubscribe` | Remove a device push subscription |

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
