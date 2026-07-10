"use strict";

/*
 * nicofocus - single-page Pomodoro with streaks, XP and Google Drive sync.
 * Pure static app (no build, no backend). Loaded by index.html, styled by styles.css.
 *
 * Reads top-to-bottom as a story: storage → dates → streak → timer → sound →
 * celebrations → render → profile → settings → events → sync → boot.
 *
 * localStorage keys (all prefixed "nicofocus."):
 *   .v1         synced app state (the object below)            [KEY]
 *   .timer      LOCAL-only timer {mode,running,endAt,remainingMs}, never synced  [TIMER_KEY]
 *   .token/.tokenExp  cached Google access token + expiry      [TOKEN_KEY/TOKEN_EXP_KEY]
 *   .connected  "1" once this browser has linked Google        [CONNECTED_KEY]
 *   .gclient    per-browser OAuth client id (overrides GOOGLE_CLIENT_ID)  [GCLIENT_KEY]
 *
 * Synced state shape (see DEFAULTS); per-day maps are keyed "YYYY-MM-DD":
 *   config        user settings (times, goal, theme, sound, restWeekends, chartView)
 *   history       sessions completed per day
 *   minutes       focus minutes per day
 *   xpByDay       gamified XP per day (total XP = sum of these)
 *   ratings       per-day session depth counts {shallow,solid,deep} - informational only
 *   frozenDays    days a streak-freeze covered
 *   repairedDays  gap days earned back by a streak repair
 *   goals/activeGoal, pomoSinceLong, freezes, freezeEarnedOn, joined
 *   updatedAt     last edit (for merge); cfgUpdatedAt     last *config* edit (config merges by this)
 */

/* ---------------- storage (crash-safe) ---------------- */
const KEY = "nicofocus.v1";

/* Optional: bake your Google OAuth Client ID here to enable Drive sync on every
   device without re-entering it. Leave "" to set it per-browser via Settings → Sync. */
const GOOGLE_CLIENT_ID = "980514183334-bp2bu8k44eegq6sh48h0grhqlnnhs34j.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_FILE = "nicofocus.json";

const MAX_FREEZES = 2;      // most freezes you can bank at once
const FREEZE_EARN_DAYS = 7; // consecutive streak days that earn one freeze back
const REPAIR_SESSIONS = 2;  // sessions on the comeback day that restore a broken streak
const REPAIR_MAX_GAP = 2;   // longest gap (work days) that can still be repaired

const DEFAULTS = {
  config: {
    pomodoro: 45, short: 5, long: 15, interval: 4, goal: 4,
    autoBreak: false, autoPomo: false, sound: true, notify: false,
    color: "186 73 73",
    alarm: "chime", volume: 0.5, alarmRepeat: 1, click: true,
    restWeekends: false, chartView: "xp",
  },
  history: {},     // "YYYY-MM-DD": sessionCount
  minutes: {},     // "YYYY-MM-DD": focus minutes
  xpByDay: {},     // "YYYY-MM-DD": gamified XP earned that day
  ratings: {},     // "YYYY-MM-DD": {shallow,solid,deep} counts - informational, never gates rewards
  goals: [],       // {id, name, deadline, enough, checkpoints:[{id,text,done,completedAt}], createdAt, completedAt}
  activeGoal: null,
  pomoSinceLong: 0,
  cycleDay: null,  // day the long-break cycle belongs to; a new day resets pomoSinceLong
  freezes: 2,      // streak freezes: start with 2, earn 1 back per 7-day streak (max 2)
  freezeEarnedOn: null, // day the last freeze was earned, prevents double grants
  frozenDays: {},  // "YYYY-MM-DD": true, days auto-saved by a freeze
  repairedDays: {},// "YYYY-MM-DD": true, gap days restored by a streak repair
  holidays: {},    // "YYYY-MM-DD": true, days marked off by hand (free, never break the streak)
  joined: null,    // first day used, for "since joining" stats
  updatedAt: 0,    // last local edit, used to reconcile across devices
  cfgUpdatedAt: 0, // last config edit, so settings sync independently of activity
};

/* one-time migrations for state blobs written by older versions */
function normalize(s) {
  if ("gems" in s) { s.freezes = MAX_FREEZES; delete s.gems; } // gems retired: full freeze bank as a send-off
  delete s.tasks; delete s.activeTask;                         // tasks replaced by goals
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const data = JSON.parse(raw);
    return normalize({
      ...structuredClone(DEFAULTS),
      ...data,
      config: { ...DEFAULTS.config, ...(data.config || {}) },
    });
  } catch (e) {
    console.warn("load failed, using defaults", e);
    return structuredClone(DEFAULTS);
  }
}
function persistLocalOnly() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.warn("save failed", e); }
}
function save() {
  state.updatedAt = Date.now();
  persistLocalOnly();
  schedulePush();   // no-op unless signed in to Drive
}
/* use for any settings change so config syncs by its own timestamp */
function saveConfig() {
  state.cfgUpdatedAt = Date.now();
  save();
}

let state = load();

/* ---------------- date helpers ---------------- */
const pad = (n) => String(n).padStart(2, "0");
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function shiftDay(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return dayKey(dt);
}

/* ---------------- streak logic (Duolingo-style) ---------------- */
/* A day counts toward the streak as soon as you finish ONE session. The daily goal
   is a separate personal target shown in the progress bar, it does not gate the streak.
   Weekends are optional rest days (don't break and don't count). A freeze can cover a
   missed work day. */
const STREAK_GOAL = 1;
function isRestDay(key) {
  if (!state.config.restWeekends) return false;
  const [y, m, d] = key.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6; // Sun / Sat
}
function dayCovered(key) {
  return (state.history[key] || 0) >= STREAK_GOAL || !!state.frozenDays[key] ||
    !!state.holidays[key] || !!state.repairedDays[key];
}
function computeStreak() {
  const today = dayKey();
  let cursor = today;
  let atRisk = false;
  if (!dayCovered(today)) {
    // today's work isn't done: rest day -> no risk; work day -> grace until midnight
    if (!isRestDay(today)) atRisk = true;
    cursor = shiftDay(today, -1);
  }
  let streak = 0, guard = 0;
  while (guard++ < 3700) {
    if (isRestDay(cursor)) { cursor = shiftDay(cursor, -1); continue; } // skip, no break
    if (dayCovered(cursor)) { streak++; cursor = shiftDay(cursor, -1); }
    else break;
  }
  return { streak, atRisk: atRisk && streak > 0 };
}
function computeBest() {
  const keys = Object.keys(state.history)
    .concat(Object.keys(state.frozenDays))
    .concat(Object.keys(state.holidays))
    .concat(Object.keys(state.repairedDays));
  if (state.joined) keys.push(state.joined);
  if (!keys.length) return 0;
  let cur = keys.sort()[0];
  const today = dayKey();
  let best = 0, run = 0, guard = 0;
  while (cur <= today && guard++ < 4000) {
    if (isRestDay(cur)) { /* transparent */ }
    else if (dayCovered(cur)) { run++; best = Math.max(best, run); }
    else run = 0;
    cur = shiftDay(cur, 1);
  }
  return best;
}
/* auto-apply banked freezes to cover a gap of missed work days right before today,
   but only when it fully preserves an existing streak. Returns days saved. */
function applyFreezes() {
  if (!state.freezes) return 0;
  const today = dayKey();
  let cursor = shiftDay(today, -1);
  const missed = [];
  while (true) {
    if (isRestDay(cursor)) { cursor = shiftDay(cursor, -1); continue; }
    if (dayCovered(cursor)) break;            // reached an active day -> a streak existed
    missed.push(cursor);
    if (missed.length > state.freezes || missed.length > 60) return 0; // can't fully bridge
    cursor = shiftDay(cursor, -1);
  }
  if (!missed.length) return 0;
  missed.forEach((d) => { state.frozenDays[d] = true; });
  state.freezes -= missed.length;
  persistLocalOnly();
  return missed.length;
}
/* A broken streak can be earned back while today is still the comeback window:
   an uncovered gap of 1..REPAIR_MAX_GAP work days sits right after a real streak.
   Needs no persistence - once the gap is covered another way (or grows past the
   cap) the offer simply stops existing. */
function repairOffer() {
  let cursor = shiftDay(dayKey(), -1);
  const gap = [];
  let guard = 0;
  while (guard++ < 60) {
    if (isRestDay(cursor)) { cursor = shiftDay(cursor, -1); continue; }
    if (dayCovered(cursor)) break;
    gap.push(cursor);
    if (gap.length > REPAIR_MAX_GAP) return null;
    cursor = shiftDay(cursor, -1);
  }
  if (!gap.length) return null;
  let prev = 0;
  while (guard++ < 3700) {
    if (isRestDay(cursor)) { cursor = shiftDay(cursor, -1); continue; }
    if (dayCovered(cursor)) { prev++; cursor = shiftDay(cursor, -1); }
    else break;
  }
  return prev >= 1 ? { gap, prevStreak: prev } : null;
}

/* ---------------- timer engine (timestamp-based) ---------------- */
const MODES = {
  pomodoro: { label: "Time to focus!", color: () => state.config.color },
  short:    { label: "Time for a break!", color: () => "56 133 138" },
  long:     { label: "Time for a long break!", color: () => "57 112 151" },
};
let mode = "pomodoro";
let running = false;
let endAt = 0;        // timestamp ms when current run ends
let remainingMs = 0;  // when paused
let tickTimer = null;

/* timer state is LOCAL only (a running timer shouldn't sync to other devices) */
const TIMER_KEY = "nicofocus.timer";
function saveTimer() {
  try { localStorage.setItem(TIMER_KEY, JSON.stringify({ mode, running, endAt, remainingMs })); }
  catch (e) { /* ignore */ }
}
/* restore the timer across a refresh. Returns true if a state was restored. */
function restoreTimer() {
  let t;
  try { t = JSON.parse(localStorage.getItem(TIMER_KEY) || "null"); } catch (e) { t = null; }
  if (!t || !MODES[t.mode]) return false;
  mode = t.mode;
  applyMode();
  if (t.running && t.endAt > Date.now()) {
    // still mid-session: resume counting from the original end time
    endAt = t.endAt; remainingMs = 0; running = true;
    el.startBtn.textContent = "Pause";
    el.skipBtn.classList.add("show");
    startTicking();
  } else {
    // paused, or the session elapsed while the tab was closed -> stay paused
    running = false;
    remainingMs = (t.running || !(t.remainingMs > 0)) ? modeDurationMs(mode) : t.remainingMs;
    el.startBtn.textContent = "Start";
    el.skipBtn.classList.toggle("show", remainingMs < modeDurationMs(mode));
    renderTime();
  }
  return true;
}

function modeDurationMs(m = mode) {
  const mins = m === "pomodoro" ? state.config.pomodoro : m === "short" ? state.config.short : state.config.long;
  return Math.max(1, mins) * 60 * 1000;
}
function currentRemaining() {
  if (running) return Math.max(0, endAt - Date.now());
  return remainingMs;
}
function fmt(ms) {
  const total = Math.round(ms / 1000);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function renderTime() {
  const ms = currentRemaining();
  const txt = fmt(ms);
  el.time.textContent = txt;
  document.title = (running ? txt + " · " : "") + (mode === "pomodoro" ? "Focus" : "Break") + " · nicofocus";
}

/* Drive the countdown with a 1s interval instead of requestAnimationFrame.
   rAF is paused in background tabs (freezing the tab-title countdown); setInterval
   keeps running (throttled) so the title keeps ticking and the session still ends
   close to on time when you're on another tab. A MM:SS display doesn't need 60fps. */
function stopTicking() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }
function tickOnce() {
  renderTime();
  if (running && Date.now() >= endAt) finishMode();
}
function startTicking() {
  stopTicking();
  tickOnce();                          // paint immediately, don't wait 1s
  tickTimer = setInterval(tickOnce, 1000);
}

function startTimer() {
  if (running) return;
  running = true;
  endAt = Date.now() + (remainingMs || modeDurationMs());
  el.startBtn.textContent = "Pause";
  el.skipBtn.classList.add("show");
  saveTimer();
  startTicking();
}
function pauseTimer() {
  if (!running) return;
  remainingMs = currentRemaining();
  running = false;
  stopTicking();
  el.startBtn.textContent = "Start";
  saveTimer();
  renderTime();
}
function toggleTimer() { playClick(); running ? pauseTimer() : startTimer(); }

function resetTimerTo(m, autoStart = false) {
  stopTicking();
  running = false;
  mode = m;
  remainingMs = modeDurationMs(m);
  applyMode();
  renderTime();
  el.startBtn.textContent = "Start";
  el.skipBtn.classList.remove("show");
  if (autoStart) startTimer();
  else saveTimer();
}

/* The long-break cycle is a per-day thing: a new day restarts the round counter at
   #1 and clears any partial cycle left from yesterday (so the first session of the
   day never jumps straight to a long break). */
function ensureCycleForToday() {
  const k = dayKey();
  if (state.cycleDay !== k) {
    state.cycleDay = k;
    state.pomoSinceLong = 0;
    persistLocalOnly();
  }
}

function finishMode() {
  stopTicking();
  running = false;
  remainingMs = 0;
  if (state.config.sound) playAlarm();
  notify(mode === "pomodoro" ? "Focus session done! Take a break." : "Break over, back to focus.");

  if (mode === "pomodoro") {
    ensureCycleForToday();
    const result = recordSession();
    state.pomoSinceLong = (state.pomoSinceLong || 0) + 1;
    const nextLong = state.pomoSinceLong >= state.config.interval;
    if (nextLong) state.pomoSinceLong = 0;
    save();
    resetTimerTo(nextLong ? "long" : "short", state.config.autoBreak);
    renderAll();
    celebrateSession(result);
  } else {
    resetTimerTo("pomodoro", state.config.autoPomo);
    renderAll();
  }
}

/* XP is gamified, NOT just minutes: a flat completion reward + effort (minutes) +
   a momentum bonus so each additional session that day is worth a little more. */
const XP_BASE = 10, XP_PER_MIN = 1, XP_MOMENTUM = 5;

/* record one finished pomodoro; returns a summary for the completion animation */
function recordSession() {
  const k = dayKey();
  const prevStreak = computeStreak().streak;
  state.history[k] = (state.history[k] || 0) + 1;
  const todayCount = state.history[k];
  const minutes = state.config.pomodoro;
  state.minutes[k] = (state.minutes[k] || 0) + minutes;
  const xp = XP_BASE + minutes * XP_PER_MIN + XP_MOMENTUM * todayCount;
  state.xpByDay[k] = (state.xpByDay[k] || 0) + xp;
  // a broken streak is earned back by effort: enough sessions today restore the gap
  const offer = repairOffer();
  let repaired = false;
  if (offer && todayCount >= REPAIR_SESSIONS) {
    offer.gap.forEach((d) => { state.repairedDays[d] = true; });
    repaired = true;
  }
  const newStreak = computeStreak().streak;
  // consistency earns a freeze back: one per full week of streak (max 2 banked)
  if (newStreak > 0 && newStreak % FREEZE_EARN_DAYS === 0 &&
      (state.freezes || 0) < MAX_FREEZES && state.freezeEarnedOn !== k) {
    state.freezes = (state.freezes || 0) + 1;
    state.freezeEarnedOn = k;
    setTimeout(() => toast("🧊 Freeze earned - a full week of showing up."), 800);
  }
  save();
  const streakGrew = newStreak > prevStreak;
  if (streakGrew) notify(`Streak extended! 🔥 ${newStreak}-day streak.`);
  return { xp, minutes, todayCount, prevStreak, newStreak, streakGrew, repaired, day: k, milestone: streakGrew && isMilestone(newStreak) };
}

/* store a session's self-rated depth. Purely informational: feeds the chart and
   weekly report only - never XP, streak, or freezes. */
function recordRating(day, quality, prevQuality) {
  const r = state.ratings[day] = state.ratings[day] || { shallow: 0, solid: 0, deep: 0 };
  if (prevQuality) r[prevQuality] = Math.max(0, (r[prevQuality] || 0) - 1);
  r[quality] = (r[quality] || 0) + 1;
  save();
}

/* show the per-session "Session complete!" screen, then the streak celebration if the
   streak grew. Deferred until the tab is focused so you actually see the dopamine hit. */
let pendingCelebration = null;
function runOrQueueCelebration(fn) {
  if (document.hidden) pendingCelebration = fn;
  else fn();
}
function celebrateSession(result) {
  runOrQueueCelebration(() => {
    showSessionComplete(result, () => {
      if (result.repaired) toast(`💪 Streak repaired - ${result.newStreak} days. Welcome back.`);
      if (result.streakGrew) celebrate(result.prevStreak, result.newStreak, result.milestone);
    });
  });
}
function showSessionComplete(result, onContinue) {
  const sd = document.getElementById("sessionDone");
  const xpEl = document.getElementById("sdXp");
  const btn = document.getElementById("sdBtn");
  xpEl.textContent = "+0";
  document.getElementById("sdTime").textContent = result.minutes + "m";
  document.getElementById("sdToday").textContent = result.todayCount;
  const cards = sd.querySelectorAll(".sd-card");
  cards.forEach((c) => c.classList.remove("in"));
  btn.classList.remove("show");

  // depth rating: optional, purely informational (never touches XP or streak).
  // Re-clicking a different button before dismissing moves the count over.
  const rateBtns = sd.querySelectorAll(".sd-rate-btn");
  let chosen = null;
  rateBtns.forEach((b) => {
    b.classList.remove("sel");
    b.onclick = () => {
      if (!result.day) return; // dev test sessions have no day to attach to
      recordRating(result.day, b.dataset.q, chosen);
      chosen = b.dataset.q;
      rateBtns.forEach((x) => x.classList.toggle("sel", x === b));
      playClick();
    };
  });

  sd.hidden = false;
  sd.classList.add("open");
  playSessionSound();

  // Single dismiss path, reachable by button, Enter/Esc/Space, or clicking the backdrop.
  let dismissed = false;
  const finish = () => {
    if (dismissed) return;
    dismissed = true;
    document.removeEventListener("keydown", onKey);
    sd.classList.remove("open"); sd.hidden = true;
    if (onContinue) onContinue();
  };
  const onKey = (e) => {
    if (e.key === "Enter" || e.key === "Escape" || e.key === " ") { e.preventDefault(); finish(); }
  };
  btn.onclick = finish;
  sd.onclick = (e) => { if (e.target === sd) finish(); };
  document.addEventListener("keydown", onKey);

  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    cards.forEach((c) => c.classList.add("in"));
    xpEl.textContent = "+" + result.xp;
    btn.classList.add("show");
    return;
  }
  cards.forEach((c, i) => setTimeout(() => c.classList.add("in"), 480 + i * 130));
  setTimeout(() => countUp(xpEl, 0, result.xp, 600, "+"), 540);
  // Reveal Continue once the last card has settled, so the screen never dead-ends.
  setTimeout(() => btn.classList.add("show"), 480 + cards.length * 130 + 180);
}

/* milestone days get the bigger celebration */
function isMilestone(n) {
  return n === 7 || n === 14 || n === 30 || n === 50 || n === 100 || n === 365 || (n > 0 && n % 100 === 0);
}

/* ---------------- sound engine (synthesized, no audio files) ---------------- */
let audioCtx = null;
function ac() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
/* one short tone: freq Hz, start offset s, duration s, waveform, volume 0..1 */
function blip(freq, start, dur, type, vol) {
  const c = ac();
  const t0 = c.currentTime + start;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type || "sine";
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination);
  o.start(t0); o.stop(t0 + dur + 0.03);
}
/* each alarm = list of [freq, startOffset, duration, waveform] */
const ALARMS = {
  chime:   [[880, 0, 0.5, "sine"], [1175, 0.16, 0.5, "sine"], [1568, 0.32, 0.6, "sine"]],
  bell:    [[1568, 0, 1.1, "triangle"], [2093, 0, 1.1, "sine"], [3136, 0, 0.6, "sine"]],
  digital: [[988, 0, 0.11, "square"], [988, 0.18, 0.11, "square"], [988, 0.36, 0.11, "square"], [988, 0.54, 0.11, "square"]],
  beep:    [[660, 0, 0.22, "sawtooth"], [660, 0.34, 0.22, "sawtooth"], [660, 0.68, 0.22, "sawtooth"]],
};
function playAlarm() {
  try {
    const v = state.config.volume ?? 0.5;
    if (v <= 0) return;
    const notes = ALARMS[state.config.alarm] || ALARMS.chime;
    const reps = Math.max(1, state.config.alarmRepeat || 1);
    const span = 0.9; // gap between repeats
    for (let r = 0; r < reps; r++)
      notes.forEach(([f, s, d, t]) => blip(f, s + r * span, d, t, v * 0.5));
  } catch (e) { /* ignore */ }
}
function playClick() {
  try {
    if (!state.config.click) return;
    const v = state.config.volume ?? 0.5;
    if (v <= 0) return;
    blip(420, 0, 0.05, "triangle", v * 0.22);
    blip(640, 0.018, 0.05, "sine", v * 0.18);
  } catch (e) { /* ignore */ }
}
function playStreakSound() {
  try {
    const v = state.config.volume ?? 0.5;
    if (v <= 0) return;
    [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.4]].forEach(([f, s]) => blip(f, s, 0.45, "triangle", v * 0.5));
  } catch (e) { /* ignore */ }
}
function playSessionSound() {
  try {
    const v = state.config.volume ?? 0.5;
    if (v <= 0) return;
    [[659, 0], [988, 0.11]].forEach(([f, s]) => blip(f, s, 0.32, "triangle", v * 0.38));
  } catch (e) { /* ignore */ }
}
function playMilestoneSound() {
  try {
    const v = state.config.volume ?? 0.5;
    if (v <= 0) return;
    // a longer rising fanfare for milestones
    [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.3], [1319, 0.42], [1568, 0.56], [2093, 0.74]]
      .forEach(([f, s]) => blip(f, s, 0.6, "triangle", v * 0.55));
  } catch (e) { /* ignore */ }
}
function confetti() {
  const colors = ["#f94144", "#f9c74f", "#90be6d", "#43aa8b", "#577590", "#f3722c"];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement("div");
    const size = 6 + Math.random() * 8;
    p.style.cssText = `position:fixed;top:-20px;left:${Math.random() * 100}vw;width:${size}px;height:${size}px;background:${colors[i % colors.length]};z-index:999;border-radius:2px;pointer-events:none;`;
    document.body.appendChild(p);
    const dur = 1500 + Math.random() * 1500;
    p.animate(
      [{ transform: `translateY(0) rotate(0)`, opacity: 1 },
       { transform: `translateY(105vh) rotate(${Math.random() * 720}deg)`, opacity: 1 }],
      { duration: dur, easing: "cubic-bezier(.3,.6,.5,1)" }
    ).onfinish = () => p.remove();
  }
}
function notify(msg) {
  if (!state.config.notify) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try { new Notification("nicofocus", { body: msg }); } catch (e) {}
}

/* ---------------- weekday streak strip + celebration ---------------- */
const WEEK_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
function weekDays() {
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - today.getDay()); // back to Sunday
  const tKey = dayKey(today);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    const k = dayKey(d);
    const done = (state.history[k] || 0) >= STREAK_GOAL;
    out.push({
      letter: WEEK_LETTERS[i], key: k, done,
      holiday: !done && !!state.holidays[k],
      frozen: !done && !state.holidays[k] && !!state.frozenDays[k],
      repaired: !done && !state.holidays[k] && !state.frozenDays[k] && !!state.repairedDays[k],
      rest: !done && isRestDay(k),
      isToday: k === tKey,
      future: d > today && k !== tKey,
    });
  }
  return out;
}
function renderWeek(container) {
  if (!container) return;
  container.innerHTML = "";
  weekDays().forEach((d) => {
    const w = document.createElement("div");
    w.className = "wday" + (d.done ? " done" : "") + (d.holiday ? " holiday" : "") +
      (d.frozen ? " frozen" : "") + (d.repaired ? " repaired" : "") + (d.rest ? " rest" : "") +
      (d.isToday ? " today" : "") + (d.future ? " future" : "");
    const mark = d.holiday ? "🌴" : (d.frozen ? "🧊" : (d.repaired ? "💪" : ""));
    w.innerHTML = `<div class="lbl">${d.letter}</div><div class="ring">${mark}</div>`;
    container.appendChild(w);
  });
}

function countUp(elm, from, to, dur, prefix = "") {
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    elm.textContent = prefix + Math.round(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(frame);
    else elm.textContent = prefix + to;
  }
  requestAnimationFrame(frame);
}

function celebrate(prevStreak, newStreak, milestone = false) {
  const cel = document.getElementById("celebrate");
  const strip = document.getElementById("celStrip");
  const numEl = document.getElementById("celNum");
  const copyEl = document.getElementById("celCopy");
  const btnEl = document.getElementById("celBtn");
  const badgeEl = document.getElementById("celBadge");

  renderWeek(strip);
  numEl.textContent = prevStreak;
  copyEl.textContent = "day streak!";
  copyEl.classList.remove("show");
  btnEl.classList.remove("show");
  cel.classList.toggle("milestone", milestone);
  badgeEl.style.display = milestone ? "block" : "none";
  badgeEl.textContent = "🏆 " + newStreak + "-DAY MILESTONE";
  badgeEl.classList.remove("show");
  cel.hidden = false;
  cel.classList.add("open");

  confetti();
  if (milestone) {
    playMilestoneSound();
    setTimeout(confetti, 350);
    setTimeout(confetti, 750);
  } else {
    playStreakSound();
  }

  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const days = strip.querySelectorAll(".wday");
  if (reduce) {
    numEl.textContent = newStreak;
    days.forEach((w) => w.classList.add("in"));
    badgeEl.classList.add("show");
    copyEl.classList.add("show");
    btnEl.classList.add("show");
    return;
  }
  const dur = milestone ? 1100 : 700;
  setTimeout(() => countUp(numEl, prevStreak, newStreak, dur), 350);
  days.forEach((w, i) => setTimeout(() => w.classList.add("in"), 650 + i * 90));
  const todayEl = strip.querySelector(".wday.today");
  const lastBeat = 650 + 7 * 90;
  setTimeout(() => { if (todayEl) todayEl.classList.add("pop"); }, lastBeat);
  setTimeout(() => { badgeEl.classList.add("show"); copyEl.classList.add("show"); btnEl.classList.add("show"); }, lastBeat + 220);
}

/* ---------------- DOM refs ---------------- */
const el = {
  time: document.getElementById("time"),
  startBtn: document.getElementById("startBtn"),
  skipBtn: document.getElementById("skipBtn"),
  roundCounter: document.getElementById("roundCounter"),
  focusMsg: document.getElementById("focusMsg"),
  streakNum: document.getElementById("streakNum"),
  streakChip: document.getElementById("streakChip"),
  todayCount: document.getElementById("todayCount"),
  goalCount: document.getElementById("goalCount"),
  todayBar: document.getElementById("todayBar"),
  goalMsg: document.getElementById("goalMsg"),
  goalList: document.getElementById("goalList"),
};

/* ---------------- theming ---------------- */
function applyMode() {
  const color = MODES[mode].color();
  document.documentElement.style.setProperty("--bg", `rgb(${color})`);
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  el.focusMsg.textContent = MODES[mode].label;
}

/* ---------------- daily message ---------------- */
/* stable per calendar day, rotates each day */
function dayNumber() {
  const d = new Date();
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
}
/* before any session today: one session keeps the streak */
const START_MSGS = [
  "One session keeps your streak alive. 🔥",
  "Just 1 focus block today. You've got this. 💪",
  "Start now: a single session protects your streak. ✨",
  "The streak only needs one. Let's begin. 🚀",
  "Press start. One session is all it takes today. 🔥",
];
/* streak safe (>=1 today) but still below the personal daily goal */
const MID_MSGS = [
  "Streak safe! {n} more to hit today's goal. 🔥",
  "Locked in for today. {n} to reach your goal. 💪",
  "Nice. {n} more session{s} for your full goal. ✨",
  "Streak secured, now chase the goal: {n} to go. 🚀",
];
/* daily goal fully reached */
const DONE_MSGS = [
  "Daily goal smashed. Momentum is yours. 🚀",
  "Full goal done. Today's locked in. 🔥",
  "That's a wrap: goal complete! 💪",
  "Done and dusted. Your future self says thanks. ✨",
  "Goal reached and streak secured. 🔥",
  "You showed up and went all the way. 🌱",
];
function pickDaily(arr) { return arr[dayNumber() % arr.length]; }
function dailyMessage(todayCount, goal) {
  if (todayCount <= 0) return pickDaily(START_MSGS);
  if (todayCount >= goal) return pickDaily(DONE_MSGS);
  const n = goal - todayCount;
  return pickDaily(MID_MSGS).replace("{n}", n).replace("{s}", n === 1 ? "" : "s");
}

/* ---------------- render ---------------- */
function renderAll() {
  ensureCycleForToday();
  const { streak, atRisk } = computeStreak();
  el.streakNum.textContent = streak;
  el.streakChip.classList.toggle("at-risk", atRisk);

  const today = state.history[dayKey()] || 0;
  const goal = state.config.goal;
  el.todayCount.textContent = today;
  el.goalCount.textContent = goal;
  el.todayBar.style.width = Math.min(100, (today / goal) * 100) + "%";
  el.goalMsg.textContent = dailyMessage(today, goal);
  document.getElementById("todayXp").textContent = state.xpByDay[dayKey()] || 0;

  el.roundCounter.textContent = "#" + ((state.pomoSinceLong || 0) % state.config.interval + 1);

  // streak-repair banner: honest terms, disappears on its own once the window closes
  const rb = document.getElementById("repairBanner");
  if (rb) {
    const offer = repairOffer();
    rb.hidden = !offer;
    if (offer) rb.textContent = `Your ${offer.prevStreak}-day streak broke. Finish ${REPAIR_SESSIONS} sessions today to repair it - ${Math.min(today, REPAIR_SESSIONS)} of ${REPAIR_SESSIONS} done.`;
  }

  renderWeek(document.getElementById("weekStrip"));
  renderGoals();
}

/* ---------------- goals ---------------- */
/* A goal is deliberately open-ended: no percent bar, no session estimates.
   Progress = checkpoints completed. Planning = only the next 1-3 concrete steps;
   when they run out you reflect and add the next batch (iterate, like prompting). */
const MAX_OPEN_CHECKPOINTS = 3;
function newId() { return Date.now() + "-" + Math.random().toString(36).slice(2, 6); }
function daysUntil(deadline) {
  if (!deadline) return null;
  return Math.round((new Date(deadline + "T00:00") - new Date(dayKey() + "T00:00")) / 86400000);
}
let openGoalEditor = null; // assigned by the goal-form closure below

function renderGoals() {
  el.goalList.innerHTML = "";
  state.goals.forEach((g) => {
    const doneCount = g.checkpoints.filter((c) => c.done).length;
    const openCps = g.checkpoints.filter((c) => !c.done);
    const expanded = g.id === state.activeGoal && !g.completedAt;
    const div = document.createElement("div");
    div.className = "goal" + (expanded ? " active" : "") + (g.completedAt ? " done" : "");

    const left = daysUntil(g.deadline);
    const deadlineChip = left == null ? "" :
      left > 0 ? `<span class="goal-chip${left <= 3 ? " soon" : ""}">${left} day${left === 1 ? "" : "s"} left</span>` :
      left === 0 ? `<span class="goal-chip soon">due today</span>` :
      `<span class="goal-chip over">${-left} day${left === -1 ? "" : "s"} past deadline</span>`;
    const meta = g.completedAt
      ? `<span class="goal-chip done-chip">completed</span>`
      : `<span class="goal-chip">${doneCount} done</span>` + deadlineChip;
    div.innerHTML = `
      <div class="goal-head">
        <div class="goal-name"></div>
        <div class="goal-meta">${meta}</div>
        <button class="task-del" title="Delete">×</button>
      </div>`;
    div.querySelector(".goal-name").textContent = g.name;
    div.querySelector(".goal-head").addEventListener("click", () => {
      state.activeGoal = state.activeGoal === g.id ? null : g.id;
      save(); renderGoals();
    });
    div.querySelector(".task-del").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Delete goal "${g.name}" and its checkpoints?`)) return;
      state.goals = state.goals.filter((x) => x.id !== g.id);
      if (state.activeGoal === g.id) state.activeGoal = null;
      save(); renderGoals();
    });

    if (expanded) {
      const body = document.createElement("div");
      body.className = "goal-body";
      if (g.enough) {
        const en = document.createElement("div");
        en.className = "goal-enough";
        en.textContent = "Done means: " + g.enough;
        body.appendChild(en);
      }
      g.checkpoints.forEach((c) => {
        const row = document.createElement("div");
        row.className = "cp" + (c.done ? " done" : "");
        row.innerHTML = `<div class="check"></div><div class="cp-text"></div>`;
        row.querySelector(".cp-text").textContent = c.text;
        row.addEventListener("click", () => {
          c.done = !c.done;
          c.completedAt = c.done ? Date.now() : null;
          save();
          if (c.done) { playClick(); toast("✔ " + c.text); }
          renderGoals();
        });
        body.appendChild(row);
      });
      // iterate loop: all checkpoints done -> reflect, then plan the next 1-3
      if (g.checkpoints.length && !openCps.length) {
        const box = document.createElement("div");
        box.className = "iterate-box";
        box.textContent = "All checkpoints done. What did you learn? Add the next 1-3, or complete the goal.";
        body.appendChild(box);
      }
      if (openCps.length < MAX_OPEN_CHECKPOINTS) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "cp-add";
        input.placeholder = g.checkpoints.length ? "Next checkpoint..." : "First checkpoint: the very next concrete step";
        input.maxLength = 160;
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          const text = input.value.trim();
          if (!text) return;
          g.checkpoints.push({ id: newId(), text, done: false, completedAt: null });
          save(); renderGoals();
          const ni = el.goalList.querySelector(".goal.active .cp-add");
          if (ni) ni.focus();
        });
        body.appendChild(input);
      } else {
        const hint = document.createElement("div");
        hint.className = "cp-cap";
        hint.textContent = "Finish a checkpoint to add the next.";
        body.appendChild(hint);
      }
      const actions = document.createElement("div");
      actions.className = "goal-actions";
      const editBtn = document.createElement("button");
      editBtn.className = "btn-soft";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => { if (openGoalEditor) openGoalEditor(g); });
      actions.appendChild(editBtn);
      if (g.checkpoints.length && !openCps.length) {
        const doneBtn = document.createElement("button");
        doneBtn.className = "btn-soft goal-complete";
        doneBtn.textContent = "Complete goal 🎉";
        doneBtn.addEventListener("click", () => {
          g.completedAt = Date.now();
          if (state.activeGoal === g.id) state.activeGoal = null;
          save(); confetti(); toast("🏁 Goal completed: " + g.name);
          renderGoals();
        });
        actions.appendChild(doneBtn);
      }
      body.appendChild(actions);
      div.appendChild(body);
    }
    el.goalList.appendChild(div);
  });
}

/* ---------------- profile ---------------- */
function xpOn(key) { return state.xpByDay[key] || 0; }   // gamified XP that day
function minOn(key) { return state.minutes[key] || 0; }  // focus minutes that day
function valOn(key) { return viewIsTime() ? minOn(key) : xpOn(key); }
function totalXp() { return Object.values(state.xpByDay).reduce((a, b) => a + b, 0); }
function totalMinutes() { return Object.values(state.minutes).reduce((a, b) => a + b, 0); }
function fmtHours(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function viewIsTime() { return state.config.chartView === "time"; }
/* fill XP for days that predate the XP system (idempotent, safe across sync) */
function fillXpFromMinutes() {
  let changed = false;
  for (const d in state.minutes) {
    if (state.xpByDay[d] == null) { state.xpByDay[d] = state.minutes[d]; changed = true; }
  }
  if (changed) persistLocalOnly();
}

function weekTotals() {
  const today = dayKey();
  let week = 0, prev = 0;
  for (let i = 0; i < 7; i++) { week += valOn(shiftDay(today, -i)); prev += valOn(shiftDay(today, -i - 7)); }
  return { week, prev };
}
/* absolute stats for one rolling week; offset 0 = this week, 7 = last week */
function weekStats(offset = 0) {
  const today = dayKey();
  let min = 0, sessions = 0, deep = 0, rated = 0, activeDays = 0;
  for (let i = 0; i < 7; i++) {
    const k = shiftDay(today, -i - offset);
    min += minOn(k);
    const s = state.history[k] || 0;
    sessions += s;
    if (s > 0) activeDays++;
    const r = state.ratings[k];
    if (r) { deep += r.deep || 0; rated += (r.shallow || 0) + (r.solid || 0) + (r.deep || 0); }
  }
  return { min, sessions, deep, rated, activeDays };
}

function openReport() {
  const { streak } = computeStreak();
  document.getElementById("rStreak").textContent = streak;
  document.getElementById("rBest").textContent = Math.max(computeBest(), streak);
  document.getElementById("rXp").textContent = totalXp().toLocaleString();
  document.getElementById("rTotalFocus").textContent = fmtHours(totalMinutes());
  document.getElementById("rFreezes").textContent = state.freezes || 0;

  // weekly headline (this rolling week vs last). On a down week, lead with what
  // held (streak, showing up) - the honest number stays visible, never guilt-worded.
  const { week, prev } = weekTotals();
  document.getElementById("whCap").textContent = viewIsTime() ? "Focus this week" : "XP earned this week";
  document.getElementById("whVal").textContent = viewIsTime() ? fmtHours(week) : (week.toLocaleString() + " ⚡");
  const sub = document.getElementById("whSub");
  if (prev > 0) {
    const pct = Math.round(((week - prev) / prev) * 100);
    if (pct >= 0) {
      sub.innerHTML = `<b>+${pct}%</b> more than last week`;
    } else {
      const cur = weekStats();
      const held = streak > 0
        ? `Streak held at ${streak} day${streak === 1 ? "" : "s"} - a lighter week, but you kept showing up.`
        : cur.activeDays > 0
          ? `You showed up ${cur.activeDays} day${cur.activeDays === 1 ? "" : "s"} this week - ready for a fresh start.`
          : `A quiet week - ready for a fresh start.`;
      sub.innerHTML = `${held} <b class="down">${pct}%</b> vs last week`;
    }
  } else {
    sub.innerHTML = week > 0 ? "Your first week of focus 🌱" : "Do a session to start the week";
  }
  renderWeekCompare(streak);

  // sync the view toggle UI
  document.querySelectorAll(".vt-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === state.config.chartView));

  renderChart();
  renderHeat();
  renderHolidays();
  const hd = document.getElementById("holidayDate");
  if (hd) { hd.max = dayKey(); hd.value = ""; }
  const rm = document.getElementById("reportModal");
  rm.hidden = false; rm.classList.add("open");
}

/* "you vs last-week you" rows: absolute numbers with honest deltas. The deep-focus
   row only appears once rating data exists. */
function renderWeekCompare(streak) {
  const box = document.getElementById("weekCompare");
  if (!box) return;
  const cur = weekStats(), last = weekStats(7);
  box.innerHTML = "";
  const row = (name, val, delta, cls = "") => {
    const div = document.createElement("div");
    div.className = "wkc-row";
    div.innerHTML = `<span class="wkc-name"></span><b class="wkc-val"></b><span class="wkc-delta ${cls}"></span>`;
    div.children[0].textContent = name;
    div.children[1].textContent = val;
    div.children[2].textContent = delta;
    box.appendChild(div);
  };
  const firstWeek = last.min === 0 && last.sessions === 0;
  const dm = cur.min - last.min;
  row("Focus time", fmtHours(cur.min),
    firstWeek ? "first week" : dm === 0 ? "same as last week" : `${dm > 0 ? "+" : "-"}${fmtHours(Math.abs(dm))} vs last week`,
    dm > 0 ? "up" : dm < 0 ? "down" : "");
  const ds = cur.sessions - last.sessions;
  row("Sessions", String(cur.sessions),
    firstWeek ? "first week" : ds === 0 ? "same as last week" : `${ds > 0 ? "+" : ""}${ds} vs last week`,
    ds > 0 ? "up" : ds < 0 ? "down" : "");
  if (cur.rated > 0 || last.rated > 0) {
    const pc = cur.rated ? Math.round((cur.deep / cur.rated) * 100) : 0;
    const pl = last.rated ? Math.round((last.deep / last.rated) * 100) : null;
    row("Deep focus", cur.rated ? `${pc}% of rated sessions` : "no rated sessions yet",
      pl == null ? "" : `last week ${pl}%`,
      pl != null && cur.rated ? (pc > pl ? "up" : pc < pl ? "down" : "") : "");
  }
  row("Streak", streak > 0 ? `Held - ${streak} day${streak === 1 ? "" : "s"}` : "Fresh start available", "");
}

/* fixed semantic palette for session depth - independent of the theme color so
   the stacked bars stay readable on the white modal */
const QUALITY_COLORS = { deep: "#104281", solid: "#2a78d6", shallow: "#86b6ef", unrated: "#b3b8c2" };
function ratingsOn(k) {
  const r = state.ratings[k] || {};
  return { shallow: r.shallow || 0, solid: r.solid || 0, deep: r.deep || 0 };
}

function renderChart() {
  const chart = document.getElementById("chart");
  chart.innerHTML = "";
  const today = dayKey();
  const narrow = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
  const fmtBar = (v) => viewIsTime() ? fmtHours(v) : (v + " XP");
  // build 7 rolling days, oldest -> today (left to right)
  const cols = [];
  let max = 0;
  for (let i = 6; i >= 0; i--) {
    const k = shiftDay(today, -i);
    const cur = valOn(k);
    const prev = valOn(shiftDay(k, -7));
    max = Math.max(max, cur, prev);
    const [y, m, d] = k.split("-").map(Number);
    cols.push({ k, cur, prev, label: narrow.format(new Date(y, m - 1, d)), isToday: k === today });
  }
  // scale to a "nice" ceiling so bars are relative and the axis reads cleanly
  const top = niceCeil(max);
  // y-axis labels (top, mid, 0)
  const axisLabel = (v) => viewIsTime() ? ((v >= 60 && v % 60 === 0) ? (v / 60) + "h" : v + "m") : v;
  document.getElementById("chartY").innerHTML =
    `<span>${axisLabel(top)}</span><span>${axisLabel(top / 2)}</span><span>0</span>`;
  cols.forEach((c) => {
    const col = document.createElement("div");
    col.className = "chart-col";
    col.innerHTML = `
      <div class="chart-bars">
        <div class="bar cur" title="${fmtBar(c.cur)} this week" style="height:${(c.cur / top) * 100}%"></div>
        <div class="bar prev" style="height:${(c.prev / top) * 100}%" title="${fmtBar(c.prev)} last week"></div>
      </div>
      <div class="chart-lbl${c.isToday ? " today" : ""}">${c.label}</div>`;
    // split the day's bar into depth segments, bottom -> top: deep, solid, shallow, unrated
    const bar = col.querySelector(".bar.cur");
    const rated = ratingsOn(c.k);
    const ratedSum = rated.deep + rated.solid + rated.shallow;
    // clamp for the cross-device merge edge where rated counts can exceed merged history
    const denom = Math.max(state.history[c.k] || 0, ratedSum);
    const parts = denom === 0
      ? [["unrated", 1, 0]]
      : [
          ["deep", rated.deep / denom, rated.deep],
          ["solid", rated.solid / denom, rated.solid],
          ["shallow", rated.shallow / denom, rated.shallow],
          ["unrated", (denom - ratedSum) / denom, denom - ratedSum],
        ];
    parts.forEach(([q, frac, n]) => {
      if (frac <= 0) return;
      const seg = document.createElement("div");
      seg.className = "seg";
      seg.style.height = (frac * 100) + "%";
      seg.style.background = QUALITY_COLORS[q];
      if (n > 0) seg.title = `${n} ${q === "deep" ? "deep flow" : q} session${n === 1 ? "" : "s"}`;
      bar.appendChild(seg);
    });
    chart.appendChild(col);
  });
}
/* round up to a clean axis ceiling: 1,2,2.5,5,10 x 10^n */
function niceCeil(n) {
  if (n <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  for (const s of [1, 2, 3, 5, 10]) if (n <= s * pow) return s * pow;
  return 10 * pow;
}

/* toast */
let toastTimer = null;
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}
/* Mark/unmark a day as a holiday. Free, retroactive: marking a past gap day
   immediately heals the streak because computeStreak walks dayCovered(). */
function setHoliday(key, on) {
  if (!key) return;
  if (on) state.holidays[key] = true;
  else delete state.holidays[key];
  save();
  renderAll();        // streak chip + week strip
  renderHolidays();   // the chip list in the profile
  // keep the profile numbers (streak/best) and heatmap in sync if it's open
  const rm = document.getElementById("reportModal");
  if (rm && !rm.hidden) {
    document.getElementById("rStreak").textContent = computeStreak().streak;
    document.getElementById("rBest").textContent = Math.max(computeBest(), computeStreak().streak);
    renderHeat();
  }
}
function renderHolidays() {
  const list = document.getElementById("holidayList");
  if (!list) return;
  const keys = Object.keys(state.holidays).sort().reverse();
  list.innerHTML = "";
  if (!keys.length) {
    list.innerHTML = `<span class="hol-empty">No days marked yet.</span>`;
    return;
  }
  keys.forEach((k) => {
    const [y, m, d] = k.split("-").map(Number);
    const label = new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const chip = document.createElement("button");
    chip.className = "hol-chip";
    chip.type = "button";
    chip.innerHTML = `🌴 ${label} <span class="hol-x" aria-hidden="true">×</span>`;
    chip.title = `Remove holiday on ${k}`;
    chip.addEventListener("click", () => setHoliday(k, false));
    list.appendChild(chip);
  });
}
function heatColor(n) {
  if (!n) return "#ebedf0";
  if (n < 2) return "#c6e48b";
  if (n < 4) return "#7bc96f";
  if (n < 6) return "#239a3b";
  return "#196127";
}
function renderHeat() {
  const heat = document.getElementById("heat");
  heat.innerHTML = "";
  const weeks = 13;
  // start on the Sunday of the earliest visible week
  const today = new Date();
  const startOffset = (weeks - 1) * 7 + today.getDay();
  for (let w = 0; w < weeks; w++) {
    const col = document.createElement("div");
    col.className = "heat-col";
    for (let d = 0; d < 7; d++) {
      const dayIdx = w * 7 + d;
      const date = new Date(today);
      date.setDate(today.getDate() - (startOffset - dayIdx));
      const cell = document.createElement("div");
      cell.className = "heat-cell";
      if (date <= today) {
        const dk = dayKey(date);
        const n = state.history[dk] || 0;
        cell.style.background = heatColor(n);
        if (state.holidays[dk]) {
          cell.classList.add("holiday");
          cell.title = `${dk}: holiday 🌴${n ? ` · ${n} session${n === 1 ? "" : "s"}` : ""}`;
        } else {
          cell.title = `${dk}: ${n} session${n === 1 ? "" : "s"}`;
        }
      } else {
        cell.style.visibility = "hidden";
      }
      col.appendChild(cell);
    }
    heat.appendChild(col);
  }
}

/* ---------------- settings binding ---------------- */
const COLORS = ["186 73 73", "56 133 138", "57 112 151", "166 98 42", "108 77 137", "159 67 135", "74 121 80", "79 104 120"];
function buildSwatches() {
  const box = document.getElementById("swatches");
  box.innerHTML = "";
  COLORS.forEach((c) => {
    const s = document.createElement("div");
    s.className = "swatch" + (c === state.config.color ? " sel" : "");
    s.style.background = `rgb(${c})`;
    s.addEventListener("click", () => {
      state.config.color = c; saveConfig();
      if (mode === "pomodoro") applyMode();
      buildSwatches();
    });
    box.appendChild(s);
  });
}
function bindToggle(id, key, onChange) {
  const t = document.getElementById(id);
  t.classList.toggle("on", !!state.config[key]);
  t.addEventListener("click", () => {
    state.config[key] = !state.config[key];
    t.classList.toggle("on", state.config[key]);
    saveConfig();
    if (onChange) onChange(state.config[key]);
  });
}
function bindNumber(id, key, onChange) {
  const inp = document.getElementById(id);
  inp.value = state.config[key];
  inp.addEventListener("change", () => {
    const v = Math.max(1, parseInt(inp.value) || 1);
    inp.value = v; state.config[key] = v; saveConfig();
    if (onChange) onChange(v);
  });
}
/* refresh all settings controls from state.config (after a sync merge) */
function syncSettingsUI() {
  const setVal = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  const setTog = (id, on) => { const e = document.getElementById(id); if (e) e.classList.toggle("on", !!on); };
  setVal("cfgPomodoro", state.config.pomodoro);
  setVal("cfgShort", state.config.short);
  setVal("cfgLong", state.config.long);
  setVal("cfgInterval", state.config.interval);
  setVal("cfgGoal", state.config.goal);
  setVal("cfgAlarm", state.config.alarm);
  setVal("cfgVolume", Math.round((state.config.volume ?? 0.5) * 100));
  setVal("cfgRepeat", state.config.alarmRepeat || 1);
  setTog("cfgAutoBreak", state.config.autoBreak);
  setTog("cfgAutoPomo", state.config.autoPomo);
  setTog("cfgSound", state.config.sound);
  setTog("cfgClick", state.config.click);
  setTog("cfgRestWeekends", state.config.restWeekends);
  setTog("cfgNotify", state.config.notify);
  buildSwatches();
}
function openSettings() {
  syncSettingsUI();
  const sm = document.getElementById("settingsModal");
  sm.hidden = false; sm.classList.add("open");
}

/* ---------------- export / import ---------------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `nicofocus-backup-${dayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      state = normalize({ ...structuredClone(DEFAULTS), ...data, config: { ...DEFAULTS.config, ...(data.config || {}) } });
      save();
      resetTimerTo("pomodoro");
      renderAll(); syncSettingsUI();
      alert("Data imported.");
    } catch (e) { alert("Could not read that file."); }
  };
  reader.readAsText(file);
}

/* ---------------- events ---------------- */
el.startBtn.addEventListener("click", toggleTimer);
el.skipBtn.addEventListener("click", () => {
  playClick();
  // skipping a pomodoro does NOT count toward the streak
  if (mode === "pomodoro") { ensureCycleForToday(); state.pomoSinceLong = (state.pomoSinceLong || 0) + 1; if (state.pomoSinceLong >= state.config.interval) state.pomoSinceLong = 0; save(); resetTimerTo(state.pomoSinceLong === 0 ? "long" : "short"); }
  else resetTimerTo("pomodoro");
  renderAll();
});
document.querySelectorAll(".mode-btn").forEach((b) =>
  b.addEventListener("click", () => { playClick(); resetTimerTo(b.dataset.mode); })
);
document.getElementById("celBtn").addEventListener("click", () => {
  const cel = document.getElementById("celebrate");
  cel.classList.remove("open"); cel.hidden = true;
});

(() => {
  const form = document.getElementById("goalForm");
  const btn = document.getElementById("addGoal");
  const nameInput = document.getElementById("goalNameInput");
  const deadlineInput = document.getElementById("goalDeadline");
  const enoughInput = document.getElementById("goalEnough");
  let editing = null; // goal being edited, null when creating
  function openForm(g = null) {
    editing = g;
    nameInput.value = g ? g.name : "";
    deadlineInput.value = (g && g.deadline) || "";
    enoughInput.value = (g && g.enough) || "";
    btn.hidden = true; form.hidden = false; nameInput.focus();
  }
  function closeForm() { editing = null; form.hidden = true; btn.hidden = false; }
  function saveForm() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    if (editing) {
      editing.name = name;
      editing.deadline = deadlineInput.value || null;
      editing.enough = enoughInput.value.trim() || null;
    } else {
      const goal = { id: newId(), name, deadline: deadlineInput.value || null, enough: enoughInput.value.trim() || null, checkpoints: [], createdAt: Date.now(), completedAt: null };
      state.goals.push(goal);
      state.activeGoal = goal.id; // open it so the first checkpoints get added right away
    }
    save(); renderGoals(); closeForm();
  }
  btn.addEventListener("click", () => openForm());
  openGoalEditor = openForm;
  document.getElementById("goalCancel").addEventListener("click", closeForm);
  document.getElementById("goalSave").addEventListener("click", saveForm);
  [nameInput, enoughInput].forEach((inp) => inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveForm(); }
    else if (e.key === "Escape") { e.preventDefault(); closeForm(); }
  }));
})();
document.getElementById("clearDone").addEventListener("click", () => {
  state.goals = state.goals.filter((g) => !g.completedAt);
  if (state.activeGoal && !state.goals.find((g) => g.id === state.activeGoal)) state.activeGoal = null;
  save(); renderGoals();
});

/* planning hints: one evidence-based tip at a time, rotating with the day */
const PLANNING_TIPS = [
  { tip: "Plan only the next 1-3 checkpoints", detail: "You never need the whole plan. Finish them, look at what you learned, then plan the next 1-3. Iterative projects succeed about 3x more often than fully pre-planned ones.", source: "Standish Group, CHAOS reports" },
  { tip: "Fix the deadline, flex the scope", detail: "Give the goal a hard date and shrink what 'enough' means to fit it, instead of working until it's done. Timeboxing ranked #1 among 100 productivity techniques.", source: "Zao-Sanders, Harvard Business Review 2018" },
  { tip: "Define 'enough' before you start", detail: "Decide the smallest complete version you would accept by the deadline. Ship that, then improve in cycles - like iterating on a prompt until the result is good.", source: "MVP principle, iterative development" },
  { tip: "Don't trust your first time estimate", detail: "Thesis students predicted 34 days and took 55; only 30% finished by their own predicted date. Assume your gut lowballs it and estimate from real past durations of similar work.", source: "Buehler, Griffin & Ross 1994, the planning fallacy" },
  { tip: "Write checkpoints as physical actions", detail: "'Open the doc and write one bad paragraph' beats 'work on chapter 2'. When the next step is concrete there is nothing left to decide when you sit down.", source: "David Allen, Getting Things Done" },
  { tip: "Use if-then plans", detail: "'If it's 9am after coffee, then I start checkpoint 1.' Deciding when and where in advance raised goal attainment with a medium-to-large effect (d = 0.65) across 94 studies.", source: "Gollwitzer & Sheeran 2006, meta-analysis" },
  { tip: "On unfamiliar work, set learning goals", detail: "When you don't yet know how, aim to 'try 2 approaches and compare' rather than to hit an outcome number. Outcome goals on novel tasks cause tunnel vision and hurt performance.", source: "Locke & Latham 2006" },
  { tip: "Do WOOP for hard goals", detail: "Wish, Outcome, Obstacle, Plan: picture the best result, honestly name the inner obstacle, then make an if-then plan for that obstacle. Beats positive thinking alone (g = 0.34).", source: "Oettingen, Rethinking Positive Thinking" },
  { tip: "Shrink the step until it can't fail", detail: "Scale the next checkpoint down until you'd do it on your worst day. Behavior happens when it's easy enough; motivation is the least reliable lever.", source: "BJ Fogg, Tiny Habits (B=MAP)" },
  { tip: "End every session with a small win", detail: "One concrete piece of visible progress per session, however small. In 12,000 diary entries, progress on meaningful work was the #1 driver of good days.", source: "Amabile & Kramer, The Progress Principle" },
  { tip: "Count checkpoints, not percent", detail: "You can't know what percent of an open-ended goal is done, so don't measure it. Track steps completed and days of showing up - the inputs you control.", source: "leading vs lagging indicators" },
  { tip: "A redo is an iteration, not a failure", detail: "First plans are wrong in ways you can only discover by working. When something has to be redone, that's the plan improving - the same way a second prompt beats the first.", source: "iterative development" },
];
let tipIdx = null;
function renderTip() {
  const t = PLANNING_TIPS[tipIdx];
  document.getElementById("tipMain").textContent = t.tip;
  document.getElementById("tipDetail").textContent = t.detail;
  document.getElementById("tipSource").textContent = t.source;
  document.getElementById("tipCount").textContent = (tipIdx + 1) + " / " + PLANNING_TIPS.length;
}
document.getElementById("planHint").addEventListener("click", () => {
  playClick();
  if (tipIdx == null) tipIdx = dayNumber() % PLANNING_TIPS.length;
  renderTip();
  const hm = document.getElementById("hintModal");
  hm.hidden = false; hm.classList.add("open");
});
document.getElementById("tipPrev").addEventListener("click", () => { tipIdx = (tipIdx - 1 + PLANNING_TIPS.length) % PLANNING_TIPS.length; renderTip(); });
document.getElementById("tipNext").addEventListener("click", () => { tipIdx = (tipIdx + 1) % PLANNING_TIPS.length; renderTip(); });

document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("reportBtn").addEventListener("click", openReport);
el.streakChip.addEventListener("click", openReport);
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => document.querySelectorAll(".overlay").forEach((o) => { o.classList.remove("open"); o.hidden = true; }))
);
document.querySelectorAll(".overlay").forEach((o) =>
  o.addEventListener("click", (e) => { if (e.target === o) { o.classList.remove("open"); o.hidden = true; } })
);

document.getElementById("exportBtn").addEventListener("click", exportData);
document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
document.getElementById("importFile").addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); });
document.getElementById("resetBtn").addEventListener("click", () => {
  if (confirm("Erase ALL sessions, streak and goals? This cannot be undone.")) {
    state = structuredClone(DEFAULTS); ensureJoined(); save();
    try { localStorage.removeItem(TIMER_KEY); } catch (e) {}
    resetTimerTo("pomodoro"); renderAll(); syncSettingsUI();
    document.querySelectorAll(".overlay").forEach((o) => { o.classList.remove("open"); o.hidden = true; });
  }
});

bindNumber("cfgPomodoro", "pomodoro", () => { if (!running && mode === "pomodoro") resetTimerTo("pomodoro"); });
bindNumber("cfgShort", "short");
bindNumber("cfgLong", "long");
bindNumber("cfgInterval", "interval", () => renderAll());
bindNumber("cfgGoal", "goal", () => renderAll());
bindToggle("cfgAutoBreak", "autoBreak");
bindToggle("cfgAutoPomo", "autoPomo");
bindToggle("cfgSound", "sound");
bindToggle("cfgClick", "click");
bindToggle("cfgRestWeekends", "restWeekends", () => renderAll());
bindToggle("cfgNotify", "notify", (on) => {
  if (on && typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
});

(() => {
  const hd = document.getElementById("holidayDate");
  if (!hd) return;
  // open the native calendar from the label button when supported
  document.getElementById("holidayAdd").addEventListener("click", () => {
    try { if (hd.showPicker) hd.showPicker(); else hd.focus(); }
    catch (e) { hd.focus(); }
  });
  hd.addEventListener("change", () => {
    const k = hd.value; // already YYYY-MM-DD
    if (!k) return;
    if (k > dayKey()) { toast("You can only mark today or a past day."); hd.value = ""; return; }
    if (state.holidays[k]) { toast("That day is already a holiday 🌴"); }
    else { setHoliday(k, true); toast("🌴 Holiday marked, streak protected."); }
    hd.value = "";
  });
})();
document.querySelectorAll(".vt-btn").forEach((b) =>
  b.addEventListener("click", () => { state.config.chartView = b.dataset.view; saveConfig(); openReport(); })
);

/* sound controls */
(() => {
  const alarmSel = document.getElementById("cfgAlarm");
  alarmSel.value = state.config.alarm;
  alarmSel.addEventListener("change", () => { state.config.alarm = alarmSel.value; saveConfig(); playAlarm(); });

  const vol = document.getElementById("cfgVolume");
  vol.value = Math.round((state.config.volume ?? 0.5) * 100);
  vol.addEventListener("input", () => { state.config.volume = vol.value / 100; saveConfig(); });
  vol.addEventListener("change", () => playClick());

  const rep = document.getElementById("cfgRepeat");
  rep.value = state.config.alarmRepeat || 1;
  rep.addEventListener("change", () => {
    state.config.alarmRepeat = Math.max(1, parseInt(rep.value) || 1);
    rep.value = state.config.alarmRepeat; saveConfig();
  });

  document.getElementById("testSound").addEventListener("click", playAlarm);
})();

/* keyboard shortcuts */
document.addEventListener("keydown", (e) => {
  if (/input|textarea/i.test(e.target.tagName)) return;
  // let browser shortcuts through (Cmd+R reload, Cmd+S save, etc.) instead of
  // firing our single-key shortcuts and flashing a modal open before the action
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.code === "Space") { e.preventDefault(); toggleTimer(); }
  else if (k === "1") resetTimerTo("pomodoro");
  else if (k === "2") resetTimerTo("short");
  else if (k === "3") resetTimerTo("long");
  else if (k === "s") openSettings();
  else if (k === "r") openReport();
});

/* recompute time when tab regains focus (handles long sleeps), and fire any
   celebration that was deferred because the tab wasn't focused */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (running && Date.now() >= endAt) finishMode(); // elapsed during deep background throttle
  else renderTime();
  maybeFreeze();
  if (pendingCelebration) { const f = pendingCelebration; pendingCelebration = null; f(); }
});
/* if the day rolls over while the page is open, refresh the streak view */
let lastDay = dayKey();
setInterval(() => { const d = dayKey(); if (d !== lastDay) { lastDay = d; maybeFreeze(); renderAll(); } }, 60 * 1000);

/* first-run join date + auto-apply freezes to cover missed work days */
function ensureJoined() {
  if (!state.joined) { state.joined = dayKey(); persistLocalOnly(); }
}
function maybeFreeze() {
  const saved = applyFreezes();
  if (saved > 0) {
    toast(`🧊 A streak freeze saved your streak!`);
    notify(`A streak freeze kept your ${computeStreak().streak}-day streak alive.`);
    renderAll();
  }
}
/* repair via sync: sessions done on another device can complete the comeback */
function maybeRepair() {
  const offer = repairOffer();
  if (!offer || (state.history[dayKey()] || 0) < REPAIR_SESSIONS) return false;
  offer.gap.forEach((d) => { state.repairedDays[d] = true; });
  persistLocalOnly();
  toast(`💪 Streak repaired - ${computeStreak().streak} days. Welcome back.`);
  return true;
}

/* ---------------- Google Drive sync ---------------- */
/* Offline-first: localStorage is always the live store. Drive is a sync layer on
   top. The app fully works signed out; sync just mirrors a private nicofocus.json
   into a hidden per-app folder in YOUR Google Drive (drive.appdata scope only). */
let tokenClient = null, accessToken = null, driveFileId = null, tokenExpiry = 0;
let signedIn = false, syncing = false, lastSyncAt = 0, pushTimer = null, refreshTimer = null;

/* Google access tokens only live ~1h, and there's no refresh token without a backend.
   So while the app is open we renew silently a couple minutes before expiry: on
   desktop/Android Chrome this needs no popup (the Google session is still alive), so
   you stay "Synced" all day instead of seeing "Reconnect" every hour. iOS Safari may
   still block the silent renew (tracking prevention) and fall back to the button. */
function scheduleTokenRefresh() {
  clearTimeout(refreshTimer);
  if (!tokenExpiry || localStorage.getItem(CONNECTED_KEY) !== "1") return;
  const lead = 2 * 60 * 1000;
  const delay = Math.max(15000, tokenExpiry - Date.now() - lead);
  refreshTimer = setTimeout(() => {
    if (localStorage.getItem(CONNECTED_KEY) === "1") connectGoogle(false); // silent renew
  }, delay);
}
const TOKEN_KEY = "nicofocus.token", TOKEN_EXP_KEY = "nicofocus.tokenExp";
const CONNECTED_KEY = "nicofocus.connected", GCLIENT_KEY = "nicofocus.gclient";

function getClientId() {
  return GOOGLE_CLIENT_ID || (localStorage.getItem(GCLIENT_KEY) || "").trim();
}

function waitForGsi(cb, tries = 0) {
  if (window.google && google.accounts && google.accounts.oauth2) return cb();
  if (tries > 40) return; // give up after ~10s
  setTimeout(() => waitForGsi(cb, tries + 1), 250);
}

function initSync() {
  updateSyncUI();
  const cid = getClientId();
  if (!cid) return;
  // 1) reuse a still-valid token from a previous session: sync immediately, NO popup.
  //    (A bearer token works without cookies, so this also sidesteps Safari's
  //    third-party-cookie block that makes silent re-auth fail on iOS.)
  const tok = localStorage.getItem(TOKEN_KEY);
  const exp = parseInt(localStorage.getItem(TOKEN_EXP_KEY) || "0", 10);
  if (tok && exp > Date.now() + 60000) {
    accessToken = tok; tokenExpiry = exp; signedIn = true;
    updateSyncUI();
    scheduleTokenRefresh();
    pullAndMerge().catch((e) => console.warn("sync on load failed", e));
  }
  waitForGsi(() => {
    try {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: DRIVE_SCOPE,
        callback: onToken,
        error_callback: (e) => { console.warn("auth error", e); syncing = false; updateSyncUI(); },
      });
      // 2) no valid token but connected before -> try a SILENT renew (no popup if it works)
      if (!signedIn && localStorage.getItem(CONNECTED_KEY) === "1") connectGoogle(false);
    } catch (e) { console.warn("initTokenClient failed", e); }
  });
}

function connectGoogle(interactive) {
  if (!getClientId()) {
    alert("Add your Google OAuth Client ID in Settings → Sync first.");
    openSettings();
    return;
  }
  if (!tokenClient) { initSync(); return; }
  try { tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" }); }
  catch (e) { console.warn(e); }
}

function clearToken() {
  accessToken = null; tokenExpiry = 0; signedIn = false; driveFileId = null;
  clearTimeout(refreshTimer);
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_EXP_KEY); } catch (e) {}
}
function disconnectGoogle() {
  if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken); } catch (e) {}
  }
  clearToken();
  localStorage.removeItem(CONNECTED_KEY);
  updateSyncUI();
}

async function onToken(resp) {
  if (!resp || !resp.access_token) { syncing = false; updateSyncUI(); return; }
  accessToken = resp.access_token;
  tokenExpiry = Date.now() + (parseInt(resp.expires_in, 10) || 3600) * 1000;
  signedIn = true;
  try {
    localStorage.setItem(TOKEN_KEY, accessToken);
    localStorage.setItem(TOKEN_EXP_KEY, String(tokenExpiry));
    localStorage.setItem(CONNECTED_KEY, "1");
  } catch (e) {}
  scheduleTokenRefresh();
  updateSyncUI();
  try { await pullAndMerge(); }
  catch (e) { console.warn("initial sync failed", e); syncing = false; updateSyncUI(); }
}

async function driveFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: "Bearer " + accessToken, ...(opts.headers || {}) },
  });
  if (res.status === 401) { // token invalid/expired -> drop it and try a silent renew
    clearToken(); updateSyncUI();
    if (localStorage.getItem(CONNECTED_KEY) === "1") connectGoogle(false);
    throw new Error("token expired");
  }
  return res;
}
async function driveFindFile() {
  const url = "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder"
    + "&fields=files(id,name)&q=" + encodeURIComponent("name='" + DRIVE_FILE + "'");
  const data = await (await driveFetch(url)).json();
  return (data.files && data.files[0]) || null;
}
async function driveReadFile(id) {
  return await (await driveFetch("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media")).json();
}
async function driveCreateFile(content) {
  const meta = { name: DRIVE_FILE, parents: ["appDataFolder"] };
  const boundary = "nfb" + Math.random().toString(16).slice(2);
  const body =
    "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(meta) +
    "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" +
    JSON.stringify(content) + "\r\n--" + boundary + "--";
  const res = await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body }
  );
  return (await res.json()).id;
}
async function driveUpdateFile(id, content) {
  await driveFetch("https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media",
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(content) });
}

/* Reconcile two copies. History/minutes use per-day MAX so a device with stale
   data can never erase a day's progress (protects the streak). Settings/tasks
   follow whichever copy was edited more recently. */
function mergeDocs(local, remote) {
  const mergeMax = (a = {}, b = {}) => {
    const o = { ...a };
    for (const k in b) o[k] = Math.max(o[k] || 0, b[k] || 0);
    return o;
  };
  const mergeTrue = (a = {}, b = {}) => ({ ...a, ...b }); // union of frozen / holiday / repaired days
  // per-day per-bucket max, same "stale device can't erase" rationale as history
  const mergeRatings = (a = {}, b = {}) => {
    const o = { ...a };
    for (const k in b) {
      const x = o[k] || {}, y = b[k] || {};
      o[k] = {
        shallow: Math.max(x.shallow || 0, y.shallow || 0),
        solid: Math.max(x.solid || 0, y.solid || 0),
        deep: Math.max(x.deep || 0, y.deep || 0),
      };
    }
    return o;
  };
  const newer = (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
  const older = newer === remote ? local : remote;
  // config follows the most recent CONFIG edit, independent of session activity,
  // so changing the daily goal on one device isn't overwritten by newer focus
  // sessions on another. (Was the bug: config rode the global updatedAt.)
  const cfgNewer = (remote.cfgUpdatedAt || 0) > (local.cfgUpdatedAt || 0) ? remote : local;
  const earliestJoin = [local.joined, remote.joined].filter(Boolean).sort()[0] || null;
  return {
    config: { ...DEFAULTS.config, ...(cfgNewer.config || {}) },
    history: mergeMax(local.history, remote.history),
    minutes: mergeMax(local.minutes, remote.minutes),
    xpByDay: mergeMax(local.xpByDay, remote.xpByDay),
    ratings: mergeRatings(local.ratings, remote.ratings),
    frozenDays: mergeTrue(local.frozenDays, remote.frozenDays),
    repairedDays: mergeTrue(local.repairedDays, remote.repairedDays),
    holidays: mergeTrue(local.holidays, remote.holidays),
    // ?? (not ||) so a blob from an old app version can't wipe goals, while a
    // deliberately emptied list still wins
    goals: newer.goals ?? older.goals ?? [],
    activeGoal: newer.activeGoal ?? null,
    pomoSinceLong: newer.pomoSinceLong || 0,
    cycleDay: newer.cycleDay ?? null,
    freezes: newer.freezes || 0,  // balance: latest device wins
    // latest day wins, safer than newest-doc-wins against cross-device double grants
    freezeEarnedOn: [local.freezeEarnedOn, remote.freezeEarnedOn].filter(Boolean).sort().pop() || null,
    joined: earliestJoin,
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
    cfgUpdatedAt: Math.max(local.cfgUpdatedAt || 0, remote.cfgUpdatedAt || 0),
  };
}

async function pullAndMerge() {
  if (!signedIn) return;
  syncing = true; updateSyncUI();
  const f = await driveFindFile();
  if (f) {
    driveFileId = f.id;
    const remote = await driveReadFile(f.id);
    // only adopt a new timer length if the timer is fresh (not mid-session/paused)
    const timerWasFresh = !running && Math.abs(remainingMs - modeDurationMs()) < 1500;
    state = mergeDocs(state, remote);
    ensureJoined();
    fillXpFromMinutes();
    applyFreezes();
    maybeRepair();
    persistLocalOnly();
    syncSettingsUI();
    if (timerWasFresh) remainingMs = modeDurationMs();
    applyMode(); renderTime(); renderAll(); buildSwatches();
    await driveUpdateFile(driveFileId, state); // converge remote to the merged copy
  } else {
    driveFileId = await driveCreateFile(state);
  }
  syncing = false; lastSyncAt = Date.now(); updateSyncUI();
}

function schedulePush() {
  if (!signedIn) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushNow().catch((e) => console.warn("push failed", e)); }, 1500);
}
async function pushNow() {
  if (!signedIn) return;
  syncing = true; updateSyncUI();
  if (!driveFileId) {
    const f = await driveFindFile();
    driveFileId = f ? f.id : await driveCreateFile(state);
  }
  if (driveFileId) await driveUpdateFile(driveFileId, state);
  syncing = false; lastSyncAt = Date.now(); updateSyncUI();
}

function updateSyncUI() {
  const label = document.getElementById("syncLabel");
  const status = document.getElementById("syncStatus");
  const connectBtn = document.getElementById("connectBtn");
  const wasConnected = localStorage.getItem(CONNECTED_KEY) === "1";
  if (label) label.textContent = signedIn ? (syncing ? "Syncing…" : "Synced") : (wasConnected ? "Reconnect" : "Sync");
  if (connectBtn) connectBtn.textContent = signedIn ? "Disconnect" : (wasConnected ? "Reconnect" : "Connect");
  if (status) {
    status.textContent = !getClientId()
      ? "Add your Google OAuth Client ID below to enable cross-device sync."
      : signedIn
        ? (syncing ? "Syncing with Google Drive…" : "Connected. Your data syncs to a private folder in your Google Drive.")
        : wasConnected
          ? "Session expired (Google sign-ins last about an hour). Tap Reconnect to sync again."
          : "Not connected. Tap Connect to sync this browser across devices.";
  }
}

/* sync-related events (bound once at boot; elements always present) */
document.getElementById("syncBtn").addEventListener("click", () => {
  signedIn ? openSettings() : connectGoogle(true);
});
document.getElementById("connectBtn").addEventListener("click", () => {
  signedIn ? disconnectGoogle() : connectGoogle(true);
});
(() => {
  const inp = document.getElementById("clientIdInput");
  inp.value = getClientId();
  inp.addEventListener("change", () => {
    localStorage.setItem(GCLIENT_KEY, inp.value.trim());
    tokenClient = null;
    initSync();
  });
})();

/* testing tools: only on localhost / file, never on the live site */
function isDev() {
  return location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
}
if (isDev()) {
  document.getElementById("devGroup").style.display = "";
  document.getElementById("testSession").addEventListener("click", () => {
    document.querySelectorAll(".overlay").forEach((o) => { o.classList.remove("open"); o.hidden = true; });
    showSessionComplete({ xp: 65, minutes: 45, todayCount: 2 }, () => {});
  });
  document.getElementById("testStreak").addEventListener("click", () => {
    const s = computeStreak().streak;
    celebrate(s, s + 1, false);
  });
  document.getElementById("testMilestone").addEventListener("click", () => celebrate(99, 100, true));
}

/* ---------------- boot ---------------- */
ensureJoined();
fillXpFromMinutes();
buildSwatches();
if (!restoreTimer()) resetTimerTo("pomodoro");
maybeFreeze();
renderAll();
initSync();
