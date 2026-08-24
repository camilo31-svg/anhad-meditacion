export const CATEGORY_META = Object.freeze({
  luz: { label: "Luz", short: "Luz", icon: "✦", className: "cat-light", color: "#c8872f" },
  sonido: { label: "Sonido", short: "Sonido", icon: "◉", className: "cat-sound", color: "#2c6c68" },
  bhajanes: { label: "Canto de Bhajanes", short: "Bhajanes", icon: "♫", className: "cat-bhajans", color: "#8f5a67" },
  satsang: { label: "Satsang", short: "Satsang", icon: "❦", className: "cat-satsang", color: "#695c8f" }
});

export function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function pad(value) {
  return String(value).padStart(2, "0");
}

export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(remainder)}` : `${pad(minutes)}:${pad(remainder)}`;
}

export function formatMinutes(totalSeconds, options = {}) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (options.compact) {
    if (hours && remainder) return `${hours} h ${remainder} min`;
    if (hours) return `${hours} h`;
    return `${minutes} min`;
  }
  if (hours && remainder) return `${hours} h ${remainder} min`;
  if (hours) return `${hours} ${hours === 1 ? "hora" : "horas"}`;
  return `${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
}

export function dateKey(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localDateTime(dateValue, timeValue = "00:00") {
  const [year, month, day] = String(dateValue).split("-").map(Number);
  const [hour, minute] = String(timeValue).split(":").map(Number);
  return new Date(year, month - 1, day, hour || 0, minute || 0, 0, 0);
}

export function startOfDay(input = new Date()) {
  const date = input instanceof Date ? new Date(input) : new Date(input);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function endOfDay(input = new Date()) {
  const date = startOfDay(input);
  date.setHours(23, 59, 59, 999);
  return date;
}

export function addDays(input, amount) {
  const date = input instanceof Date ? new Date(input) : new Date(input);
  date.setDate(date.getDate() + amount);
  return date;
}

export function startOfWeek(input = new Date()) {
  const date = startOfDay(input);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return date;
}

export function startOfMonth(input = new Date()) {
  const date = startOfDay(input);
  date.setDate(1);
  return date;
}

export function sessionsBetween(sessions, from, to) {
  const min = from ? new Date(from).getTime() : -Infinity;
  const max = to ? new Date(to).getTime() : Infinity;
  return sessions.filter((session) => {
    const stamp = new Date(session.startedAt).getTime();
    return Number.isFinite(stamp) && stamp >= min && stamp <= max;
  });
}

export function dayTotals(sessions) {
  return sessions.reduce((totals, session) => {
    const key = dateKey(session.startedAt);
    totals[key] = (totals[key] || 0) + (Number(session.durationSec) || 0);
    return totals;
  }, {});
}

export function currentStreak(sessions, dailyGoalMinutes = 1, today = new Date()) {
  const totals = dayTotals(sessions);
  const target = Math.max(1, Number(dailyGoalMinutes) || 1) * 60;
  let cursor = startOfDay(today);
  if ((totals[dateKey(cursor)] || 0) < target) cursor = addDays(cursor, -1);
  let streak = 0;
  while ((totals[dateKey(cursor)] || 0) >= target) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function longestStreak(sessions, dailyGoalMinutes = 1) {
  const totals = dayTotals(sessions);
  const target = Math.max(1, Number(dailyGoalMinutes) || 1) * 60;
  const keys = Object.keys(totals).sort();
  let longest = 0;
  let running = 0;
  let previous = null;
  for (const key of keys) {
    if (totals[key] < target) continue;
    const date = localDateTime(key);
    const consecutive = previous && (date - previous) / 86400000 === 1;
    running = consecutive ? running + 1 : 1;
    longest = Math.max(longest, running);
    previous = date;
  }
  return longest;
}

export function activeDaysPerWeek(sessions) {
  if (!sessions.length) return 0;
  const unique = [...new Set(sessions.map((session) => dateKey(session.startedAt)))].sort();
  const first = localDateTime(unique[0]);
  const last = localDateTime(unique.at(-1));
  const weeks = Math.max(1, Math.ceil(((last - first) / 86400000 + 1) / 7));
  return unique.length / weeks;
}

export function summarizeSessions(sessions, dailyGoalMinutes = 1, today = new Date()) {
  const totalSec = sessions.reduce((sum, session) => sum + (Number(session.durationSec) || 0), 0);
  const weekStart = startOfWeek(today);
  const monthStart = startOfMonth(today);
  return {
    totalSessions: sessions.length,
    totalSec,
    averageSec: sessions.length ? totalSec / sessions.length : 0,
    currentStreak: currentStreak(sessions, dailyGoalMinutes, today),
    longestStreak: longestStreak(sessions, dailyGoalMinutes),
    weekSessions: sessionsBetween(sessions, weekStart, endOfDay(today)).length,
    monthSessions: sessionsBetween(sessions, monthStart, endOfDay(today)).length,
    activeDaysAverage: activeDaysPerWeek(sessions)
  };
}

export function rangeFor(kind, sessions = [], customFrom = "", customTo = "", today = new Date()) {
  const end = endOfDay(today);
  let start;
  if (kind === "1m") start = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate() + 1);
  else if (kind === "3m") start = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate() + 1);
  else if (kind === "6m") start = new Date(today.getFullYear(), today.getMonth() - 6, today.getDate() + 1);
  else if (kind === "1y") start = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1);
  else if (kind === "custom") {
    start = customFrom ? localDateTime(customFrom) : startOfMonth(today);
    return { from: startOfDay(start), to: customTo ? endOfDay(localDateTime(customTo)) : end };
  } else if (sessions.length) {
    start = startOfDay(new Date([...sessions].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))[0].startedAt));
  } else start = startOfMonth(today);
  return { from: startOfDay(start), to: end };
}

export function dailySeries(sessions, from, to) {
  const totals = dayTotals(sessionsBetween(sessions, startOfDay(from), endOfDay(to)));
  const points = [];
  let cursor = startOfDay(from);
  const end = endOfDay(to);
  while (cursor <= end && points.length < 2500) {
    const key = dateKey(cursor);
    points.push({ key, date: new Date(cursor), seconds: totals[key] || 0 });
    cursor = addDays(cursor, 1);
  }
  return points;
}

export function calendarDays(year, month) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(start, index);
    return { date, key: dateKey(date), inMonth: date.getMonth() === month };
  });
}

const STOP_WORDS = new Set("para como pero porque desde hasta sobre entre esta este estos estas cuando donde quien una uno unos unas que con del las los por sin muy más menos hoy ayer mañana durante después antes todo toda todos todas fue han hay me mi mis tu tus su sus y e o u a al de la el en es se lo le un ya".split(" "));

export function wordFrequencies(sessions, limit = 18) {
  const counts = new Map();
  sessions.forEach((session) => {
    String(session.notes || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-zñ]{3,}/g)
      ?.forEach((word) => {
        if (!STOP_WORDS.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
      });
  });
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "es"))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

export function categoryTotals(sessions) {
  const totals = Object.fromEntries(Object.keys(CATEGORY_META).map((key) => [key, 0]));
  sessions.forEach((session) => {
    const breakdown = session.breakdown || { [session.category || "luz"]: session.durationSec || 0 };
    Object.entries(breakdown).forEach(([category, seconds]) => {
      if (category in totals) totals[category] += Number(seconds) || 0;
    });
  });
  return totals;
}

