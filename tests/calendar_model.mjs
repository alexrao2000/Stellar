import assert from 'node:assert/strict';
import test from 'node:test';
import { readForecast } from '../scripts/static/weather-model.js';
import { eventLayout, interval, overlaps, runSuggestions, zonedTime } from '../scripts/static/calendar-model.js';
import fixture from './weather_fixture.cjs';

const { forecast, hour, records, today } = fixture;
const options = { days: [today, '2026-11-17'], events: [], records: records(), timeZone: 'America/Los_Angeles', now: hour(8) };
const event = (start, end, values = {}) => ({ id: 'meeting', title: 'Meeting', starts_at: new Date(start * 1000).toISOString(), ends_at: new Date(end * 1000).toISOString(), kind: 'event', ...values });

test('a ten-minute run fits the sunny break on a rainy day, and completed runs need no suggestion', () => {
  const [day, tomorrow] = runSuggestions(readForecast(forecast()), options);
  assert.equal(day.slots[0].start, hour(10));
  assert.equal(day.slots[0].end - day.slots[0].start, 600);
  assert.equal(day.slots[0].rain, 10);
  assert.equal(tomorrow.reason, 'Run recorded');
  assert.equal(tomorrow.slots.length, 0);
});

test('busy events, all-day events, buffers, and task deadlines constrain every offered slot', () => {
  const data = readForecast(forecast());
  const events = [event(hour(10), hour(10.4))];
  const [day] = runSuggestions(data, { ...options, events, buffer: 5 });
  assert(day.slots.length);
  for (const slot of day.slots) {
    assert(!overlaps({ start: slot.start - 300, end: slot.end + 300 }, interval(events[0])));
    assert(slot.end <= hour(12));
  }
  const allDay = [event(hour(0), hour(24), { all_day: true })];
  assert.equal(runSuggestions(data, { ...options, events: allDay })[0].slots.length, 0);
});

test('alternatives are deterministic, diverse and at least an hour apart', () => {
  const input = { ...options, days: ['2026-11-17'], records: {}, now: hour(8), earliest: 9 * 60, latest: 16 * 60 };
  const first = runSuggestions(readForecast(forecast()), input)[0].slots;
  assert.equal(first.length, 3);
  assert.deepEqual(first, runSuggestions(readForecast(forecast()), input)[0].slots);
  assert(first[2].start - first[0].start >= 5 * 3600);
  for (let i = 1; i < first.length; i++) assert(first[i].start - first[i - 1].start >= 3600);
});

test('a scheduled run suppresses further choices without changing task completion', () => {
  const input = { ...options, events: [event(hour(10), hour(10) + 600, { kind: 'run', task_title: 'Run' })] };
  assert.equal(runSuggestions(readForecast(forecast()), input)[0].reason, 'Run scheduled');
  assert.equal(input.records[today][0].is_completed, false);
});

test('missing or hazardous weather never creates a good-looking running recommendation', () => {
  for (const [field, value] of [['precipitation_probability', null], ['weather_code', 95], ['wind_gusts_10m', 70]]) {
    const data = forecast(); data.hourly[field].fill(value);
    assert.equal(runSuggestions(readForecast(data), options)[0].slots.length, 0);
  }
});

test('app timezone determines calendar dates even when weather is in another timezone', () => {
  const [day] = runSuggestions(readForecast(forecast()), { ...options, records: {}, days: ['2026-11-17'], timeZone: 'Asia/Tokyo', earliest: 0, latest: 1439 });
  assert(day.slots.length);
  assert.equal(day.slots[0].day, '2026-11-17');
});

test('DST dates preserve their real duration and reject a nonexistent local input', () => {
  assert.equal(zonedTime('2026-03-08', 150, 'America/Los_Angeles'), null);
  assert.equal(zonedTime('2026-03-09', 0, 'America/Los_Angeles') - zonedTime('2026-03-08', 0, 'America/Los_Angeles'), 23 * 3600);
  assert.equal(zonedTime('2026-11-02', 0, 'America/Los_Angeles') - zonedTime('2026-11-01', 0, 'America/Los_Angeles'), 25 * 3600);
});

test('calendar cards share columns when their minimum readable height overlaps', () => {
  const laidOut = eventLayout([event(hour(10), hour(11)), event(hour(10.5), hour(11.5), { id: 'second' })], today, options.timeZone);
  assert.equal(laidOut[0].columns, 2); assert.equal(laidOut[1].columns, 2);
  assert.notEqual(laidOut[0].column, laidOut[1].column);
});

test('indoor task planning works without weather and ignores free calendar events', async () => {
  const { taskSuggestions } = await import('../scripts/static/calendar-model.js');
  const task = { series_id: 1, title: 'Read', titles: ['Read'], starts_on: today, rule: { enabled: true, duration_minutes: 30, earliest: 9 * 60, latest: 12 * 60, weather: 'any', daylight_only: false, buffer_minutes: 5 } };
  const input = { ...options, task, days: [today], records: { [today]: [{ title: 'Read', series_id: 1, is_completed: false }] }, events: [event(hour(9), hour(10)), event(hour(10), hour(11), { id: 'free', blocks_time: false })] };
  const plan = taskSuggestions(null, input)[0];
  assert(plan.slots.length);
  assert(plan.slots.every(slot => slot.start >= hour(10) + 300 && slot.end - slot.start === 1800 && slot.end <= hour(12)));
  assert.equal(taskSuggestions(null, { ...input, records: {} })[0].slots.length, 0);
});

test('task-specific weather, duration and deadline must hold across the entire slot', async () => {
  const { taskSuggestions } = await import('../scripts/static/calendar-model.js');
  const task = { series_id: 1, title: 'Run', titles: ['Run'], starts_on: today, rule: { enabled: true, duration_minutes: 10, earliest: 7 * 60, latest: 21 * 60, weather: 'dry', daylight_only: true, buffer_minutes: 0, max_rain_percent: 30, max_wind_kph: 40, min_temperature_c: 2, max_temperature_c: 30 } };
  const input = { ...options, task, days: [today] };
  const plan = taskSuggestions(readForecast(forecast()), input)[0];
  assert.equal(plan.slots[0].start, hour(10));
  assert(plan.slots.every(slot => slot.end <= hour(12)));
  assert.equal(taskSuggestions(null, input)[0].slots.length, 0);
  const longer = { ...task, rule: { ...task.rule, duration_minutes: 90 } };
  assert.equal(taskSuggestions(readForecast(forecast()), { ...input, task: longer })[0].slots.length, 0);
});

test('task series identity survives renames and a booked or recorded task needs no suggestion', async () => {
  const { taskSuggestions } = await import('../scripts/static/calendar-model.js');
  const task = { series_id: 3, title: 'Read a chapter', titles: ['Read', 'Read a chapter'], starts_on: today, rule: { enabled: true, duration_minutes: 15, earliest: 540, latest: 1260, weather: 'any', daylight_only: false, buffer_minutes: 0 } };
  const input = { ...options, task, days: [today], records: { [today]: [{ series_id: 3, title: 'Read', is_completed: false }] } };
  assert.equal(taskSuggestions(null, input)[0].slots[0].taskTitle, 'Read');
  assert.equal(taskSuggestions(null, { ...input, events: [event(hour(10), hour(10.5), { kind: 'task', task_series_id: '3' })] })[0].reason, 'Task scheduled');
  assert.equal(taskSuggestions(null, { ...input, records: { [today]: [{ series_id: 3, title: 'Read', is_completed: true }] } })[0].reason, 'Task recorded');
});

test('overnight task windows stay continuous and honor the reporting deadline', async () => {
  const { taskSuggestions } = await import('../scripts/static/calendar-model.js');
  const task = { series_id: 2, title: 'Study', titles: ['Study'], starts_on: today, rule: { enabled: true, duration_minutes: 60, earliest: 1320, latest: 60, weather: 'any', daylight_only: false, buffer_minutes: 0 } };
  const input = { ...options, task, days: [today], records: { [today]: [{ title: 'Study', deadline_at: new Date(hour(24.5) * 1000).toISOString() }] } };
  const plan = taskSuggestions(null, input)[0];
  assert(plan.slots.length);
  assert(plan.slots.every(slot => slot.start >= hour(22) && slot.end <= hour(24.5)));
});
