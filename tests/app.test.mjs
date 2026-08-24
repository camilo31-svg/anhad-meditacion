import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  calendarDays,
  categoryTotals,
  currentStreak,
  dailySeries,
  dateKey,
  formatClock,
  summarizeSessions,
  wordFrequencies
} from "../core.js";

function session(day, minutes, category = "luz", notes = "") {
  const startedAt = new Date(2026, 7, day, 6, 0, 0).toISOString();
  return {
    id: `s-${day}`,
    startedAt,
    durationSec: minutes * 60,
    category,
    breakdown: { [category]: minutes * 60 },
    notes
  };
}

test("formats meditation clocks", () => {
  assert.equal(formatClock(65), "01:05");
  assert.equal(formatClock(3661), "01:01:01");
});

test("calculates a goal-based streak", () => {
  const sessions = [session(22, 60), session(23, 60), session(24, 60)];
  assert.equal(currentStreak(sessions, 60, new Date(2026, 7, 24, 12)), 3);
  assert.equal(summarizeSessions(sessions, 60, new Date(2026, 7, 24, 12)).averageSec, 3600);
});

test("calendar and daily bars retain empty days", () => {
  assert.equal(calendarDays(2026, 7).length, 42);
  const points = dailySeries([session(24, 30)], new Date(2026, 7, 22), new Date(2026, 7, 24));
  assert.deepEqual(points.map((point) => point.seconds), [0, 0, 1800]);
  assert.equal(points.at(-1).key, dateKey(new Date(2026, 7, 24)));
});

test("aggregates categories and words from private notes", () => {
  const sessions = [session(24, 25, "luz", "Mucha calma y claridad"), session(23, 20, "sonido", "Calma profunda")];
  assert.equal(categoryTotals(sessions).luz, 1500);
  assert.equal(categoryTotals(sessions).sonido, 1200);
  assert.deepEqual(wordFrequencies(sessions, 2).map((item) => item.word), ["calma", "claridad"]);
});

test("numeric controls persist on input without rebuilding the active screen", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const helper = source.slice(source.indexOf("function bindBoundedNumber"), source.indexOf("function bindMeditateEvents"));
  assert.match(helper, /addEventListener\("input"/);
  assert.match(helper, /addEventListener\("blur"/);
  assert.doesNotMatch(helper, /render\(\)/);

  const settingsBindings = source.slice(source.indexOf("function bindSettingsEvents"), source.indexOf("function renderModal"));
  const numericBindings = settingsBindings.slice(0, settingsBindings.indexOf('document.querySelectorAll("[data-setting-select]"'));
  assert.match(numericBindings, /bindBoundedNumber/);
  assert.doesNotMatch(numericBindings, /render\(\)/);
});

