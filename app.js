import {
  CATEGORY_META,
  uid,
  clamp,
  pad,
  formatClock,
  formatMinutes,
  dateKey,
  localDateTime,
  startOfDay,
  endOfDay,
  addDays,
  startOfWeek,
  startOfMonth,
  sessionsBetween,
  dayTotals,
  summarizeSessions,
  rangeFor,
  dailySeries,
  calendarDays,
  wordFrequencies,
  categoryTotals
} from "./core.js";

const STORAGE_KEY = "anhad:state:v1";
const RUNTIME_KEY = "anhad:runtime:v1";
const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"];
const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const QUOTES = [
  "La quietud también es una forma de escuchar.",
  "Vuelve al punto silencioso desde el que todo comienza.",
  "Cada práctica deja una huella, aunque hoy no puedas verla.",
  "La constancia vuelve visible lo que la prisa oculta.",
  "No necesitas llegar a ningún lugar: solo estar presente."
];

const defaultState = {
  version: 1,
  mode: "simple",
  simple: { luz: 30, sonido: 30 },
  advanced: {
    rounds: 2,
    openEnded: false,
    steps: [
      { id: "step-light", category: "luz", minutes: 25 },
      { id: "step-sound", category: "sonido", minutes: 20 },
      { id: "step-bhajans", category: "bhajanes", minutes: 10 }
    ]
  },
  settings: {
    theme: "system",
    dailyGoal: 90,
    weeklyGoal: 630,
    direction: "countdown",
    hideClock: false,
    bell: "cuenco",
    volume: 0.65,
    bellRepeats: 1,
    startBell: true,
    endBell: true,
    intervalMinutes: 0,
    fadeIn: true,
    vibration: true,
    sessionNotification: true,
    ambient: "none",
    quotes: true,
    tree: "Olivo",
    background: "ivory",
    customBell: null,
    customBellName: "",
    customBackground: null
  },
  currentProfileId: "profile-main",
  profiles: [{ id: "profile-main", name: "Práctica principal" }],
  presets: [],
  reminders: [],
  sessions: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hydrate(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const next = {
    ...clone(defaultState),
    ...safe,
    simple: { ...defaultState.simple, ...(safe.simple || {}) },
    advanced: { ...clone(defaultState.advanced), ...(safe.advanced || {}) },
    settings: { ...defaultState.settings, ...(safe.settings || {}) }
  };
  next.advanced.steps = Array.isArray(safe.advanced?.steps) && safe.advanced.steps.length
    ? safe.advanced.steps.filter((step) => CATEGORY_META[step.category]).map((step) => ({
        id: step.id || uid("step"),
        category: step.category,
        minutes: clamp(step.minutes, 1, 720)
      }))
    : clone(defaultState.advanced.steps);
  next.sessions = Array.isArray(safe.sessions) ? safe.sessions : [];
  next.reminders = Array.isArray(safe.reminders) ? safe.reminders : [];
  next.profiles = Array.isArray(safe.profiles) && safe.profiles.length ? safe.profiles : clone(defaultState.profiles);
  next.presets = Array.isArray(safe.presets) ? safe.presets : [];
  return next;
}

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

let state = hydrate(loadJSON(STORAGE_KEY, null));
let runtime = loadJSON(RUNTIME_KEY, null);
let timerHandle = null;
let reminderHandle = null;
let wakeLock = null;
let installPrompt = null;
let audioContext = null;
let ambientNodes = [];
let storageWarningShown = false;
let pwaRegistration = null;
let offlineReady = false;
let sessionAudio = null;
let scheduledBellNodes = [];
let sessionBellsScheduled = false;
let bellScheduleGeneration = 0;
let customBellBuffer = null;
let audioWarningShown = false;

const ui = {
  view: runtime ? "meditar" : "meditar",
  modal: null,
  detailId: null,
  calendarDate: dateKey(),
  calendarMonth: new Date().getMonth(),
  calendarYear: new Date().getFullYear(),
  activityRange: "all",
  statsRange: "1m",
  customFrom: dateKey(startOfMonth()),
  customTo: dateKey(),
  notesOpen: true
};

const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");

function showStorageWarning() {
  if (storageWarningShown) return;
  storageWarningShown = true;
  toast("No queda espacio para guardar más datos. Exporta una copia o elimina el fondo y sonido propios.", "warning");
}

function saveState({ notify = true } = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageWarningShown = false;
    return true;
  } catch (error) {
    console.warn("Anhad no pudo guardar el estado local.", error);
    if (notify) showStorageWarning();
    return false;
  }
}

function saveRuntime() {
  try {
    if (runtime) localStorage.setItem(RUNTIME_KEY, JSON.stringify(runtime));
    else localStorage.removeItem(RUNTIME_KEY);
    storageWarningShown = false;
    return true;
  } catch (error) {
    console.warn("Anhad no pudo guardar el temporizador local.", error);
    showStorageWarning();
    return false;
  }
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;"
  })[character]);
}

function toast(message, tone = "default") {
  const element = document.createElement("div");
  element.className = `toast ${tone}`;
  element.textContent = message;
  toastRegion.append(element);
  requestAnimationFrame(() => element.classList.add("show"));
  setTimeout(() => {
    element.classList.remove("show");
    setTimeout(() => element.remove(), 280);
  }, 3200);
}

function offlineStatusText() {
  if (offlineReady) return navigator.onLine ? "Lista para usar offline" : "Funcionando sin conexión";
  return navigator.onLine ? "Preparando modo offline…" : "Modo offline no preparado";
}

function updateOfflineIndicators() {
  document.querySelectorAll("[data-offline-status]").forEach((element) => {
    element.textContent = offlineStatusText();
  });
}

function todaySeconds() {
  return sessionsBetween(state.sessions, startOfDay(), endOfDay()).reduce((sum, session) => sum + (session.durationSec || 0), 0);
}

function weekSeconds() {
  return sessionsBetween(state.sessions, startOfWeek(), endOfDay()).reduce((sum, session) => sum + (session.durationSec || 0), 0);
}

function setTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.background = state.settings.background;
  document.documentElement.style.setProperty("--custom-background", state.settings.background === "custom" && state.settings.customBackground ? `url(${state.settings.customBackground})` : "none");
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = state.settings.theme === "dark" || (state.settings.theme === "system" && prefersDark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0f201f" : "#f7f3eb");
}

function brandMark() {
  return '<span class="brand-mark" aria-hidden="true"><i></i></span>';
}

function iconButton(icon, label, attrs = "") {
  return `<button class="icon-button" type="button" aria-label="${escapeHtml(label)}" ${attrs}>${icon}</button>`;
}

function shell(content, options = {}) {
  const mainViews = ["meditar", "calendario", "actividad", "stats"];
  const showNav = mainViews.includes(ui.view) && !runtime;
  const back = options.back
    ? iconButton("←", "Volver", 'data-action="back"')
    : `<a class="brand" href="#" data-nav="meditar" aria-label="Anhad, inicio">${brandMark()}<span>ANHAD</span></a>`;
  const right = options.right || iconButton("☼", "Abrir ajustes", 'data-nav="ajustes"');
  return `
    <div class="app-shell ${runtime ? "timer-shell" : ""}">
      <header class="topbar ${options.transparent ? "transparent" : ""}">
        ${back}
        ${options.title ? `<strong class="topbar-title">${escapeHtml(options.title)}</strong>` : ""}
        ${right}
      </header>
      <main class="main-content ${options.mainClass || ""}">${content}</main>
      ${showNav ? bottomNav() : ""}
    </div>
    ${renderModal()}`;
}

function bottomNav() {
  const items = [
    ["meditar", "◷", "Meditar"],
    ["calendario", "▦", "Calendario"],
    ["actividad", "↟", "Actividad"],
    ["stats", "▥", "Stats"]
  ];
  return `<nav class="bottom-nav" aria-label="Navegación principal">
    ${items.map(([view, icon, label]) => `<button type="button" class="${ui.view === view ? "active" : ""}" data-nav="${view}" aria-current="${ui.view === view ? "page" : "false"}"><span>${icon}</span>${label}</button>`).join("")}
  </nav>`;
}

function render() {
  setTheme();
  if (runtime?.status === "running" || runtime?.status === "paused") renderTimer();
  else if (runtime?.status === "complete") renderCompletion();
  else if (ui.view === "calendario") renderCalendar();
  else if (ui.view === "actividad") renderActivity();
  else if (ui.view === "stats") renderStats();
  else if (ui.view === "ajustes") renderSettings();
  else renderMeditate();
  bindCommonEvents();
}

function bindCommonEvents() {
  document.querySelectorAll("[data-nav]").forEach((element) => element.addEventListener("click", (event) => {
    event.preventDefault();
    ui.view = element.dataset.nav;
    ui.modal = null;
    render();
    scrollTo({ top: 0, behavior: "smooth" });
  }));
  document.querySelectorAll('[data-action="back"]').forEach((button) => button.addEventListener("click", () => {
    ui.view = "meditar";
    ui.modal = null;
    render();
  }));
  document.querySelectorAll('[data-action="close-modal"]').forEach((button) => button.addEventListener("click", closeModal));
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeModal();
  }));
}

function closeModal() {
  ui.modal = null;
  ui.detailId = null;
  render();
}

function simpleTotalMinutes() {
  return Number(state.simple.luz) + Number(state.simple.sonido);
}

function advancedCycleMinutes() {
  return state.advanced.steps.reduce((sum, step) => sum + Number(step.minutes), 0);
}

function renderMeditate() {
  const today = todaySeconds();
  const dailyTarget = state.settings.dailyGoal * 60;
  const goalPercent = clamp((today / dailyTarget) * 100, 0, 100);
  const stats = summarizeSessions(state.sessions, state.settings.dailyGoal);
  const total = state.mode === "simple" ? simpleTotalMinutes() : advancedCycleMinutes() * state.advanced.rounds;
  const greeting = new Date().getHours() < 12 ? "Buenos días" : new Date().getHours() < 20 ? "Buenas tardes" : "Buenas noches";
  const profile = state.profiles.find((item) => item.id === state.currentProfileId) || state.profiles[0];
  const content = `
    <section class="hero" aria-labelledby="timer-title">
      <div class="hero-kicker-row">
        <p class="eyebrow">${greeting.toUpperCase()} · ${escapeHtml(profile.name.toUpperCase())}</p>
        <span class="offline-chip"><i></i><span data-offline-status>${offlineStatusText()}</span></span>
      </div>
      <h1 id="timer-title">Tiempo para volver<br />a tu centro.</h1>

      <button class="goal-card" type="button" data-nav="calendario" aria-label="Ver progreso diario">
        <div class="goal-meta"><span>Objetivo diario</span><strong>${Math.round(today / 60)} <small>/ ${state.settings.dailyGoal} min</small></strong></div>
        <div class="goal-track"><span style="width:${goalPercent}%"></span></div>
        <small>${goalPercent >= 100 ? "Objetivo completado" : `Te faltan ${Math.max(0, state.settings.dailyGoal - Math.round(today / 60))} min`}</small>
      </button>

      <div class="motivation-strip">
        <div class="tree-mini" aria-hidden="true"><span>♣</span></div>
        <p><strong>${escapeHtml(state.settings.tree)} · nivel ${Math.max(1, Math.floor(stats.totalSec / 36000) + 1)}</strong><small>${stats.currentStreak ? `${stats.currentStreak} días de racha` : "Tu práctica comienza hoy"}</small></p>
        <button type="button" data-nav="stats" aria-label="Ver progreso">→</button>
      </div>

      <div class="mode-switch" role="tablist" aria-label="Modo de configuración">
        <button class="${state.mode === "simple" ? "active" : ""}" role="tab" aria-selected="${state.mode === "simple"}" data-mode="simple">Simple</button>
        <button class="${state.mode === "advanced" ? "active" : ""}" role="tab" aria-selected="${state.mode === "advanced"}" data-mode="advanced">Avanzado</button>
      </div>

      ${state.mode === "simple" ? renderSimpleEditor(total) : renderAdvancedEditor(total)}
    </section>`;
  app.innerHTML = shell(content);
  bindMeditateEvents();
}

function phaseRow(category, minutes, attrs = "") {
  const meta = CATEGORY_META[category];
  return `<div class="phase-row ${meta.className}">
    <span class="phase-icon">${meta.icon}</span>
    <div class="phase-name"><strong>${meta.label}</strong><small>${category === "luz" ? "Primera fase" : category === "sonido" ? "Segunda fase" : "Práctica complementaria"}</small></div>
    <label class="time-field"><span class="sr-only">Minutos de ${meta.label}</span><input type="number" min="1" max="720" value="${minutes}" ${attrs} /><small>min</small></label>
  </div>`;
}

function renderSimpleEditor(total) {
  return `<section class="practice-card" aria-labelledby="simple-heading">
    <div class="practice-heading">
      <div><p class="eyebrow">CICLO DE MEDITACIÓN</p><h2 id="simple-heading">Luz y Sonido</h2></div>
      <span class="duration-pill" id="total-duration">${total} min</span>
    </div>
    ${phaseRow("luz", state.simple.luz, 'data-simple="luz"')}
    <div class="connector"><span>♩</span><small>campana</small></div>
    ${phaseRow("sonido", state.simple.sonido, 'data-simple="sonido"')}
    ${startArea(total)}
  </section>`;
}

function renderAdvancedEditor(total) {
  return `<section class="practice-card advanced-card" aria-labelledby="advanced-heading">
    <div class="practice-heading">
      <div><p class="eyebrow">PROGRAMA PERSONALIZADO</p><h2 id="advanced-heading">Ciclo avanzado</h2></div>
      <span class="duration-pill" id="total-duration">${total} min</span>
    </div>
    <div class="round-control">
      <div><strong>Rondas del ciclo</strong><small>Como en un termociclador</small></div>
      <div class="stepper"><button type="button" data-round="minus" aria-label="Reducir rondas">−</button><b>${state.advanced.rounds}</b><button type="button" data-round="plus" aria-label="Aumentar rondas">+</button></div>
    </div>
    <div class="advanced-steps">
      ${state.advanced.steps.map((step, index) => advancedStep(step, index)).join('<div class="step-connector"><span>campana</span></div>')}
    </div>
    <button class="secondary-button add-step" type="button" data-action="choose-category">＋ Añadir paso</button>
    <div class="advanced-options">
      <label class="switch-row"><span><strong>Sesión abierta</strong><small>Cuenta hacia arriba sin límite</small></span><input type="checkbox" data-setting="openEnded" ${state.advanced.openEnded ? "checked" : ""} /><i></i></label>
      <button class="text-button" type="button" data-action="save-preset">Guardar como rutina</button>
    </div>
    ${startArea(total)}
  </section>`;
}

function advancedStep(step, index) {
  const meta = CATEGORY_META[step.category];
  return `<article class="advanced-step ${meta.className}" data-step-id="${step.id}">
    <span class="step-number">${index + 1}</span>
    <span class="phase-icon">${meta.icon}</span>
    <label class="category-select"><span class="sr-only">Categoría</span><select data-step-category="${step.id}">
      ${Object.entries(CATEGORY_META).map(([key, item]) => `<option value="${key}" ${key === step.category ? "selected" : ""}>${item.label}</option>`).join("")}
    </select></label>
    <label class="time-field"><span class="sr-only">Minutos</span><input type="number" min="1" max="720" value="${step.minutes}" data-step-minutes="${step.id}" /><small>min</small></label>
    <div class="step-actions">
      <button type="button" aria-label="Subir paso" data-move-step="${step.id}" data-direction="-1" ${index === 0 ? "disabled" : ""}>↑</button>
      <button type="button" aria-label="Bajar paso" data-move-step="${step.id}" data-direction="1" ${index === state.advanced.steps.length - 1 ? "disabled" : ""}>↓</button>
      <button type="button" aria-label="Eliminar paso" data-delete-step="${step.id}">×</button>
    </div>
  </article>`;
}

function startArea(total) {
  return `<button class="start-button" type="button" data-action="start-session"><span>${state.advanced.openEnded && state.mode === "advanced" ? "Comenzar sesión abierta" : "Comenzar meditación"}</span><b>→</b></button>
    <p class="bell-note">${state.settings.bell === "silencio" ? "Transiciones por vibración, sin sonido" : "Una campana suave marcará cada transición"} · <span data-meditation-total>${total || 0} min</span></p>`;
}

function updateMeditationTotals() {
  const total = state.mode === "simple" ? simpleTotalMinutes() : advancedCycleMinutes() * state.advanced.rounds;
  const totalDuration = document.querySelector("#total-duration");
  const totalNote = document.querySelector("[data-meditation-total]");
  if (totalDuration) totalDuration.textContent = `${total} min`;
  if (totalNote) totalNote.textContent = `${total || 0} min`;
}

function bindBoundedNumber(input, min, max, onValue, onUpdate = () => {}) {
  const applyValue = ({ normalize = false } = {}) => {
    if (input.value === "" && !normalize) return;
    const value = clamp(input.value, min, max);
    onValue(value);
    if (normalize) input.value = value;
    saveState();
    onUpdate(value);
  };
  input.addEventListener("input", () => applyValue());
  input.addEventListener("blur", () => applyValue({ normalize: true }));
}

function bindMeditateEvents() {
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    saveState();
    render();
  }));
  document.querySelectorAll("[data-simple]").forEach((input) => bindBoundedNumber(input, 1, 720, (value) => {
    state.simple[input.dataset.simple] = value;
  }, updateMeditationTotals));
  document.querySelectorAll("[data-step-minutes]").forEach((input) => bindBoundedNumber(input, 1, 720, (value) => {
    const step = state.advanced.steps.find((item) => item.id === input.dataset.stepMinutes);
    if (step) step.minutes = value;
  }, updateMeditationTotals));
  document.querySelectorAll("[data-step-category]").forEach((select) => select.addEventListener("change", () => {
    const step = state.advanced.steps.find((item) => item.id === select.dataset.stepCategory);
    if (step) {
      step.category = select.value;
      const article = select.closest("[data-step-id]");
      const meta = CATEGORY_META[step.category];
      article?.classList.remove(...Object.values(CATEGORY_META).map((item) => item.className));
      article?.classList.add(meta.className);
      const icon = article?.querySelector(".phase-icon");
      if (icon) icon.textContent = meta.icon;
    }
    saveState();
  }));
  document.querySelectorAll("[data-round]").forEach((button) => button.addEventListener("click", () => {
    state.advanced.rounds = clamp(state.advanced.rounds + (button.dataset.round === "plus" ? 1 : -1), 1, 99);
    saveState();
    render();
  }));
  document.querySelectorAll("[data-move-step]").forEach((button) => button.addEventListener("click", () => {
    const index = state.advanced.steps.findIndex((item) => item.id === button.dataset.moveStep);
    const next = index + Number(button.dataset.direction);
    if (index >= 0 && next >= 0 && next < state.advanced.steps.length) {
      [state.advanced.steps[index], state.advanced.steps[next]] = [state.advanced.steps[next], state.advanced.steps[index]];
      saveState();
      render();
    }
  }));
  document.querySelectorAll("[data-delete-step]").forEach((button) => button.addEventListener("click", () => {
    if (state.advanced.steps.length <= 1) return toast("El ciclo necesita al menos un paso.", "warning");
    state.advanced.steps = state.advanced.steps.filter((item) => item.id !== button.dataset.deleteStep);
    saveState();
    render();
  }));
  document.querySelector('[data-setting="openEnded"]')?.addEventListener("change", (event) => {
    state.advanced.openEnded = event.target.checked;
    saveState();
    const startLabel = document.querySelector('[data-action="start-session"] span');
    if (startLabel) startLabel.textContent = event.target.checked ? "Comenzar sesión abierta" : "Comenzar meditación";
  });
  document.querySelector('[data-action="choose-category"]')?.addEventListener("click", () => {
    ui.modal = "category";
    render();
  });
  document.querySelector('[data-action="save-preset"]')?.addEventListener("click", () => {
    ui.modal = "preset";
    render();
  });
  document.querySelector('[data-action="start-session"]')?.addEventListener("click", startSession);
}

function sequenceForCurrentMode() {
  if (state.mode === "simple") {
    return [
      { category: "luz", durationSec: state.simple.luz * 60, round: 1 },
      { category: "sonido", durationSec: state.simple.sonido * 60, round: 1 }
    ];
  }
  if (state.advanced.openEnded) {
    const first = state.advanced.steps[0];
    return [{ category: first.category, durationSec: null, round: 1 }];
  }
  return Array.from({ length: state.advanced.rounds }, (_, round) =>
    state.advanced.steps.map((step) => ({ category: step.category, durationSec: step.minutes * 60, round: round + 1 }))
  ).flat();
}

async function startSession() {
  const sequence = sequenceForCurrentMode();
  if (!sequence.length) return toast("Añade al menos un paso.", "warning");
  const backgroundPlayback = state.settings.sessionNotification ? startSessionAudio() : Promise.resolve(false);
  const audioReady = ensureAudio();
  const notificationPermission = state.settings.sessionNotification ? requestNotifications({ quiet: true }) : Promise.resolve(false);
  await audioReady.catch(() => null);
  const now = Date.now();
  runtime = {
    id: uid("session"),
    status: "running",
    mode: state.mode,
    sequence,
    stepIndex: 0,
    startedAt: now,
    phaseStartedAt: now,
    pausedAt: null,
    pausedTotalMs: 0,
    lastInterval: 0,
    notes: "",
    mood: ""
  };
  saveRuntime();
  await backgroundPlayback.catch(() => false);
  updateMediaSession();
  if (state.settings.startBell) await playBell(state.settings.bell, state.settings.bellRepeats).catch(showAudioError);
  scheduleSessionBells();
  if (await notificationPermission) updateSessionNotification();
  startAmbient();
  requestWakeLock();
  render();
  startTimerLoop();
}

function startTimerLoop() {
  clearInterval(timerHandle);
  timerHandle = setInterval(updateTimer, 250);
  updateTimer();
}

function currentPhaseElapsed(now = Date.now()) {
  if (!runtime) return 0;
  const effectiveNow = runtime.status === "paused" ? runtime.pausedAt : now;
  return Math.max(0, Math.floor((effectiveNow - runtime.phaseStartedAt) / 1000));
}

function totalElapsed(now = Date.now()) {
  if (!runtime) return 0;
  const effectiveNow = runtime.status === "paused" ? runtime.pausedAt : now;
  return Math.max(0, Math.floor((effectiveNow - runtime.startedAt - (runtime.pausedTotalMs || 0)) / 1000));
}

function updateTimer() {
  if (!runtime || runtime.status !== "running") return updateTimerDom();
  let phase = runtime.sequence[runtime.stepIndex];
  let phaseChanged = false;
  if (phase?.durationSec) {
    let elapsed = currentPhaseElapsed();
    while (phase && phase.durationSec && elapsed >= phase.durationSec && runtime?.status === "running") {
      const boundary = runtime.phaseStartedAt + phase.durationSec * 1000;
      if (runtime.stepIndex >= runtime.sequence.length - 1) {
        finishSession(true, boundary);
        return;
      }
      runtime.stepIndex += 1;
      runtime.phaseStartedAt = boundary;
      runtime.lastInterval = 0;
      if (!sessionBellsScheduled) playBell(state.settings.bell, 1).catch(showAudioError);
      saveRuntime();
      phase = runtime.sequence[runtime.stepIndex];
      elapsed = currentPhaseElapsed();
      phaseChanged = true;
    }
    const interval = Number(state.settings.intervalMinutes) * 60;
    if (interval > 0 && elapsed >= interval) {
      const intervalIndex = Math.floor(elapsed / interval);
      if (intervalIndex > (runtime.lastInterval || 0)) {
        runtime.lastInterval = intervalIndex;
        if (!sessionBellsScheduled) playBell(state.settings.bell, 1).catch(showAudioError);
        saveRuntime();
      }
    }
  }
  if (phaseChanged) {
    updateMediaSession();
    updateSessionNotification();
  }
  updateTimerDom();
}

function renderTimer() {
  const phase = runtime.sequence[runtime.stepIndex];
  const meta = CATEGORY_META[phase.category];
  const totalPlanned = runtime.sequence.reduce((sum, item) => sum + (item.durationSec || 0), 0);
  const completedPlanned = runtime.sequence.slice(0, runtime.stepIndex).reduce((sum, item) => sum + (item.durationSec || 0), 0);
  const phaseProgress = phase.durationSec ? clamp(currentPhaseElapsed() / phase.durationSec * 100, 0, 100) : 0;
  const roundCount = Math.max(...runtime.sequence.map((item) => item.round || 1));
  const upcoming = runtime.sequence.slice(runtime.stepIndex + 1, runtime.stepIndex + 4);
  const content = `
    <section class="timer-view ${meta.className}">
      <div class="timer-label"><span>${meta.icon}</span><p><small>${roundCount > 1 ? `RONDA ${phase.round} DE ${roundCount}` : "MEDITACIÓN EN CURSO"}</small><strong>${meta.label}</strong></p></div>
      <div class="timer-orbit" id="timer-orbit" style="--progress:${phaseProgress * 3.6}deg">
        <div class="timer-orbit-inner">
          <span class="timer-clock" id="timer-clock">${timerDisplayValue()}</span>
          <small id="timer-direction">${phase.durationSec ? (state.settings.direction === "countdown" ? "restantes" : "transcurridos") : "sesión abierta"}</small>
        </div>
      </div>
      <div class="session-progress">
        <span><b id="session-elapsed">${formatMinutes(totalElapsed(), { compact: true })}</b> de ${phase.durationSec ? formatMinutes(totalPlanned, { compact: true }) : "tiempo abierto"}</span>
        <div><i id="session-progress-bar" style="width:${totalPlanned ? clamp((completedPlanned + currentPhaseElapsed()) / totalPlanned * 100, 0, 100) : 0}%"></i></div>
      </div>
      ${upcoming.length ? `<div class="up-next"><small>DESPUÉS</small>${upcoming.map((item) => `<span><i class="${CATEGORY_META[item.category].className}">${CATEGORY_META[item.category].icon}</i>${CATEGORY_META[item.category].short}<b>${formatMinutes(item.durationSec, { compact: true })}</b></span>`).join("")}</div>` : ""}
      <div class="timer-actions">
        <button class="round-button" type="button" data-action="toggle-pause"><span>${runtime.status === "paused" ? "▶" : "Ⅱ"}</span>${runtime.status === "paused" ? "Continuar" : "Pausar"}</button>
        <button class="round-button danger" type="button" data-action="finish-session"><span>■</span>Finalizar</button>
      </div>
      <button class="focus-toggle" type="button" data-action="toggle-clock">${state.settings.hideClock ? "Mostrar reloj" : "Ocultar reloj"}</button>
    </section>`;
  const right = iconButton("•••", "Más opciones", 'data-nav="ajustes"');
  app.innerHTML = shell(content, { transparent: true, right, mainClass: state.settings.hideClock ? "clock-hidden" : "" });
  document.querySelector('[data-action="toggle-pause"]')?.addEventListener("click", togglePause);
  document.querySelector('[data-action="finish-session"]')?.addEventListener("click", () => finishSession(false));
  document.querySelector('[data-action="toggle-clock"]')?.addEventListener("click", () => {
    state.settings.hideClock = !state.settings.hideClock;
    saveState();
    render();
  });
  startTimerLoop();
}

function timerDisplayValue() {
  const phase = runtime.sequence[runtime.stepIndex];
  const elapsed = currentPhaseElapsed();
  if (!phase.durationSec || state.settings.direction === "countup") return formatClock(elapsed);
  return formatClock(Math.max(0, phase.durationSec - elapsed));
}

function updateTimerDom() {
  if (!runtime || !["running", "paused"].includes(runtime.status)) return;
  const phase = runtime.sequence[runtime.stepIndex];
  const elapsed = currentPhaseElapsed();
  const totalPlanned = runtime.sequence.reduce((sum, item) => sum + (item.durationSec || 0), 0);
  const completed = runtime.sequence.slice(0, runtime.stepIndex).reduce((sum, item) => sum + (item.durationSec || 0), 0);
  const phaseProgress = phase.durationSec ? clamp(elapsed / phase.durationSec * 100, 0, 100) : (elapsed % 60) / 60 * 100;
  const clock = document.querySelector("#timer-clock");
  const orbit = document.querySelector("#timer-orbit");
  const sessionElapsed = document.querySelector("#session-elapsed");
  const progress = document.querySelector("#session-progress-bar");
  if (clock) clock.textContent = timerDisplayValue();
  if (orbit) orbit.style.setProperty("--progress", `${phaseProgress * 3.6}deg`);
  if (sessionElapsed) sessionElapsed.textContent = formatMinutes(totalElapsed(), { compact: true });
  if (progress) progress.style.width = `${totalPlanned ? clamp((completed + elapsed) / totalPlanned * 100, 0, 100) : 0}%`;
}

function togglePause() {
  if (runtime.status === "running") {
    clearScheduledBells();
    runtime.status = "paused";
    runtime.pausedAt = Date.now();
    stopAmbient();
    pauseSessionAudio();
  } else {
    const pauseDuration = Date.now() - runtime.pausedAt;
    runtime.pausedTotalMs += pauseDuration;
    runtime.phaseStartedAt += pauseDuration;
    runtime.pausedAt = null;
    runtime.status = "running";
    startAmbient();
    (state.settings.sessionNotification ? startSessionAudio() : Promise.resolve(false)).then(() => {
      updateMediaSession();
      scheduleSessionBells();
    });
  }
  saveRuntime();
  updateMediaSession();
  updateSessionNotification();
  render();
}

function calculateBreakdown(atTime) {
  const breakdown = {};
  let remaining = Math.max(0, Math.floor((atTime - runtime.startedAt - (runtime.pausedTotalMs || 0)) / 1000));
  for (const phase of runtime.sequence) {
    const used = phase.durationSec ? Math.min(remaining, phase.durationSec) : remaining;
    breakdown[phase.category] = (breakdown[phase.category] || 0) + Math.max(0, used);
    remaining -= used;
    if (remaining <= 0) break;
  }
  return breakdown;
}

function finishSession(natural = false, forcedEnd = Date.now()) {
  if (!runtime || runtime.status === "complete") return;
  const bellsWereScheduled = sessionBellsScheduled;
  clearScheduledBells();
  if (runtime.status === "paused") forcedEnd = runtime.pausedAt;
  clearInterval(timerHandle);
  const durationSec = Math.max(1, Math.floor((forcedEnd - runtime.startedAt - (runtime.pausedTotalMs || 0)) / 1000));
  runtime.status = "complete";
  runtime.endedAt = forcedEnd;
  runtime.durationSec = durationSec;
  runtime.breakdown = calculateBreakdown(forcedEnd);
  runtime.natural = natural;
  saveRuntime();
  stopAmbient();
  stopSessionAudio();
  releaseWakeLock();
  if (state.settings.endBell && (!natural || !bellsWereScheduled)) playBell(state.settings.bell, state.settings.bellRepeats).catch(showAudioError);
  if (natural) showCompletedNotification();
  else closeSessionNotification();
  render();
}

function renderCompletion() {
  const quote = QUOTES[Math.abs(runtime.id.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)) % QUOTES.length];
  const categories = Object.entries(runtime.breakdown || {}).filter(([, seconds]) => seconds > 0);
  const content = `<section class="completion-view">
    <div class="completion-mark"><span>✓</span></div>
    <p class="eyebrow">SESIÓN COMPLETADA</p>
    <h1>Has vuelto<br />a tu centro.</h1>
    <div class="completion-duration"><strong>${formatClock(runtime.durationSec)}</strong><small>tiempo total meditado</small></div>
    <div class="completion-breakdown">${categories.map(([category, seconds]) => `<span class="${CATEGORY_META[category].className}"><i>${CATEGORY_META[category].icon}</i>${CATEGORY_META[category].short}<b>${formatMinutes(seconds, { compact: true })}</b></span>`).join("")}</div>
    <div class="mood-picker">
      <label>¿Cómo te sientes ahora?</label>
      <div>${[["sereno", "◡"], ["claro", "✦"], ["agradecido", "♡"], ["inquieto", "≈"]].map(([mood, icon]) => `<button type="button" class="${runtime.mood === mood ? "selected" : ""}" data-mood="${mood}"><span>${icon}</span>${mood}</button>`).join("")}</div>
    </div>
    <button class="notes-toggle" type="button" data-action="toggle-notes"><span>Notas</span><b>${ui.notesOpen ? "−" : "+"}</b></button>
    ${ui.notesOpen ? `<textarea class="notes-field" id="session-notes" rows="5" placeholder="¿Qué has observado durante esta sesión?">${escapeHtml(runtime.notes || "")}</textarea>` : ""}
    <button class="start-button save-session" type="button" data-action="save-session"><span>Guardar sesión</span><b>✓</b></button>
    <button class="text-button discard-button" type="button" data-action="discard-session">Descartar</button>
    ${state.settings.quotes ? `<blockquote>“${quote}”</blockquote>` : ""}
  </section>`;
  app.innerHTML = shell(content, { transparent: true, right: "<span></span>" });
  document.querySelectorAll("[data-mood]").forEach((button) => button.addEventListener("click", () => {
    runtime.mood = button.dataset.mood;
    saveRuntime();
    render();
  }));
  document.querySelector('[data-action="toggle-notes"]')?.addEventListener("click", () => {
    runtime.notes = document.querySelector("#session-notes")?.value || runtime.notes || "";
    ui.notesOpen = !ui.notesOpen;
    saveRuntime();
    render();
  });
  document.querySelector('[data-action="save-session"]')?.addEventListener("click", saveCompletedSession);
  document.querySelector('[data-action="discard-session"]')?.addEventListener("click", () => {
    if (!confirm("¿Descartar esta sesión sin guardarla?")) return;
    closeSessionNotification();
    runtime = null;
    saveRuntime();
    ui.view = "meditar";
    render();
  });
}

function saveCompletedSession() {
  runtime.notes = document.querySelector("#session-notes")?.value || runtime.notes || "";
  const firstCategory = Object.keys(runtime.breakdown || {})[0] || "luz";
  state.sessions.push({
    id: runtime.id,
    startedAt: new Date(runtime.startedAt).toISOString(),
    endedAt: new Date(runtime.endedAt || Date.now()).toISOString(),
    durationSec: runtime.durationSec,
    breakdown: runtime.breakdown,
    category: firstCategory,
    notes: runtime.notes.trim(),
    mood: runtime.mood,
    source: "timer",
    mode: runtime.mode
  });
  state.sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  saveState();
  closeSessionNotification();
  runtime = null;
  saveRuntime();
  ui.view = "calendario";
  ui.calendarDate = dateKey();
  toast("Sesión guardada. Tu progreso ya está actualizado.", "success");
  render();
}

function renderCalendar() {
  const days = calendarDays(ui.calendarYear, ui.calendarMonth);
  const totals = dayTotals(state.sessions);
  const selectedSessions = state.sessions.filter((session) => dateKey(session.startedAt) === ui.calendarDate);
  const selectedDate = localDateTime(ui.calendarDate);
  const selectedTotal = selectedSessions.reduce((sum, session) => sum + session.durationSec, 0);
  const selectedPercent = clamp(selectedTotal / (state.settings.dailyGoal * 60) * 100, 0, 100);
  const content = `<section class="section-view calendar-view">
    <div class="section-heading"><div><p class="eyebrow">CONSTANCIA DIARIA</p><h1>Calendario</h1></div><button class="today-button" type="button" data-action="calendar-today">Hoy</button></div>
    <div class="calendar-card">
      <div class="calendar-header"><button type="button" data-calendar-move="-1" aria-label="Mes anterior">←</button><strong>${MONTHS[ui.calendarMonth]} ${ui.calendarYear}</strong><button type="button" data-calendar-move="1" aria-label="Mes siguiente">→</button></div>
      <div class="calendar-weekdays">${WEEKDAYS.map((day) => `<span>${day}</span>`).join("")}</div>
      <div class="calendar-grid">
        ${days.map((day) => {
          const seconds = totals[day.key] || 0;
          const percent = clamp(seconds / (state.settings.dailyGoal * 60) * 100, 0, 100);
          return `<button type="button" class="calendar-day ${day.inMonth ? "" : "outside"} ${day.key === ui.calendarDate ? "selected" : ""} ${day.key === dateKey() ? "today" : ""}" data-calendar-date="${day.key}" aria-label="${day.date.toLocaleDateString("es", { dateStyle: "long" })}, ${Math.round(seconds / 60)} minutos">
            <span class="day-ring" style="--day-progress:${percent * 3.6}deg"><i>${day.date.getDate()}</i></span>
            ${seconds ? `<small>${Math.round(seconds / 60)}m</small>` : "<small>&nbsp;</small>"}
          </button>`;
        }).join("")}
      </div>
    </div>
    <div class="selected-day-card">
      <div class="selected-day-summary"><div><small>${selectedDate.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" })}</small><strong>${formatMinutes(selectedTotal, { compact: true })}</strong></div><span class="progress-ring-small" style="--day-progress:${selectedPercent * 3.6}deg"><i>${Math.round(selectedPercent)}%</i></span></div>
      ${selectedSessions.length ? `<div class="compact-session-list">${selectedSessions.map(sessionRow).join("")}</div>` : `<div class="empty-inline"><span>○</span><p>No hay sesiones este día.</p></div>`}
    </div>
  </section>`;
  app.innerHTML = shell(content);
  document.querySelectorAll("[data-calendar-move]").forEach((button) => button.addEventListener("click", () => {
    const date = new Date(ui.calendarYear, ui.calendarMonth + Number(button.dataset.calendarMove), 1);
    ui.calendarYear = date.getFullYear();
    ui.calendarMonth = date.getMonth();
    render();
  }));
  document.querySelector('[data-action="calendar-today"]')?.addEventListener("click", () => {
    const now = new Date();
    ui.calendarYear = now.getFullYear();
    ui.calendarMonth = now.getMonth();
    ui.calendarDate = dateKey(now);
    render();
  });
  document.querySelectorAll("[data-calendar-date]").forEach((button) => button.addEventListener("click", () => {
    ui.calendarDate = button.dataset.calendarDate;
    const date = localDateTime(ui.calendarDate);
    if (date.getMonth() !== ui.calendarMonth) {
      ui.calendarMonth = date.getMonth();
      ui.calendarYear = date.getFullYear();
    }
    render();
  }));
  bindSessionRows();
}

function sessionRow(session) {
  const categories = Object.keys(session.breakdown || { [session.category || "luz"]: 1 });
  return `<button type="button" class="session-row" data-session-id="${session.id}">
    <span class="session-icons">${categories.slice(0, 3).map((category) => `<i class="${CATEGORY_META[category]?.className || "cat-light"}">${CATEGORY_META[category]?.icon || "✦"}</i>`).join("")}</span>
    <span><strong>${new Date(session.startedAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</strong><small>${categories.map((category) => CATEGORY_META[category]?.short).filter(Boolean).join(" · ")}</small></span>
    <b>${formatMinutes(session.durationSec, { compact: true })}</b><em>›</em>
  </button>`;
}

function renderActivity() {
  const now = new Date();
  let filtered = state.sessions;
  if (ui.activityRange === "day") filtered = sessionsBetween(state.sessions, startOfDay(now), endOfDay(now));
  if (ui.activityRange === "week") filtered = sessionsBetween(state.sessions, startOfWeek(now), endOfDay(now));
  if (ui.activityRange === "month") filtered = sessionsBetween(state.sessions, startOfMonth(now), endOfDay(now));
  const groups = filtered.reduce((result, session) => {
    const key = dateKey(session.startedAt);
    (result[key] ||= []).push(session);
    return result;
  }, {});
  const content = `<section class="section-view activity-view">
    <div class="section-heading"><div><p class="eyebrow">TU PRÁCTICA</p><h1>Actividad</h1></div><button class="add-button" type="button" data-action="manual-session">＋ Añadir</button></div>
    <div class="filter-tabs">${[["day", "Día"], ["week", "Semana"], ["month", "Mes"], ["all", "Todo"]].map(([key, label]) => `<button type="button" class="${ui.activityRange === key ? "active" : ""}" data-activity-range="${key}">${label}</button>`).join("")}</div>
    ${filtered.length ? `<div class="activity-groups">${Object.entries(groups).map(([key, sessions]) => {
      const date = localDateTime(key);
      const total = sessions.reduce((sum, session) => sum + session.durationSec, 0);
      return `<section><div class="group-heading"><span>${date.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long", year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined })}</span><b>${formatMinutes(total, { compact: true })}</b></div><div class="session-list">${sessions.map(sessionRow).join("")}</div></section>`;
    }).join("")}</div>` : `<div class="empty-state"><span class="empty-mark">◷</span><h2>Todavía no hay sesiones</h2><p>Las sesiones guardadas aparecerán aquí con su fecha, duración y notas.</p><button class="secondary-button" type="button" data-action="manual-session">Añadir una sesión pasada</button></div>`}
  </section>`;
  app.innerHTML = shell(content);
  document.querySelectorAll("[data-activity-range]").forEach((button) => button.addEventListener("click", () => {
    ui.activityRange = button.dataset.activityRange;
    render();
  }));
  document.querySelectorAll('[data-action="manual-session"]').forEach((button) => button.addEventListener("click", () => {
    ui.modal = "manual";
    render();
  }));
  bindSessionRows();
}

function bindSessionRows() {
  document.querySelectorAll("[data-session-id]").forEach((button) => button.addEventListener("click", () => {
    ui.detailId = button.dataset.sessionId;
    ui.modal = "session";
    render();
  }));
}

function renderStats() {
  const { from, to } = rangeFor(ui.statsRange, state.sessions, ui.customFrom, ui.customTo);
  const filtered = sessionsBetween(state.sessions, from, to);
  const summary = summarizeSessions(filtered, state.settings.dailyGoal);
  const series = dailySeries(filtered, from, to);
  const maxSeconds = Math.max(state.settings.dailyGoal * 60, ...series.map((item) => item.seconds));
  const categories = categoryTotals(filtered);
  const categoryTotal = Object.values(categories).reduce((sum, seconds) => sum + seconds, 0) || 1;
  const words = wordFrequencies(filtered);
  const allSummary = summarizeSessions(state.sessions, state.settings.dailyGoal);
  const content = `<section class="section-view stats-view">
    <div class="section-heading"><div><p class="eyebrow">UNA MIRADA AMPLIA</p><h1>Estadísticas</h1></div><span class="streak-badge">♨ ${allSummary.currentStreak} días</span></div>
    <div class="range-tabs">${[["1m", "1 mes"], ["3m", "3 meses"], ["6m", "6 meses"], ["1y", "1 año"], ["all", "Siempre"], ["custom", "Personalizado"]].map(([key, label]) => `<button type="button" class="${ui.statsRange === key ? "active" : ""}" data-stats-range="${key}">${label}</button>`).join("")}</div>
    ${ui.statsRange === "custom" ? `<div class="custom-range"><label>Desde<input type="date" id="stats-from" value="${ui.customFrom}" /></label><label>Hasta<input type="date" id="stats-to" value="${ui.customTo}" /></label></div>` : ""}
    <div class="stats-grid">
      ${statCard("◷", "Tiempo total", formatMinutes(summary.totalSec, { compact: true }))}
      ${statCard("◎", "Meditaciones", summary.totalSessions)}
      ${statCard("↗", "Promedio", formatMinutes(summary.averageSec, { compact: true }))}
      ${statCard("♨", "Racha actual", `${summary.currentStreak} días`)}
      ${statCard("▦", "Sesiones este mes", summary.monthSessions)}
      ${statCard("▥", "Sesiones esta semana", summary.weekSessions)}
      ${statCard("✦", "Días activos / semana", summary.activeDaysAverage.toLocaleString("es", { maximumFractionDigits: 1 }))}
      ${statCard("♜", "Mejor racha", `${summary.longestStreak} días`)}
    </div>
    <section class="chart-card">
      <div class="chart-heading"><div><h2>Tiempo por día</h2><p>${from.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" })} — ${to.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" })}</p></div><span>meta ${state.settings.dailyGoal}m</span></div>
      ${series.length ? `<div class="bar-chart" style="--bar-count:${series.length}"><div class="goal-line" style="bottom:${clamp(state.settings.dailyGoal * 60 / maxSeconds * 100, 0, 100)}%"></div>${series.map((item, index) => `<div class="bar-column" title="${item.date.toLocaleDateString("es", { dateStyle: "long" })}: ${formatMinutes(item.seconds, { compact: true })}"><i style="height:${item.seconds ? Math.max(3, item.seconds / maxSeconds * 100) : 1}%" class="${item.seconds >= state.settings.dailyGoal * 60 ? "goal-met" : ""}"></i><small>${series.length <= 45 || index % Math.ceil(series.length / 30) === 0 ? item.date.getDate() : ""}</small></div>`).join("")}</div>` : ""}
      ${!filtered.length ? '<p class="chart-empty">Guarda una sesión para empezar a dibujar tu práctica.</p>' : ""}
    </section>
    <div class="insight-grid">
      <section class="category-card"><div class="chart-heading"><div><h2>Distribución</h2><p>Tiempo por práctica</p></div></div><div class="donut" style="${donutStyle(categories, categoryTotal)}"><span><b>${formatMinutes(categoryTotal === 1 ? 0 : categoryTotal, { compact: true })}</b><small>total</small></span></div><div class="legend">${Object.entries(categories).map(([category, seconds]) => `<span><i style="background:${CATEGORY_META[category].color}"></i>${CATEGORY_META[category].short}<b>${Math.round(seconds / categoryTotal * 100)}%</b></span>`).join("")}</div></section>
      <section class="word-card"><div class="chart-heading"><div><h2>Palabras de tus notas</h2><p>Lo que más aparece en tus reflexiones</p></div></div>${words.length ? `<div class="word-cloud">${words.map((item, index) => `<span style="--word-size:${clamp(0.85 + item.count * 0.18, 0.9, 1.8)}rem;--word-tone:${index % 4}">${escapeHtml(item.word)}</span>`).join("")}</div>` : '<div class="empty-inline"><span>✎</span><p>Añade notas al finalizar para ver aquí tus palabras.</p></div>'}</section>
    </div>
    <section class="milestone-card"><div class="tree-large"><span>♣</span><i></i></div><div><p class="eyebrow">TU ${escapeHtml(state.settings.tree).toUpperCase()}</p><h2>${Math.floor(allSummary.totalSec / 3600)} horas de raíces</h2><p>Cada 10 horas de práctica, tu árbol crece un nivel.</p><div class="goal-track"><span style="width:${(allSummary.totalSec / 3600 % 10) * 10}%"></span></div></div></section>
  </section>`;
  app.innerHTML = shell(content);
  document.querySelectorAll("[data-stats-range]").forEach((button) => button.addEventListener("click", () => {
    ui.statsRange = button.dataset.statsRange;
    render();
  }));
  document.querySelector("#stats-from")?.addEventListener("change", (event) => { ui.customFrom = event.target.value; render(); });
  document.querySelector("#stats-to")?.addEventListener("change", (event) => { ui.customTo = event.target.value; render(); });
}

function statCard(icon, label, value) {
  return `<article class="stat-card"><span>${icon}</span><p><small>${label}</small><strong>${value}</strong></p></article>`;
}

function donutStyle(totals, total) {
  let cursor = 0;
  const stops = Object.entries(totals).map(([category, seconds]) => {
    const start = cursor;
    cursor += seconds / total * 360;
    return `${CATEGORY_META[category].color} ${start}deg ${cursor}deg`;
  });
  return `--donut:conic-gradient(${stops.join(",") || "#d9d7cf 0 360deg"})`;
}

function renderSettings() {
  const content = `<section class="section-view settings-view">
    <div class="section-heading"><div><p class="eyebrow">A TU MANERA</p><h1>Ajustes</h1></div></div>
    <section class="settings-section"><div class="settings-heading"><span>◎</span><div><h2>Objetivos</h2><p>Se mantienen iguales cada día</p></div></div>
      <div class="two-fields"><label>Objetivo diario<div class="unit-input"><input type="number" min="1" max="1440" value="${state.settings.dailyGoal}" data-setting-number="dailyGoal" /><span>min</span></div></label><label>Objetivo semanal<div class="unit-input"><input type="number" min="1" max="10080" value="${state.settings.weeklyGoal}" data-setting-number="weeklyGoal" /><span>min</span></div></label></div>
      <div class="goal-comparison"><span>Esta semana <b>${formatMinutes(weekSeconds(), { compact: true })}</b></span><div class="goal-track"><span data-weekly-progress style="width:${clamp(weekSeconds() / (state.settings.weeklyGoal * 60) * 100, 0, 100)}%"></span></div></div>
    </section>
    <section class="settings-section"><div class="settings-heading"><span>⏰</span><div><h2>Alarmas de práctica</h2><p>Recordatorios en este móvil</p></div><button class="small-add" type="button" data-action="add-reminder">＋</button></div>
      ${state.reminders.length ? `<div class="reminder-list">${state.reminders.map(reminderRow).join("")}</div>` : '<div class="empty-inline"><span>○</span><p>No has creado ninguna alarma.</p></div>'}
      <div class="notification-note"><span>i</span><p>Los avisos suenan mientras Anhad está abierta. Para despertar con fiabilidad, añade cada alarma al calendario del móvil.</p></div>
      <button class="secondary-button" type="button" data-action="notifications">${"Notification" in window && Notification.permission === "granted" ? "Notificaciones activadas" : "Activar notificaciones"}</button>
    </section>
    <section class="settings-section"><div class="settings-heading"><span>♩</span><div><h2>Campanas y ambiente</h2><p>Todos los sonidos funcionan offline</p></div></div>
      <div class="field-grid"><label>Campana<select data-setting-select="bell">${[["cuenco", "Cuenco tibetano"], ["tibetana", "Campana tibetana"], ["gong", "Gong grave"], ["cristal", "Cuenco de cristal"], ["silencio", "Silencio + vibración"], ["custom", "Sonido propio"]].map(([value, label]) => `<option value="${value}" ${state.settings.bell === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>Ambiente<select data-setting-select="ambient">${[["none", "Ninguno"], ["rain", "Lluvia"], ["forest", "Bosque"], ["ocean", "Océano"], ["wind", "Viento"], ["fireplace", "Chimenea"], ["birds", "Aves"]].map(([value, label]) => `<option value="${value}" ${state.settings.ambient === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>
      <label class="range-field">Volumen <input type="range" min="0" max="1" step="0.05" value="${state.settings.volume}" data-setting-number="volume" /><b data-volume-value>${Math.round(state.settings.volume * 100)}%</b></label>
      <div class="field-grid"><label>Repeticiones<select data-setting-select="bellRepeats">${[1,2,3].map((value) => `<option value="${value}" ${Number(state.settings.bellRepeats) === value ? "selected" : ""}>${value} ${value === 1 ? "toque" : "toques"}</option>`).join("")}</select></label><label>Intervalo adicional<select data-setting-select="intervalMinutes">${[[0, "Sin intervalo"], [5, "Cada 5 min"], [10, "Cada 10 min"], [15, "Cada 15 min"], [30, "Cada 30 min"]].map(([value, label]) => `<option value="${value}" ${Number(state.settings.intervalMinutes) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>
      <div class="button-row"><button class="secondary-button" type="button" data-action="test-bell">Probar campana</button><label class="file-button">Cargar sonido<input type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.oga,.flac" data-file="bell" /></label></div>
      <p class="file-hint">${state.settings.customBellName ? `Sonido propio: ${escapeHtml(state.settings.customBellName)}` : "Formatos: MP3, M4A, WAV, AAC, OGG o FLAC · máximo 12 MB"}</p>
      ${toggleRow("Campana de inicio", "startBell", state.settings.startBell)}${toggleRow("Campana final", "endBell", state.settings.endBell)}${toggleRow("Entrada gradual", "fadeIn", state.settings.fadeIn)}${toggleRow("Vibración", "vibration", state.settings.vibration)}
    </section>
    <section class="settings-section"><div class="settings-heading"><span>◷</span><div><h2>Temporizador</h2><p>Elige cómo ver tu práctica</p></div></div>
      <div class="segmented-control"><button type="button" class="${state.settings.direction === "countdown" ? "active" : ""}" data-direction="countdown">Cuenta atrás</button><button type="button" class="${state.settings.direction === "countup" ? "active" : ""}" data-direction="countup">Cuenta adelante</button></div>
      ${toggleRow("Modo silencioso: ocultar reloj", "hideClock", state.settings.hideClock)}${toggleRow("Temporizador en pantalla bloqueada", "sessionNotification", state.settings.sessionNotification, "Muestra la fase y la hora de finalización")}${toggleRow("Frase al terminar", "quotes", state.settings.quotes)}
    </section>
    <section class="settings-section"><div class="settings-heading"><span>♣</span><div><h2>Motivación</h2><p>Árbol de constancia y logros</p></div></div>
      <label>Especie de árbol<select data-setting-select="tree">${["Olivo", "Roble", "Cerezo", "Manglar", "Arce", "Glicinia"].map((tree) => `<option ${state.settings.tree === tree ? "selected" : ""}>${tree}</option>`).join("")}</select></label>
    </section>
    <section class="settings-section"><div class="settings-heading"><span>◐</span><div><h2>Apariencia</h2><p>Clara, oscura o como tu móvil</p></div></div>
      <div class="theme-cards">${[["light", "☀", "Claro"], ["dark", "☾", "Oscuro"], ["system", "◐", "Sistema"]].map(([value, icon, label]) => `<button type="button" class="${state.settings.theme === value ? "selected" : ""}" data-theme="${value}"><span>${icon}</span>${label}</button>`).join("")}</div>
      <div class="background-swatches">${[["ivory", "Marfil"], ["dawn", "Amanecer"], ["forest", "Bosque"], ["night", "Noche"]].map(([value, label]) => `<button type="button" class="swatch-${value} ${state.settings.background === value ? "selected" : ""}" data-background="${value}"><span></span>${label}</button>`).join("")}</div>
      <label class="file-button full-width">Usar una foto de fondo<input type="file" accept="image/*" data-file="background" /></label>
    </section>
    <section class="settings-section"><div class="settings-heading"><span>▤</span><div><h2>Perfiles y rutinas</h2><p>Prácticas separadas y ciclos guardados</p></div></div>
      <label>Perfil actual<select id="profile-select">${state.profiles.map((profile) => `<option value="${profile.id}" ${profile.id === state.currentProfileId ? "selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}</select></label>
      <div class="button-row"><button class="secondary-button" type="button" data-action="add-profile">Nuevo perfil</button>${state.profiles.length > 1 ? '<button class="text-button danger-text" type="button" data-action="delete-profile">Eliminar perfil</button>' : ""}</div>
      ${state.presets.length ? `<div class="preset-list">${state.presets.filter((preset) => preset.profileId === state.currentProfileId).map((preset) => `<div><span><strong>${escapeHtml(preset.name)}</strong><small>${preset.steps.length} pasos · ${preset.rounds} rondas</small></span><button type="button" data-load-preset="${preset.id}">Usar</button><button type="button" data-delete-preset="${preset.id}" aria-label="Eliminar rutina">×</button></div>`).join("")}</div>` : ""}
    </section>
    <section class="settings-section"><div class="settings-heading"><span>⇄</span><div><h2>Tus datos</h2><p>Solo se guardan en este dispositivo</p></div></div>
      <div class="notification-note"><span>✓</span><p data-offline-status>${offlineStatusText()}</p></div>
      <div class="button-grid"><button class="secondary-button" type="button" data-export="json">Exportar JSON</button><button class="secondary-button" type="button" data-export="csv">Exportar CSV</button><label class="file-button">Importar copia<input type="file" accept="application/json" data-file="import" /></label>${installPrompt ? '<button class="secondary-button" type="button" data-action="install">Instalar app</button>' : ""}</div>
    </section>
    <p class="privacy-footer">Sin cuenta · Sin anuncios · Sin seguimiento · Funciona offline</p>
  </section>`;
  app.innerHTML = shell(content, { back: true, title: "Ajustes", right: "<span></span>" });
  bindSettingsEvents();
}

function toggleRow(label, key, checked, description = "") {
  return `<label class="switch-row"><span><strong>${label}</strong>${description ? `<small>${description}</small>` : ""}</span><input type="checkbox" data-setting-toggle="${key}" ${checked ? "checked" : ""} /><i></i></label>`;
}

function reminderRow(reminder) {
  const days = reminder.days?.length === 7 ? "Todos los días" : (reminder.days || []).map((day) => WEEKDAYS[day]).join(" · ");
  return `<div class="reminder-row"><button type="button" class="reminder-main" data-edit-reminder="${reminder.id}"><strong>${escapeHtml(reminder.time)}</strong><span>${escapeHtml(reminder.label)}<small>${days}</small></span></button><button type="button" class="calendar-download" data-ics-reminder="${reminder.id}" aria-label="Añadir al calendario">▦</button><label class="mini-switch"><input type="checkbox" data-reminder-toggle="${reminder.id}" ${reminder.enabled ? "checked" : ""} /><i></i></label></div>`;
}

function bindSettingsEvents() {
  document.querySelectorAll("[data-setting-number]").forEach((input) => {
    const key = input.dataset.settingNumber;
    const min = key === "volume" ? 0 : 1;
    const max = key === "volume" ? 1 : key === "weeklyGoal" ? 10080 : 1440;
    bindBoundedNumber(input, min, max, (value) => {
      state.settings[key] = value;
    }, (value) => {
      if (key === "volume") document.querySelector("[data-volume-value]")?.replaceChildren(`${Math.round(value * 100)}%`);
      if (key === "weeklyGoal") {
        const progress = document.querySelector("[data-weekly-progress]");
        if (progress) progress.style.width = `${clamp(weekSeconds() / (value * 60) * 100, 0, 100)}%`;
      }
    });
  });
  document.querySelectorAll("[data-setting-select]").forEach((select) => select.addEventListener("change", () => {
    const key = select.dataset.settingSelect;
    state.settings[key] = ["bellRepeats", "intervalMinutes"].includes(key) ? Number(select.value) : select.value;
    saveState();
  }));
  document.querySelectorAll("[data-setting-toggle]").forEach((input) => input.addEventListener("change", async () => {
    const key = input.dataset.settingToggle;
    state.settings[key] = input.checked;
    saveState();
    if (key === "sessionNotification" && input.checked) await requestNotifications({ quiet: true });
  }));
  document.querySelectorAll("[data-direction]").forEach((button) => button.addEventListener("click", () => {
    state.settings.direction = button.dataset.direction;
    saveState();
    document.querySelectorAll("[data-direction]").forEach((item) => item.classList.toggle("active", item === button));
  }));
  document.querySelectorAll("[data-theme]").forEach((button) => button.addEventListener("click", () => {
    state.settings.theme = button.dataset.theme;
    saveState();
    document.querySelectorAll("[data-theme]").forEach((item) => item.classList.toggle("selected", item === button));
    setTheme();
  }));
  document.querySelectorAll("[data-background]").forEach((button) => button.addEventListener("click", () => {
    state.settings.background = button.dataset.background;
    saveState();
    document.querySelectorAll("[data-background]").forEach((item) => item.classList.toggle("selected", item === button));
    setTheme();
  }));
  document.querySelector('[data-action="test-bell"]')?.addEventListener("click", testBell);
  document.querySelector('[data-action="notifications"]')?.addEventListener("click", requestNotifications);
  document.querySelector('[data-action="add-reminder"]')?.addEventListener("click", () => { ui.modal = "reminder"; ui.detailId = null; render(); });
  document.querySelectorAll("[data-edit-reminder]").forEach((button) => button.addEventListener("click", () => { ui.modal = "reminder"; ui.detailId = button.dataset.editReminder; render(); }));
  document.querySelectorAll("[data-reminder-toggle]").forEach((input) => input.addEventListener("change", () => {
    const reminder = state.reminders.find((item) => item.id === input.dataset.reminderToggle);
    if (reminder) reminder.enabled = input.checked;
    saveState();
  }));
  document.querySelectorAll("[data-ics-reminder]").forEach((button) => button.addEventListener("click", () => downloadReminder(state.reminders.find((item) => item.id === button.dataset.icsReminder))));
  document.querySelector("#profile-select")?.addEventListener("change", (event) => { state.currentProfileId = event.target.value; saveState(); render(); });
  document.querySelector('[data-action="add-profile"]')?.addEventListener("click", () => { ui.modal = "profile"; render(); });
  document.querySelector('[data-action="delete-profile"]')?.addEventListener("click", deleteCurrentProfile);
  document.querySelectorAll("[data-load-preset]").forEach((button) => button.addEventListener("click", () => loadPreset(button.dataset.loadPreset)));
  document.querySelectorAll("[data-delete-preset]").forEach((button) => button.addEventListener("click", () => { state.presets = state.presets.filter((preset) => preset.id !== button.dataset.deletePreset); saveState(); render(); }));
  document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => exportData(button.dataset.export)));
  document.querySelector('[data-action="install"]')?.addEventListener("click", async () => { await installPrompt?.prompt(); installPrompt = null; render(); });
  document.querySelector('[data-file="bell"]')?.addEventListener("change", loadCustomBell);
  document.querySelector('[data-file="background"]')?.addEventListener("change", loadBackground);
  document.querySelector('[data-file="import"]')?.addEventListener("change", importData);
}

function renderModal() {
  if (!ui.modal) return "";
  if (ui.modal === "category") return modalShell("Elige una categoría", `<p class="modal-intro">¿Qué tipo de práctica quieres añadir al ciclo?</p><div class="category-choices">${Object.entries(CATEGORY_META).map(([key, meta]) => `<button type="button" class="${meta.className}" data-add-category="${key}"><span>${meta.icon}</span><strong>${meta.label}</strong><small>15 min, editable después</small></button>`).join("")}</div>`);
  if (ui.modal === "preset") return modalShell("Guardar rutina", `<form id="preset-form"><label>Nombre de la rutina<input name="name" required maxlength="60" placeholder="Ej. Práctica de la mañana" /></label><button class="start-button" type="submit"><span>Guardar rutina</span><b>✓</b></button></form>`);
  if (ui.modal === "profile") return modalShell("Nuevo perfil", `<form id="profile-form"><label>Nombre del perfil<input name="name" required maxlength="60" placeholder="Ej. Retiro o Bhajanes" /></label><button class="start-button" type="submit"><span>Crear perfil</span><b>✓</b></button></form>`);
  if (ui.modal === "manual") return manualSessionModal();
  if (ui.modal === "session") return sessionDetailModal();
  if (ui.modal === "reminder") return reminderModal();
  return "";
}

function modalShell(title, body, wide = false) {
  return `<div class="modal-backdrop"><section class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header><div><p class="eyebrow">ANHAD</p><h2>${escapeHtml(title)}</h2></div><button type="button" data-action="close-modal" aria-label="Cerrar">×</button></header>${body}</section></div>`;
}

function manualSessionModal() {
  const now = new Date();
  return modalShell("Añadir sesión", `<form id="manual-form">
    <div class="two-fields"><label>Fecha<input type="date" name="date" required max="${dateKey()}" value="${dateKey()}" /></label><label>Hora<input type="time" name="time" required value="${pad(now.getHours())}:${pad(now.getMinutes())}" /></label></div>
    <div class="two-fields"><label>Duración<div class="unit-input"><input type="number" name="minutes" required min="1" max="1440" value="60" /><span>min</span></div></label><label>Categoría<select name="category">${Object.entries(CATEGORY_META).map(([key, meta]) => `<option value="${key}">${meta.label}</option>`).join("")}</select></label></div>
    <label>Notas<textarea name="notes" rows="4" placeholder="Reflexiones de la sesión"></textarea></label>
    <label>Estado al terminar<select name="mood"><option value="">Sin registrar</option><option value="sereno">Sereno</option><option value="claro">Claro</option><option value="agradecido">Agradecido</option><option value="inquieto">Inquieto</option></select></label>
    <button class="start-button" type="submit"><span>Guardar sesión</span><b>✓</b></button>
  </form>`);
}

function sessionDetailModal() {
  const session = state.sessions.find((item) => item.id === ui.detailId);
  if (!session) return "";
  const date = new Date(session.startedAt);
  const breakdown = session.breakdown || { [session.category || "luz"]: session.durationSec };
  return modalShell("Detalle de sesión", `<div class="session-detail">
    <div class="detail-date"><span>${date.getDate()}</span><p><strong>${date.toLocaleDateString("es", { weekday: "long", month: "long", year: "numeric" })}</strong><small>${date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</small></p></div>
    <div class="detail-duration"><small>Duración total</small><strong>${formatMinutes(session.durationSec, { compact: true })}</strong></div>
    <div class="completion-breakdown">${Object.entries(breakdown).map(([category, seconds]) => `<span class="${CATEGORY_META[category]?.className || "cat-light"}"><i>${CATEGORY_META[category]?.icon || "✦"}</i>${CATEGORY_META[category]?.short || category}<b>${formatMinutes(seconds, { compact: true })}</b></span>`).join("")}</div>
    ${session.mood ? `<div class="detail-block"><small>Estado al terminar</small><p class="mood-pill">${escapeHtml(session.mood)}</p></div>` : ""}
    <div class="detail-block"><small>Notas</small><p>${session.notes ? escapeHtml(session.notes).replace(/\n/g, "<br>") : "Sin notas en esta sesión."}</p></div>
    <div class="detail-actions"><button class="secondary-button" type="button" data-action="edit-session">Editar</button><button class="text-button danger-text" type="button" data-action="delete-session">Eliminar sesión</button></div>
  </div>`);
}

function reminderModal() {
  const reminder = state.reminders.find((item) => item.id === ui.detailId) || { label: "Meditación de la mañana", time: "05:30", days: [0,1,2,3,4,5,6], enabled: true };
  return modalShell(ui.detailId ? "Editar alarma" : "Nueva alarma", `<form id="reminder-form"><label>Nombre<input name="label" required maxlength="60" value="${escapeHtml(reminder.label)}" /></label><label>Hora<input class="large-time-input" type="time" name="time" required value="${escapeHtml(reminder.time)}" /></label><fieldset><legend>Días</legend><div class="day-choices">${WEEKDAYS.map((day, index) => `<label><input type="checkbox" name="days" value="${index}" ${reminder.days.includes(index) ? "checked" : ""} /><span>${day}</span></label>`).join("")}</div></fieldset><button class="start-button" type="submit"><span>Guardar alarma</span><b>✓</b></button>${ui.detailId ? '<button class="text-button danger-text full-width" type="button" data-action="delete-reminder">Eliminar alarma</button>' : ""}</form>`);
}

function bindModalSpecific() {
  document.querySelectorAll("[data-add-category]").forEach((button) => button.addEventListener("click", () => {
    state.advanced.steps.push({ id: uid("step"), category: button.dataset.addCategory, minutes: 15 });
    saveState();
    ui.modal = null;
    render();
  }));
  document.querySelector("#preset-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = new FormData(event.target).get("name").trim();
    if (!name) return;
    state.presets.push({ id: uid("preset"), profileId: state.currentProfileId, name, rounds: state.advanced.rounds, openEnded: state.advanced.openEnded, steps: clone(state.advanced.steps) });
    saveState();
    ui.modal = null;
    toast("Rutina guardada.", "success");
    render();
  });
  document.querySelector("#profile-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = new FormData(event.target).get("name").trim();
    if (!name) return;
    const profile = { id: uid("profile"), name };
    state.profiles.push(profile);
    state.currentProfileId = profile.id;
    saveState();
    ui.modal = null;
    render();
  });
  document.querySelector("#manual-form")?.addEventListener("submit", saveManualSession);
  document.querySelector("#reminder-form")?.addEventListener("submit", saveReminder);
  document.querySelector('[data-action="delete-reminder"]')?.addEventListener("click", deleteReminder);
  document.querySelector('[data-action="delete-session"]')?.addEventListener("click", deleteSession);
  document.querySelector('[data-action="edit-session"]')?.addEventListener("click", editSessionAsManual);
}

function saveManualSession(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  const startedAt = localDateTime(data.get("date"), data.get("time"));
  const minutes = clamp(data.get("minutes"), 1, 1440);
  const category = data.get("category");
  const editing = ui.detailId && state.sessions.find((session) => session.id === ui.detailId);
  const session = {
    id: editing?.id || uid("session"),
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + minutes * 60000).toISOString(),
    durationSec: minutes * 60,
    breakdown: { [category]: minutes * 60 },
    category,
    notes: String(data.get("notes") || "").trim(),
    mood: data.get("mood") || "",
    source: "manual",
    mode: "manual"
  };
  if (editing) state.sessions = state.sessions.map((item) => item.id === editing.id ? session : item);
  else state.sessions.push(session);
  state.sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  saveState();
  ui.modal = null;
  ui.detailId = null;
  toast(editing ? "Sesión actualizada." : "Sesión añadida.", "success");
  render();
}

function editSessionAsManual() {
  const session = state.sessions.find((item) => item.id === ui.detailId);
  if (!session) return;
  const date = new Date(session.startedAt);
  ui.modal = "manual";
  render();
  const form = document.querySelector("#manual-form");
  if (!form) return;
  form.elements.date.value = dateKey(date);
  form.elements.time.value = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  form.elements.minutes.value = Math.round(session.durationSec / 60);
  form.elements.category.value = session.category || Object.keys(session.breakdown || {})[0] || "luz";
  form.elements.notes.value = session.notes || "";
  form.elements.mood.value = session.mood || "";
}

function deleteSession() {
  if (!confirm("¿Eliminar esta sesión del historial?")) return;
  state.sessions = state.sessions.filter((session) => session.id !== ui.detailId);
  saveState();
  ui.modal = null;
  ui.detailId = null;
  toast("Sesión eliminada.");
  render();
}

function saveReminder(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  const days = data.getAll("days").map(Number);
  if (!days.length) return toast("Elige al menos un día.", "warning");
  const reminder = { id: ui.detailId || uid("reminder"), label: data.get("label").trim(), time: data.get("time"), days, enabled: true };
  const existingIndex = state.reminders.findIndex((item) => item.id === reminder.id);
  if (existingIndex >= 0) reminder.enabled = state.reminders[existingIndex].enabled;
  if (existingIndex >= 0) state.reminders[existingIndex] = reminder;
  else state.reminders.push(reminder);
  state.reminders.sort((a, b) => a.time.localeCompare(b.time));
  saveState();
  ui.modal = null;
  ui.detailId = null;
  toast("Alarma guardada.", "success");
  render();
}

function deleteReminder() {
  state.reminders = state.reminders.filter((reminder) => reminder.id !== ui.detailId);
  saveState();
  ui.modal = null;
  ui.detailId = null;
  render();
}

function loadPreset(id) {
  const preset = state.presets.find((item) => item.id === id);
  if (!preset) return;
  state.advanced = { rounds: preset.rounds, openEnded: preset.openEnded, steps: clone(preset.steps).map((step) => ({ ...step, id: uid("step") })) };
  state.mode = "advanced";
  saveState();
  ui.view = "meditar";
  toast(`Rutina “${preset.name}” preparada.`, "success");
  render();
}

function deleteCurrentProfile() {
  if (state.profiles.length <= 1 || !confirm("¿Eliminar este perfil y sus rutinas? Las sesiones no se borrarán.")) return;
  const old = state.currentProfileId;
  state.profiles = state.profiles.filter((profile) => profile.id !== old);
  state.presets = state.presets.filter((preset) => preset.profileId !== old);
  state.currentProfileId = state.profiles[0].id;
  saveState();
  render();
}

async function ensureAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Este navegador no admite reproducción de audio.");
  if (!audioContext || audioContext.state === "closed") audioContext = new AudioContextClass({ latencyHint: "interactive" });
  if (audioContext.state === "suspended") await audioContext.resume();
  if (audioContext.state !== "running") throw new Error("El móvil ha bloqueado el audio. Toca de nuevo para activarlo.");
  return audioContext;
}

const BELL_PROFILES = {
  cuenco: { base: 220, partials: [1, 2.01, 3.12, 4.17], duration: 4.6 },
  tibetana: { base: 330, partials: [1, 1.5, 2.01, 2.74], duration: 3.8 },
  gong: { base: 110, partials: [1, 1.41, 2.18, 2.97], duration: 5.6 },
  cristal: { base: 523.25, partials: [1, 2, 3, 4.08], duration: 4.2 }
};

function showAudioError(error) {
  console.warn("Anhad no pudo reproducir la campana.", error);
  if (audioWarningShown) return;
  audioWarningShown = true;
  toast(error?.message || "No se pudo reproducir el sonido. Revisa el volumen multimedia del móvil.", "warning");
}

function scheduleSynthBell(context, type, repeats, startAt, nodes = null) {
  const profile = BELL_PROFILES[type] || BELL_PROFILES.cuenco;
  for (let ring = 0; ring < repeats; ring += 1) {
    const start = startAt + ring * 1.45;
    profile.partials.forEach((partial, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = index === 0 ? "sine" : "triangle";
      oscillator.frequency.setValueAtTime(profile.base * partial, start);
      oscillator.detune.setValueAtTime((index - 1) * 2.5, start);
      const peak = state.settings.volume * (0.46 / (index + 1));
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + (state.settings.fadeIn ? 0.08 : 0.012));
      gain.gain.exponentialRampToValueAtTime(0.0001, start + profile.duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + profile.duration + 0.1);
      if (nodes) nodes.push(oscillator, gain);
    });
  }
}

function openMediaDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("Este navegador no permite guardar audio offline."));
    const request = indexedDB.open("anhad-media", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir el almacenamiento de audio."));
  });
}

async function mediaDatabaseGet(key) {
  const database = await openMediaDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction("files", "readonly").objectStore("files").get(key);
    request.onsuccess = () => { database.close(); resolve(request.result || null); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
}

async function mediaDatabasePut(key, value) {
  const database = await openMediaDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("files", "readwrite");
    transaction.objectStore("files").put(value, key);
    transaction.oncomplete = () => { database.close(); resolve(true); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}

async function customBellBlob() {
  const stored = await mediaDatabaseGet("custom-bell").catch(() => null);
  if (stored instanceof Blob) return stored;
  if (state.settings.customBell) return fetch(state.settings.customBell).then((response) => response.blob());
  return null;
}

async function customBellAudioBuffer(context) {
  if (customBellBuffer) return customBellBuffer;
  const blob = await customBellBlob();
  if (!blob) throw new Error("Carga primero un archivo de audio para usar el sonido propio.");
  customBellBuffer = await context.decodeAudioData(await blob.arrayBuffer());
  return customBellBuffer;
}

async function scheduleBellAt(type, repeats, startAt, { nodes = null } = {}) {
  const context = await ensureAudio();
  if (type === "custom") {
    const buffer = await customBellAudioBuffer(context);
    for (let ring = 0; ring < repeats; ring += 1) {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = state.settings.volume;
      source.connect(gain).connect(context.destination);
      source.start(startAt + ring * Math.max(1.2, Math.min(buffer.duration + 0.2, 2)));
      if (nodes) nodes.push(source, gain);
    }
    return true;
  }
  scheduleSynthBell(context, type, repeats, startAt, nodes);
  return true;
}

async function playBell(type = "cuenco", repeats = 1) {
  if (type === "silencio") {
    if (state.settings.vibration) navigator.vibrate?.([180, 80, 180]);
    return true;
  }
  const context = await ensureAudio();
  await scheduleBellAt(type, repeats, context.currentTime + 0.035);
  audioWarningShown = false;
  if (state.settings.vibration) navigator.vibrate?.(160);
  return true;
}

async function testBell(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await ensureAudio();
    await playBell(state.settings.bell, state.settings.bellRepeats);
    toast("Sonido de prueba reproducido.", "success");
  } catch (error) {
    showAudioError(error);
  } finally {
    button.disabled = false;
  }
}

function stopBellNodes(nodes) {
  nodes.forEach((node) => { try { node.stop?.(); } catch {} try { node.disconnect?.(); } catch {} });
}

function clearScheduledBells() {
  bellScheduleGeneration += 1;
  stopBellNodes(scheduledBellNodes);
  scheduledBellNodes = [];
  sessionBellsScheduled = false;
}

async function scheduleSessionBells() {
  clearScheduledBells();
  if (!runtime || runtime.status !== "running" || state.settings.bell === "silencio") return;
  const generation = bellScheduleGeneration;
  const nodes = [];
  try {
    const context = await ensureAudio();
    const now = Date.now();
    const intervalSec = Number(state.settings.intervalMinutes) * 60;
    let phaseStartMs = runtime.phaseStartedAt;
    let scheduledAny = false;
    for (let index = runtime.stepIndex; index < runtime.sequence.length; index += 1) {
      const phase = runtime.sequence[index];
      if (!phase.durationSec) break;
      const phaseEndMs = phaseStartMs + phase.durationSec * 1000;
      if (intervalSec > 0) {
        for (let atMs = phaseStartMs + intervalSec * 1000; atMs < phaseEndMs; atMs += intervalSec * 1000) {
          if (atMs <= now) continue;
          await scheduleBellAt(state.settings.bell, 1, context.currentTime + (atMs - now) / 1000, { nodes });
          scheduledAny = true;
        }
      }
      const isFinal = index === runtime.sequence.length - 1;
      if (phaseEndMs > now && (!isFinal || state.settings.endBell)) {
        await scheduleBellAt(state.settings.bell, isFinal ? state.settings.bellRepeats : 1, context.currentTime + (phaseEndMs - now) / 1000, { nodes });
        scheduledAny = true;
      }
      phaseStartMs = phaseEndMs;
    }
    if (generation !== bellScheduleGeneration) {
      stopBellNodes(nodes);
      return;
    }
    scheduledBellNodes.push(...nodes);
    sessionBellsScheduled = scheduledAny;
  } catch (error) {
    stopBellNodes(nodes);
    if (generation === bellScheduleGeneration) {
      sessionBellsScheduled = false;
      showAudioError(error);
    }
  }
}

async function startAmbient() {
  stopAmbient();
  if (state.settings.ambient === "none") return;
  const context = await ensureAudio().catch(() => null);
  if (!context) return;
  const buffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  const settings = {
    rain: ["highpass", 2600, 0.05], forest: ["bandpass", 900, 0.025], ocean: ["lowpass", 520, 0.09],
    wind: ["lowpass", 1100, 0.035], fireplace: ["bandpass", 1800, 0.04], birds: ["highpass", 4100, 0.018]
  }[state.settings.ambient] || ["lowpass", 800, 0.03];
  filter.type = settings[0];
  filter.frequency.value = settings[1];
  gain.gain.value = settings[2] * state.settings.volume;
  source.buffer = buffer;
  source.loop = true;
  source.connect(filter).connect(gain).connect(context.destination);
  source.start();
  ambientNodes = [source, filter, gain];
}

function stopAmbient() {
  ambientNodes.forEach((node) => { try { node.stop?.(); node.disconnect?.(); } catch {} });
  ambientNodes = [];
}

function silentWavUrl(seconds = 8, sampleRate = 8000) {
  const sampleCount = seconds * sampleRate;
  const buffer = new ArrayBuffer(44 + sampleCount);
  const view = new DataView(buffer);
  const write = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + sampleCount, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  write(36, "data");
  view.setUint32(40, sampleCount, true);
  new Uint8Array(buffer, 44).fill(128);
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function ensureSessionAudioElement() {
  if (sessionAudio) return sessionAudio;
  sessionAudio = new Audio(silentWavUrl());
  sessionAudio.loop = true;
  sessionAudio.preload = "auto";
  sessionAudio.playsInline = true;
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.setActionHandler("play", () => runtime?.status === "paused" && togglePause()); } catch {}
    try { navigator.mediaSession.setActionHandler("pause", () => runtime?.status === "running" && togglePause()); } catch {}
    try { navigator.mediaSession.setActionHandler("stop", () => runtime && finishSession(false)); } catch {}
  }
  return sessionAudio;
}

async function startSessionAudio() {
  try {
    const audio = ensureSessionAudioElement();
    await audio.play();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    return true;
  } catch (error) {
    console.warn("No se pudo mantener activa la sesión de audio.", error);
    return false;
  }
}

function pauseSessionAudio() {
  sessionAudio?.pause();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
}

function stopSessionAudio() {
  if (sessionAudio) {
    sessionAudio.pause();
    sessionAudio.currentTime = 0;
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = "none";
    navigator.mediaSession.metadata = null;
    try { navigator.mediaSession.setPositionState(); } catch {}
  }
}

function sessionRemainingSeconds() {
  if (!runtime) return null;
  const current = runtime.sequence[runtime.stepIndex];
  if (!current?.durationSec) return null;
  return Math.max(0, current.durationSec - currentPhaseElapsed())
    + runtime.sequence.slice(runtime.stepIndex + 1).reduce((sum, phase) => sum + (phase.durationSec || 0), 0);
}

function phaseRemainingSeconds() {
  const phase = runtime?.sequence?.[runtime.stepIndex];
  return phase?.durationSec ? Math.max(0, phase.durationSec - currentPhaseElapsed()) : null;
}

function sessionEndText() {
  const remaining = sessionRemainingSeconds();
  if (remaining === null) return "Sesión abierta";
  const end = new Date(Date.now() + remaining * 1000);
  return `Termina a las ${end.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}`;
}

function updateMediaSession() {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window) || !runtime || !["running", "paused"].includes(runtime.status)) return;
  const phase = runtime.sequence[runtime.stepIndex];
  const meta = CATEGORY_META[phase.category];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: `${meta.label}${runtime.status === "paused" ? " · En pausa" : ""}`,
    artist: "Anhad · Meditación",
    album: sessionEndText(),
    artwork: [
      { src: new URL("./icon-192.png", location.href).href, sizes: "192x192", type: "image/png" },
      { src: new URL("./icon-512.png", location.href).href, sizes: "512x512", type: "image/png" }
    ]
  });
  navigator.mediaSession.playbackState = runtime.status === "paused" ? "paused" : "playing";
  const duration = runtime.sequence.reduce((sum, item) => sum + (item.durationSec || 0), 0);
  if (duration > 0) {
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: clamp(totalElapsed(), 0, duration) });
    } catch {}
  }
}

function sessionNotificationBody() {
  const phaseRemaining = phaseRemainingSeconds();
  if (runtime?.status === "paused") return `En pausa · ${phaseRemaining === null ? "sesión abierta" : `${formatClock(phaseRemaining)} pendientes`}`;
  return `${phaseRemaining === null ? "Cuenta adelante" : `${formatClock(phaseRemaining)} en esta fase`} · ${sessionEndText()}`;
}

async function activeServiceWorkerRegistration() {
  if (pwaRegistration?.active) return pwaRegistration;
  return navigator.serviceWorker?.ready.catch(() => null);
}

async function updateSessionNotification() {
  if (!state.settings.sessionNotification || !("Notification" in window) || Notification.permission !== "granted" || !runtime) return false;
  const registration = await activeServiceWorkerRegistration();
  if (!registration) return false;
  const phase = runtime.sequence[runtime.stepIndex];
  const notificationIcon = new URL("./icon-192.png", location.href).href;
  await registration.showNotification(`Anhad · ${CATEGORY_META[phase.category].label}`, {
    body: sessionNotificationBody(),
    icon: notificationIcon,
    badge: notificationIcon,
    tag: "anhad-session-timer",
    silent: true,
    requireInteraction: true,
    timestamp: Date.now(),
    data: { url: "./", kind: "session" }
  }).catch((error) => console.warn("No se pudo mostrar el temporizador en notificaciones.", error));
  return true;
}

async function showCompletedNotification() {
  if (!state.settings.sessionNotification || !("Notification" in window) || Notification.permission !== "granted") return;
  const registration = await activeServiceWorkerRegistration();
  if (!registration) return;
  const notificationIcon = new URL("./icon-192.png", location.href).href;
  await registration.showNotification("Anhad · Sesión completada", {
    body: `Has meditado ${formatClock(runtime.durationSec)}. Abre Anhad para guardar tus notas.`,
    icon: notificationIcon,
    badge: notificationIcon,
    tag: "anhad-session-timer",
    requireInteraction: true,
    data: { url: "./", kind: "session-complete" }
  }).catch(() => {});
}

async function closeSessionNotification() {
  const registration = await activeServiceWorkerRegistration();
  if (!registration?.getNotifications) return;
  const notifications = await registration.getNotifications({ tag: "anhad-session-timer" }).catch(() => []);
  notifications.forEach((notification) => notification.close());
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}

function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

async function requestNotifications({ quiet = false } = {}) {
  if (!("Notification" in window)) {
    if (!quiet) toast("Este navegador no admite notificaciones.", "warning");
    return false;
  }
  const result = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (!quiet) toast(result === "granted" ? "Notificaciones activadas." : "No se concedió el permiso.", result === "granted" ? "success" : "warning");
  const button = document.querySelector('[data-action="notifications"]');
  if (button && result === "granted") button.textContent = "Notificaciones activadas";
  return result === "granted";
}

async function checkReminders() {
  const now = new Date();
  const mondayDay = (now.getDay() + 6) % 7;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  for (const reminder of state.reminders.filter((item) => item.enabled && item.time === time && item.days.includes(mondayDay))) {
    const firedKey = `${reminder.id}:${dateKey(now)}:${time}`;
    if (sessionStorage.getItem("anhad:last-reminder") === firedKey) continue;
    sessionStorage.setItem("anhad:last-reminder", firedKey);
    playBell(state.settings.bell, state.settings.bellRepeats).catch(showAudioError);
    toast(`Es la hora: ${reminder.label}`, "success");
    if ("Notification" in window && Notification.permission === "granted") {
      const registration = await navigator.serviceWorker?.ready.catch(() => null);
      if (registration) registration.showNotification("Anhad · Es hora de meditar", { body: reminder.label, icon: "icon-192.png", tag: reminder.id, vibrate: [180, 80, 180] });
      else new Notification("Anhad · Es hora de meditar", { body: reminder.label });
    }
  }
}

function downloadReminder(reminder) {
  if (!reminder) return;
  const now = new Date();
  const [hour, minute] = reminder.time.split(":").map(Number);
  let first = startOfDay(now);
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = addDays(first, offset);
    const mondayDay = (candidate.getDay() + 6) % 7;
    if (reminder.days.includes(mondayDay)) { first = candidate; break; }
  }
  first.setHours(hour, minute, 0, 0);
  const stamp = `${first.getFullYear()}${pad(first.getMonth() + 1)}${pad(first.getDate())}T${pad(hour)}${pad(minute)}00`;
  const days = reminder.days.map((day) => WEEKDAY_CODES[day]).join(",");
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Anhad//Meditacion//ES", "BEGIN:VEVENT", `UID:${reminder.id}@anhad`, `DTSTART:${stamp}`, `RRULE:FREQ=WEEKLY;BYDAY=${days}`, `SUMMARY:${reminder.label.replace(/[;,]/g, " ")}`, "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT0M", `DESCRIPTION:${reminder.label.replace(/[;,]/g, " ")}`, "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  downloadBlob(new Blob([ics], { type: "text/calendar;charset=utf-8" }), `${reminder.label.replace(/[^a-z0-9áéíóúñ]+/gi, "-").toLowerCase()}.ics`);
  toast("Alarma preparada para tu calendario.", "success");
}

function exportData(format) {
  if (format === "json") {
    downloadBlob(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }), `anhad-copia-${dateKey()}.json`);
    return;
  }
  const header = ["fecha", "hora", "duracion_min", "categorias", "estado", "notas"];
  const rows = state.sessions.map((session) => {
    const date = new Date(session.startedAt);
    const values = [dateKey(date), `${pad(date.getHours())}:${pad(date.getMinutes())}`, Math.round(session.durationSec / 60), Object.keys(session.breakdown || {}).map((category) => CATEGORY_META[category]?.label || category).join(" + "), session.mood || "", session.notes || ""];
    return values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",");
  });
  downloadBlob(new Blob([[header.join(","), ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" }), `anhad-sesiones-${dateKey()}.csv`);
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function fileAsDataUrl(file, maxBytes) {
  if (!file) return null;
  if (file.size > maxBytes) throw new Error(`El archivo debe pesar menos de ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadCustomBell(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const extension = file.name.split(".").pop()?.toLowerCase();
    const validExtensions = ["mp3", "m4a", "wav", "aac", "ogg", "oga", "flac"];
    if (!file.type.startsWith("audio/") && !validExtensions.includes(extension)) throw new Error("Elige un archivo MP3, M4A, WAV, AAC, OGG o FLAC.");
    if (file.size > 12 * 1024 * 1024) throw new Error("El archivo de audio debe pesar menos de 12 MB.");
    const context = await ensureAudio();
    const decoded = await context.decodeAudioData(await file.arrayBuffer()).catch(() => null);
    if (!decoded) throw new Error("El móvil no puede decodificar este archivo. Prueba con MP3, M4A o WAV.");
    await mediaDatabasePut("custom-bell", file);
    const previous = { customBell: state.settings.customBell, customBellName: state.settings.customBellName, bell: state.settings.bell };
    state.settings.customBell = null;
    state.settings.customBellName = file.name;
    state.settings.bell = "custom";
    if (!saveState({ notify: false })) {
      Object.assign(state.settings, previous);
      saveState({ notify: false });
      throw new Error("No hay espacio suficiente para guardar este sonido.");
    }
    customBellBuffer = decoded;
    toast("Sonido propio guardado en este dispositivo.", "success");
    render();
  } catch (error) { toast(error.message, "warning"); }
}

async function loadBackground(event) {
  try {
    const previous = { customBackground: state.settings.customBackground, background: state.settings.background };
    state.settings.customBackground = await fileAsDataUrl(event.target.files[0], 2 * 1024 * 1024);
    state.settings.background = "custom";
    if (!saveState({ notify: false })) {
      Object.assign(state.settings, previous);
      saveState({ notify: false });
      throw new Error("No hay espacio suficiente para guardar esta imagen.");
    }
    toast("Fondo guardado en este dispositivo.", "success");
    render();
  } catch (error) { toast(error.message, "warning"); }
}

async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.sessions)) throw new Error("La copia no parece válida.");
    if (!confirm(`Se importarán ${parsed.sessions.length} sesiones y se reemplazarán los ajustes actuales. ¿Continuar?`)) return;
    const previous = state;
    state = hydrate(parsed);
    if (!saveState({ notify: false })) {
      state = previous;
      throw new Error("No hay espacio suficiente para importar esta copia.");
    }
    toast("Copia importada correctamente.", "success");
    render();
  } catch (error) { toast(error.message || "No se pudo importar la copia.", "warning"); }
}

function registerPwa() {
  addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); installPrompt = event; if (ui.view === "ajustes") render(); });
  addEventListener("appinstalled", () => { installPrompt = null; toast("Anhad se ha instalado en tu dispositivo.", "success"); });
  if (!("serviceWorker" in navigator)) {
    updateOfflineIndicators();
    return;
  }
  navigator.serviceWorker.register("./service-worker.js", { updateViaCache: "none" }).then(async (registration) => {
    pwaRegistration = registration;
    await registration.update().catch(() => {});
    pwaRegistration = await navigator.serviceWorker.ready;
    offlineReady = true;
    updateOfflineIndicators();
    navigator.storage?.persist?.().catch(() => false);
  }).catch((error) => {
    console.warn("No se pudo preparar Anhad para funcionar offline.", error);
    updateOfflineIndicators();
    toast("No se pudo preparar el modo offline. Abre Anhad con conexión y recarga una vez.", "warning");
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    offlineReady = true;
    updateOfflineIndicators();
  });
}

function restoreRuntime() {
  if (!runtime || !Array.isArray(runtime.sequence) || !runtime.sequence.length) {
    runtime = null;
    saveRuntime();
    return;
  }
  if (runtime.status === "running") {
    startTimerLoop();
    if (state.settings.sessionNotification) startSessionAudio().then(() => updateMediaSession());
    scheduleSessionBells();
    updateSessionNotification();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkReminders();
    if (runtime?.status === "running") {
      requestWakeLock();
      updateTimer();
      if (state.settings.sessionNotification) startSessionAudio().then(() => updateMediaSession());
      if (!sessionBellsScheduled) scheduleSessionBells();
      updateSessionNotification();
    }
  }
});

matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => state.settings.theme === "system" && setTheme());
window.addEventListener("online", () => { updateOfflineIndicators(); toast("Conexión recuperada. Anhad sigue guardando todo en tu dispositivo."); });
window.addEventListener("offline", () => { updateOfflineIndicators(); toast("Estás offline. La práctica seguirá funcionando.", "success"); });

const originalRender = render;
render = function renderWithModalBindings() {
  originalRender();
  bindModalSpecific();
};

setTheme();
registerPwa();
restoreRuntime();
render();
reminderHandle = setInterval(checkReminders, 20000);
checkReminders();

