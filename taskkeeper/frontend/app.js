(() => {
  "use strict";

  const API = "/api/tasks";
const AUTH = "/api/auth";
  const PUSH_PUBLIC_KEY_URL = "/api/push/public-key";

  async function responseError(res, fallback) {
    const type = res.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const body = await res.json().catch(() => ({}));
      if (body && body.error) return body.error;
    }
    return `${fallback} (server returned ${res.status})`;
  }

  // ---------- state ----------
  let viewMonth = new Date();            // month currently shown in the mini calendar
  viewMonth.setDate(1);
  let selectedDate = formatDate(new Date());
  let tasksForDay = [];
  let taskCountsByDate = {};             // date -> count, for calendar dots
  const firedReminders = new Set();      // `${taskId}|${HH:MM}` already notified this session
  let soundEnabled = localStorage.getItem("dayline.sound") !== "off";

  // ---------- elements ----------
  const el = {
    monthLabel: document.getElementById("monthLabel"),
    calendarGrid: document.getElementById("calendarGrid"),
    prevMonth: document.getElementById("prevMonth"),
    nextMonth: document.getElementById("nextMonth"),
    todayBtn: document.getElementById("todayBtn"),

    form: document.getElementById("taskForm"),
    title: document.getElementById("title"),
    time: document.getElementById("time"),
    snooze: document.getElementById("snooze"),
    repeat: document.getElementById("repeat"),
    notes: document.getElementById("notes"),
    reminderPreview: document.getElementById("reminderPreview"),
    formError: document.getElementById("formError"),

    notifyStatus: document.getElementById("notifyStatus"),
    enableNotify: document.getElementById("enableNotify"),
    testNotify: document.getElementById("testNotify"),
    soundToggle: document.getElementById("soundToggle"),
    installBtn: document.getElementById("installBtn"),
    tasksBtn: document.getElementById("tasksBtn"),
    tasksCountBadge: document.getElementById("tasksCountBadge"),
    tasksModal: document.getElementById("tasksModal"),
    tasksModalClose: document.getElementById("tasksModalClose"),
    tasksModalBody: document.getElementById("tasksModalBody"),

    dayOfWeek: document.getElementById("dayOfWeek"),
    selectedDateLabel: document.getElementById("selectedDateLabel"),
    taskCount: document.getElementById("taskCount"),
    doneCount: document.getElementById("doneCount"),
    prevDay: document.getElementById("prevDay"),
    todayQuickBtn: document.getElementById("todayQuickBtn"),
    nextDay: document.getElementById("nextDay"),

    timeline: document.getElementById("timeline"),
    agenda: document.getElementById("agenda"),
    toastStack: document.getElementById("toastStack"),

    authOverlay: document.getElementById("authOverlay"),
    authForm: document.getElementById("authForm"),
    authEmail: document.getElementById("authEmail"),
    authPassword: document.getElementById("authPassword"),
    authError: document.getElementById("authError"),
    authSubmit: document.getElementById("authSubmit"),
    authTabLogin: document.getElementById("authTabLogin"),
    authTabSignup: document.getElementById("authTabSignup"),
    authHint: document.getElementById("authHint"),
    accountLabel: document.getElementById("accountLabel"),
    logoutBtn: document.getElementById("logoutBtn"),
  };

  // Safety net: if the browser is serving a mismatched mix of cached files
  // (old HTML + new JS or vice versa), the app would silently break. Detect it
  // and show a clear reload prompt instead of a dead UI.
  if (!document.getElementById("tasksBtn") || !document.getElementById("time")) {
    document.body.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "font-family:Inter,Arial,sans-serif;max-width:380px;margin:80px auto;padding:28px;text-align:center;background:#EEF1EC;border:1px solid #D4DBD2;border-radius:14px;";
    box.innerHTML =
      "<h2 style='margin:0 0 8px;color:#1B2320'>Dayline needs a refresh</h2>" +
      "<p style='margin:0;color:#4B564F;font-size:14px;line-height:1.5'>Your browser saved an older copy of the app. One tap loads the latest version.</p>";
    const btn = document.createElement("button");
    btn.textContent = "Reload Dayline";
    btn.style.cssText = "margin-top:18px;padding:11px 22px;border:none;border-radius:8px;background:#235B54;color:#fff;font-size:15px;font-weight:600;cursor:pointer;";
    btn.addEventListener("click", () => {
      try {
        navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.update()));
      } catch (err) {
        /* ignore */
      }
      location.reload();
    });
    box.appendChild(btn);
    document.body.appendChild(box);
    throw new Error("Stale app shell detected - manual reload required.");
  }

  const TIMELINE_START_HOUR = 6;   // 6am
  const TIMELINE_END_HOUR = 23;    // 11pm
  const HOUR_HEIGHT = 40;          // px, must match .hour-row height in CSS

  // ---------- date helpers ----------

  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
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

  function nowHHMM() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }

  // Mirrors the backend's reminder rule: start at the midpoint of the task
  // window, then every 15 minutes through the end time.
  function computeReminders(startTime, endTime) {
    const start = toMinutes(startTime);
    const end = toMinutes(endTime);
    if (!(end > start)) return [];
    const midpoint = start + Math.floor((end - start) / 2);
    const reminders = [];
    for (let t = midpoint; t <= end; t += 15) {
      const h = String(Math.floor(t / 60)).padStart(2, "0");
      const m = String(t % 60).padStart(2, "0");
      reminders.push(`${h}:${m}`);
    }
    return reminders.length ? reminders : [startTime];
  }
  // ---------- calendar ----------

  function renderCalendar() {
    const year = viewMonth.getFullYear();
    const month = viewMonth.getMonth();
    el.monthLabel.textContent = viewMonth.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });

    el.calendarGrid.innerHTML = "";
    ["S", "M", "T", "W", "T", "F", "S"].forEach((d) => {
      const span = document.createElement("div");
      span.className = "cal-weekday";
      span.textContent = d;
      el.calendarGrid.appendChild(span);
    });

    const firstDay = new Date(year, month, 1);
    const startOffset = firstDay.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = formatDate(new Date());

    for (let i = 0; i < startOffset; i++) {
      el.calendarGrid.appendChild(document.createElement("div"));
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(year, month, day);
      const dateStr = formatDate(dateObj);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-day";
      btn.textContent = String(day);
      if (dateStr === todayStr) btn.classList.add("is-today");
      if (dateStr === selectedDate) btn.classList.add("is-selected");

      if (taskCountsByDate[dateStr]) {
        const dot = document.createElement("span");
        dot.className = "dot";
        btn.appendChild(dot);
      }

      btn.addEventListener("click", () => {
        selectedDate = dateStr;
        loadDay();
        renderCalendar();
      });

      el.calendarGrid.appendChild(btn);
    }
  }

  el.prevMonth.addEventListener("click", () => {
    viewMonth.setMonth(viewMonth.getMonth() - 1);
    renderCalendar();
  });
  el.nextMonth.addEventListener("click", () => {
    viewMonth.setMonth(viewMonth.getMonth() + 1);
    renderCalendar();
  });

  function goToday() {
    const today = new Date();
    viewMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    selectedDate = formatDate(today);
    renderCalendar();
    loadDay();
  }

  el.todayBtn.addEventListener("click", goToday);
  el.todayQuickBtn.addEventListener("click", goToday);

  // Jump between individual days (previous days keep their tasks visible).
  function shiftDay(days) {
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() + days);
    selectedDate = formatDate(d);
    renderCalendar();
    loadDay();
  }
  el.prevDay.addEventListener("click", () => shiftDay(-1));
  el.nextDay.addEventListener("click", () => shiftDay(1));

  // ---------- reminder preview in the form ----------

  // Mirrors the backend: a reminder at the event time plus an optional early
  // reminder (snoozeMinutes minutes BEFORE the event time).
  function previewReminders(time, early) {
    const list = [];
    if (early > 0) {
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

  function updateReminderPreview() {
    const time = el.time.value;
    if (!time) {
      el.reminderPreview.textContent = "No time set — this becomes a checklist item (no reminder).";
      return;
    }
    const reminders = previewReminders(time, Number(el.snooze.value) || 0);
    el.reminderPreview.textContent = "Reminders at " + reminders.map(to12h).join(", ");
  }
  el.time.addEventListener("input", updateReminderPreview);
  el.snooze.addEventListener("change", updateReminderPreview);
  // ---------- data loading ----------

  async function loadSummary() {
    try {
      const res = await fetch(`${API}/summary`);
      taskCountsByDate = await res.json();
    } catch (err) {
      console.error("Could not load task summary", err);
    }
  }

  async function loadDay() {
    try {
      const res = await fetch(`${API}?date=${selectedDate}`);
      if (!res.ok) throw new Error("bad response from server");
      tasksForDay = await res.json();
    } catch (err) {
      console.error("Could not load tasks for day", err);
      // Keep the previously loaded tasks instead of emptying the view.
    }
    renderDay();
    updateTasksBadge();
    if (!el.tasksModal.hidden) renderTasksModal();
  }

  // ---------- rendering the selected day ----------

  function renderDay() {
    const dateObj = new Date(selectedDate + "T00:00:00");
    el.dayOfWeek.textContent = dateObj.toLocaleDateString(undefined, { weekday: "long" });
    el.selectedDateLabel.textContent = dateObj.toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    el.taskCount.textContent = tasksForDay.length;
    el.doneCount.textContent = tasksForDay.filter((t) => t.done).length;

    renderTimeline();
    renderAgenda();
  }

  function renderTimeline() {
    el.timeline.innerHTML = "";
    const totalHours = TIMELINE_END_HOUR - TIMELINE_START_HOUR;
    el.timeline.style.height = `${totalHours * HOUR_HEIGHT + 20}px`;

    for (let h = TIMELINE_START_HOUR; h <= TIMELINE_END_HOUR; h++) {
      const row = document.createElement("div");
      row.className = "hour-row";
      row.style.top = `${(h - TIMELINE_START_HOUR) * HOUR_HEIGHT + 10}px`;
      const label = document.createElement("span");
      const h12 = h % 12 === 0 ? 12 : h % 12;
      label.textContent = `${h12}${h >= 12 ? "PM" : "AM"}`;
      row.appendChild(label);
      el.timeline.appendChild(row);
    }

    if (tasksForDay.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-timeline";
      empty.textContent = "Nothing on the books — add a task to see it here.";
      el.timeline.appendChild(empty);
    }

    tasksForDay.forEach((task) => {
      const eventTime = task.time || task.startTime;
      if (!eventTime) return; // checklist-only item — shown in the list/modal

      const startMin = toMinutes(eventTime) - TIMELINE_START_HOUR * 60;
      const top = (startMin / 60) * HOUR_HEIGHT + 10;
      const hasRange = task.startTime && task.endTime;

      const block = document.createElement("div");
      if (hasRange) {
        const endMin = toMinutes(task.endTime) - TIMELINE_START_HOUR * 60;
        const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 22);
        block.className = "task-block" + (task.done ? " is-done" : "");
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.innerHTML = `
        <strong>${escapeHtml(task.title)}</strong>
        <span class="task-time">${to12h(task.startTime)} – ${to12h(task.endTime)}</span>
      `;
      } else {
        // Single-time event: a compact pill centered on that time.
        block.className = "task-pill" + (task.done ? " is-done" : "");
        block.style.top = `${top - 8}px`;
        block.innerHTML = `
        <span class="pill-time">${to12h(task.time)}</span>
        <strong>${escapeHtml(task.title)}</strong>
      `;
      }
      el.timeline.appendChild(block);
    });

    // "now" line, only when viewing today
    if (selectedDate === formatDate(new Date())) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes() - TIMELINE_START_HOUR * 60;
      if (nowMin >= 0 && nowMin <= (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60) {
        const line = document.createElement("div");
        line.className = "now-line";
        line.style.top = `${(nowMin / 60) * HOUR_HEIGHT + 10}px`;
        el.timeline.appendChild(line);
      }
    }
  }
  function renderAgenda() {
    el.agenda.innerHTML = "";

    if (tasksForDay.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agenda-empty";
      empty.textContent = "This day is open. Add the first task on the left.";
      el.agenda.appendChild(empty);
      return;
    }

    tasksForDay.forEach((task) => {
      const item = document.createElement("div");
      item.className = "agenda-item" + (task.done ? " is-done" : "");

      const check = document.createElement("button");
      check.className = "agenda-check" + (task.done ? " checked" : "");
      check.type = "button";
      check.setAttribute("aria-label", task.done ? "Mark as not done" : "Mark as done");
      check.textContent = task.done ? "✓" : "";
      check.addEventListener("click", () => toggleDone(task));

      const body = document.createElement("div");
      body.className = "agenda-body";
      const remindersHtml = (task.reminders || [])
        .map((r) => `<span>${to12h(r)}</span>`)
        .join("");
      const taskTimeText = task.time
        ? to12h(task.time) + (task.snoozeMinutes ? ` · early ${task.snoozeMinutes}m` : "")
        : task.startTime && task.endTime
          ? `${to12h(task.startTime)} – ${to12h(task.endTime)}`
          : "Any time";
      const repeatText = task.repeat && task.repeat !== "none" ? ` · repeats ${task.repeat}` : "";
      body.innerHTML = `
        <div class="agenda-time">${taskTimeText}${repeatText}</div>
        <h3>${escapeHtml(task.title)}</h3>
        ${task.notes ? `<p>${escapeHtml(task.notes)}</p>` : ""}
        <div class="agenda-reminders">${remindersHtml}</div>
      `;

      const del = document.createElement("button");
      del.className = "agenda-delete";
      del.type = "button";
      del.setAttribute("aria-label", "Delete task");
      del.textContent = "×";
      del.addEventListener("click", () => deleteTask(task.id));

      item.appendChild(check);
      item.appendChild(body);
      item.appendChild(del);
      el.agenda.appendChild(item);
    });
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ---------- mutations ----------

  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    el.formError.textContent = "";
    const submitButton = el.form.querySelector('button[type="submit"]');

    const payload = {
      date: selectedDate,
      title: el.title.value,
      time: el.time.value || null,
      snoozeMinutes: Number(el.snooze.value) || 0,
      repeat: el.repeat.value,
      notes: el.notes.value,
    };

    try {
      submitButton.disabled = true;
      submitButton.textContent = "Saving…";
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await responseError(res, "Could not save task"));
      }
      el.form.reset();
      el.reminderPreview.textContent = "";
      showToast("Task saved", `“${payload.title.trim()}” was added for ${selectedDate}.`);
      await loadSummary();
      await loadDay();
    } catch (err) {
      el.formError.textContent = err instanceof TypeError
        ? "Could not reach the server. Check your connection and try again."
        : err.message;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Save task";
    }
  });

  async function toggleDone(task) {
    try {
      await fetch(`${API}/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: !task.done }),
      });
      await loadDay();
    } catch (err) {
      console.error("Could not update task", err);
    }
  }

  async function deleteTask(id) {
    try {
      await fetch(`${API}/${id}`, { method: "DELETE" });
      await loadSummary();
      await loadDay();
    } catch (err) {
      console.error("Could not delete task", err);
    }
  }
  // ---------- toasts, sound & in-page reminders ----------

  function showToast(title, body) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(body)}`;
    el.toastStack.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
  }

  let audioCtx = null;

  // Browsers keep the Web Audio context "suspended" (silent) until the user has
  // interacted with the page at least once. Reminders often fire while the app
  // is running in the background or right after a push, so we prime the context
  // on the very first tap/keypress — after that, reminder chimes can always play.
  function primeAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } catch (err) {
      /* audio unavailable */
    }
  }
  ["pointerdown", "touchstart", "keydown", "click"].forEach((eventName) =>
    window.addEventListener(eventName, primeAudio, { passive: true })
  );

  // Plays a short "task is due" warning chime using the Web Audio API — no audio
  // files needed, works offline, and respects the sound toggle.
  function playReminderSound() {
    if (!soundEnabled) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      const ctx = audioCtx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});

      const tone = (start, freq, dur, vol) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const p = gain.gain;
        p.cancelScheduledValues();
        p.setValueAtTime(0, start);
        p.linearRampToValueAtTime(vol, start + 0.02);
        p.linearRampToValueAtTime(vol, start + dur - 0.04);
        p.linearRampToValueAtTime(0, start + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + dur + 0.05);
      };

      // "Alert" pattern: three quick two-tone chimes, then a longer final beep.
      let t = ctx.currentTime + 0.05;
      for (let i = 0; i < 3; i++) {
        tone(t, 698, 0.10, 0.22);
        tone(t + 0.15, 587, 0.16, 0.22);
        t += 0.34;
      }
      tone(t + 0.10, 880, 0.60, 0.26);
    } catch (err) {
      // Sound unavailable — the toast/notification still shows.
    }
  }

  function notify(task, reminderTime) {
    const key = `${task.id}|${task.date}|${reminderTime}`;
    if (firedReminders.has(key)) return;
    firedReminders.add(key);

    // Task may have a single event time (no startTime/endTime) — build the
    // notification text safely for either form.
    const eventTime = task.time || task.startTime;
    const whenText = task.startTime && task.endTime
      ? `${to12h(task.startTime)}–${to12h(task.endTime)}`
      : eventTime
        ? `${to12h(eventTime)}${task.snoozeMinutes ? ` · early ${task.snoozeMinutes}m` : ""}`
        : "Anytime";
    const body = `${whenText} · reminder for ${to12h(reminderTime)}`;
    playReminderSound();

    if (window.Notification && Notification.permission === "granted") {
      try {
        new Notification(task.title, { body, tag: key });
      } catch (err) {
        showToast(task.title, body);
      }
    } else {
      showToast(task.title, body);
    }
  }

  async function checkReminders() {
    const todayStr = formatDate(new Date());
    let dayTasks = tasksForDay;

    // If the app has been open across midnight, or the selected day isn't
    // today, still poll today's real tasks in the background so reminders
    // aren't missed while browsing another date.
    if (selectedDate !== todayStr) {
      try {
        const res = await fetch(`${API}?date=${todayStr}`);
        dayTasks = await res.json();
      } catch {
        return;
      }
    }

    const now = nowHHMM();

    dayTasks.forEach((task) => {
      if (task.done) return;
      (task.reminders || []).forEach((r) => {
        if (r === now) notify(task, r);
      });
    });
  }
  // ---------- service worker + Web Push (phone & laptop) ----------

  function setStatus(text) {
    el.notifyStatus.textContent = text;
  }

  function urlBase64ToUint8Array(input) {
    const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Ask the browser for a push subscription, then register it with the backend
  // so the server can wake this device even when the app is closed.
  async function enablePushOnDevice() {
    try {
      const keyRes = await fetch(PUSH_PUBLIC_KEY_URL);
      if (!keyRes.ok) throw new Error("push key unavailable");
      const { publicKey } = await keyRes.json();

      const reg = await navigator.serviceWorker.ready.then(() =>
        navigator.serviceWorker.getRegistration()
      );
      if (!reg) throw new Error("no service worker registration");

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const subJson = sub.toJSON ? sub.toJSON() : sub;
      subJson.utcOffsetMinutes = new Date().getTimezoneOffset() * -1; // local UTC offset
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subJson),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "subscribe rejected");
      }
      return true;
    } catch (err) {
      console.error("Could not enable push:", err);
      return false;
    }
  }

  // Push notifications arrive in the service worker; if a tab is open it wakes
  // it so the chime + toast play on the page too.
  function onSWMessage(event) {
    if (!event.data || event.data.type !== "DAYLINE_REMINDER") return;
    const p = event.data.payload || {};
    const task = {
      id: p.id || "push",
      date: p.date || formatDate(new Date()),
      title: p.title || "Dayline reminder",
      startTime: p.startTime || nowHHMM(),
      endTime: p.endTime || nowHHMM(),
      done: false,
    };
    notify(task, p.time || nowHHMM());
  }

  async function setupNotifications() {
    const supported = "Notification" in window && "serviceWorker" in navigator;
    if (!supported) {
      setStatus("This browser can't show OS notifications — in-page toasts still work.");
      return;
    }

    try {
      await navigator.serviceWorker.register("sw.js");
    } catch (err) {
      setStatus("Could not register push support (needs HTTPS). In-page toasts still work.");
      return;
    }

    navigator.serviceWorker.addEventListener("message", onSWMessage);
    await navigator.serviceWorker.ready;

    if (Notification.permission === "granted") {
      const ok = await enablePushOnDevice();
      setStatus(ok
        ? "On ✓ — reminders arrive here and on your phone."
        : "On ✓ in this browser (push to other devices not available).");
      el.testNotify.hidden = false;
    } else if (Notification.permission === "denied") {
      setStatus("Notifications blocked by the browser — in-page toasts still work.");
    } else {
      el.enableNotify.hidden = false;
      setStatus("Tap “Enable notifications” for reminders here and on your phone.");
    }
  }

  el.enableNotify.addEventListener("click", async () => {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      el.enableNotify.hidden = true;
      const ok = await enablePushOnDevice();
      setStatus(ok
        ? "On ✓ — reminders arrive here and on your phone."
        : "On ✓ in this browser (push to other devices not available).");
      el.testNotify.hidden = false;
    } else {
      setStatus("Permission not granted — in-page toasts will still appear.");
    }
  });

  el.testNotify.addEventListener("click", () => {
    const now = nowHHMM();
    notify(
      { id: "test", date: formatDate(new Date()), title: "Test alert — Dayline works!", startTime: now, endTime: now, done: false },
      now
    );
  });

  // ---------- reminder sound toggle ----------

  function setSound(on) {
    soundEnabled = on;
    try {
      localStorage.setItem("dayline.sound", on ? "on" : "off");
    } catch (err) {
      /* private mode */
    }
    el.soundToggle.setAttribute("aria-pressed", String(on));
    el.soundToggle.textContent = on ? "On" : "Off";
  }
  el.soundToggle.addEventListener("click", () => setSound(!soundEnabled));
  setSound(soundEnabled); // sync the UI with the stored preference

  // ---------- installable PWA prompt ----------

  const APP_VERSION = "2.4";

  // Force a service-worker update check so everyone receives the latest fix
  // without waiting for the browser's default (often slow) refresh cycle.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("sw.js")
      .then((reg) => setTimeout(() => reg.update().catch(() => {}), 1500))
      .catch(() => {});
  }

  // Show a one-time toast when the updated build starts running, so it's easy
  // to confirm the fix is loaded.
  try {
    if (localStorage.getItem("dayline.version") !== APP_VERSION) {
      localStorage.setItem("dayline.version", APP_VERSION);
      setTimeout(() => {
        showToast("Dayline updated", `Now running version ${APP_VERSION} — early reminders, Android install, and alerts.`);
      }, 1200);
    }
  } catch (err) {
    /* private mode */
  }

  const isStandalone =
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    !!window.navigator.standalone;

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    el.installBtn.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    el.installBtn.hidden = true;
    deferredPrompt = null;
  });

  el.installBtn.addEventListener("click", async () => {
    if (isStandalone) {
      showToast("Dayline is installed", "Open the app from your home screen or app list.");
      return;
    }
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice && choice.outcome === "accepted") el.installBtn.hidden = true;
      } catch (err) {
        /* prompt dismissed or unsupported */
      }
      deferredPrompt = null;
      return;
    }
    // No install prompt is available (browser doesn't offer one, or it hasn't
    // fired yet) — give the user concrete steps instead of a dead button.
    if (/iphone|ipad|ipod/i.test(navigator.userAgent || "")) {
      showToast("Install Dayline", "Tap Share, then “Add to Home Screen” to install on iPhone.");
    } else if (/android/i.test(navigator.userAgent || "")) {
      showToast("Install Dayline", "Tap the ⋮ menu → “Add to Home screen” or “Install app” to install on Android.");
    } else {
      showToast("Install Dayline", "Open this page in Chrome or Edge and click the install icon in the address bar.");
    }
  });

  // Make the button visible whenever the app is not installed yet, instead of
  // waiting for the browser to tell us it can be installed. Clicking it always
  // does something useful (real prompt on Chrome/Edge, guidance elsewhere).
  if (!isStandalone && "serviceWorker" in navigator) {
    el.installBtn.hidden = false;
  }

  // ---------- tasks modal (checkbox list popup) ----------

  function renderTasksModal() {
    el.tasksModalBody.innerHTML = "";
    if (tasksForDay.length === 0) {
      const empty = document.createElement("p");
      empty.className = "agenda-empty";
      empty.textContent = "No tasks for this day yet.";
      el.tasksModalBody.appendChild(empty);
      return;
    }

    tasksForDay.forEach((task) => {
      const row = document.createElement("div");
      row.className = "modal-task" + (task.done ? " is-done" : "");

      const check = document.createElement("button");
      check.className = "modal-check" + (task.done ? " checked" : "");
      check.type = "button";
      check.setAttribute("aria-label", task.done ? "Mark as not done" : "Mark as done");
      check.textContent = task.done ? "✓" : "";
      check.addEventListener("click", () => toggleDone(task));

      const text = document.createElement("div");
      text.className = "modal-task-text";
      const timeText = task.time
        ? to12h(task.time) + (task.snoozeMinutes ? ` · early ${task.snoozeMinutes}m` : "")
        : task.startTime && task.endTime
          ? `${to12h(task.startTime)} – ${to12h(task.endTime)}`
          : "";
      const repeatText = task.repeat && task.repeat !== "none" ? ` · ${task.repeat}` : "";
      text.innerHTML =
        `<strong>${escapeHtml(task.title)}</strong>` +
        (timeText ? `<span>${escapeHtml(timeText)}${escapeHtml(repeatText)}</span>` : "");

      const del = document.createElement("button");
      del.className = "modal-delete";
      del.type = "button";
      del.setAttribute("aria-label", "Delete task");
      del.textContent = "×";
      del.addEventListener("click", () => deleteTask(task.id));

      row.appendChild(check);
      row.appendChild(text);
      row.appendChild(del);
      el.tasksModalBody.appendChild(row);
    });
  }

  function openTasksModal() {
    renderTasksModal();
    el.tasksModal.hidden = false;
  }
  function closeTasksModal() {
    el.tasksModal.hidden = true;
  }

  el.tasksBtn.addEventListener("click", openTasksModal);
  el.tasksModalClose.addEventListener("click", closeTasksModal);
  el.tasksModal.addEventListener("click", (event) => {
    if (event.target === el.tasksModal) closeTasksModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.tasksModal.hidden) closeTasksModal();
  });

  function updateTasksBadge() {
    el.tasksCountBadge.textContent = tasksForDay.length ? String(tasksForDay.length) : "0";
    el.tasksCountBadge.hidden = tasksForDay.length === 0;
  }

  // ---------- accounts: sign in / sign up / log out ----------

  let currentUser = null;
  let authMode = "login"; // "login" | "signup"

  function setAuthMode(mode) {
    authMode = mode;
    el.authTabLogin.classList.toggle("is-active", mode === "login");
    el.authTabSignup.classList.toggle("is-active", mode === "signup");
    el.authSubmit.textContent = mode === "login" ? "Sign in" : "Create account";
    el.authPassword.autocomplete = mode === "login" ? "current-password" : "new-password";
    el.authHint.textContent =
      mode === "login"
        ? "New here? Create an account so only you can see your tasks."
        : "Pick a password of at least 8 characters. Your tasks stay private to this account.";
  }

  el.authTabLogin.addEventListener("click", () => setAuthMode("login"));
  el.authTabSignup.addEventListener("click", () => setAuthMode("signup"));

  el.authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = el.authEmail.value.trim();
    const password = el.authPassword.value;
    if (!email || !password) {
      el.authError.textContent = "Enter your email and password.";
      return;
    }
    el.authError.textContent = "";
    el.authSubmit.disabled = true;
    el.authSubmit.textContent = authMode === "login" ? "Signing in…" : "Creating account…";
    try {
      const res = await fetch(`${AUTH}/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        throw new Error(
          await responseError(res, authMode === "login" ? "Could not sign in" : "Could not create account")
        );
      }
      const data = await res.json();
      sessionStarted(data.user);
    } catch (err) {
      el.authError.textContent =
        err instanceof TypeError
          ? "Could not reach the server. Check your connection and try again."
          : err.message;
    } finally {
      el.authSubmit.disabled = false;
      setAuthMode(authMode);
    }
  });

  function sessionStarted(user) {
    currentUser = user;
    el.accountLabel.textContent = user.email;
    el.logoutBtn.hidden = false;
    el.authOverlay.hidden = true;
    init();
  }

  el.logoutBtn.addEventListener("click", async () => {
    try {
      await fetch(`${AUTH}/logout`, { method: "POST" });
    } catch (err) {
      /* Even offline, drop the local session and go back to the sign-in screen. */
    }
    location.reload();
  });

  // ---------- init ----------

  async function init() {
    setupNotifications();
    renderCalendar();
    await loadSummary();
    await loadDay();

    setInterval(checkReminders, 30 * 1000); // poll twice a minute (fallback + local)
    setInterval(() => {
      if (selectedDate === formatDate(new Date())) renderTimeline(); // move the "now" line
    }, 60 * 1000);
  }

  // The app shell starts hidden behind the auth overlay. Confirm the session
  // cookie before revealing it; with a valid session the overlay is dismissed,
  // otherwise the user can sign in or create an account.
  async function boot() {
    try {
      const res = await fetch(`${AUTH}/me`);
      if (res.ok) {
        const data = await res.json();
        sessionStarted(data.user);
        return;
      }
    } catch (err) {
      el.authError.textContent = "Could not reach the server. Check your connection and try again.";
    }
    el.authOverlay.hidden = false;
    setAuthMode("login");
  }

  boot();
})();
