import assert from 'node:assert/strict';
import test from 'node:test';
import { planOutdoorTime, readForecast } from '../scripts/static/weather-model.js';
import fixture from './weather_fixture.cjs';

const { forecast, hour, records, today } = fixture;
const options = { now: hour(8), title: 'Run', duration: 45, taskTimeZone: 'America/Los_Angeles' };

test('a rainy daily forecast still includes its dry and sunny hour before the task deadline', () => {
  const [first, tomorrow, unscheduled] = planOutdoorTime(readForecast(forecast()), { ...options, records: records() });
  assert.equal(first.rain, 90);
  assert.equal(first.windows.length, 1);
  assert.equal(first.windows[0].start, hour(10));
  assert.equal(first.windows[0].end, hour(10.75));
  assert(first.windows[0].sun > .8);
  assert.equal(tomorrow.reason, 'Task complete');
  assert.equal(unscheduled.reason, 'Task not scheduled');
});

test('duration, the current time and the task deadline bound the recommendation', () => {
  const data = readForecast(forecast());
  const plan = overrides => planOutdoorTime(data, { ...options, records: records(), ...overrides })[0];
  assert.equal(plan({ duration: 90 }).windows.length, 0);
  assert.equal(plan({ now: hour(10.25), duration: 45 }).windows[0].start, hour(10.25));
  assert.equal(plan({ now: hour(11) }).windows.length, 0);
  assert.equal(plan({ now: hour(12) }).reason, 'No time before the task deadline');
  assert.equal(plan({ title: '', now: hour(11), duration: 90 }).windows[0].start, hour(13));
});

test('missing rain data, excessive gusts and thunder do not become dry windows', () => {
  for (const [key, value] of [
    ['precipitation_probability', null], ['wind_gusts_10m', 60], ['weather_code', 95],
  ]) {
    const data = forecast();
    data.hourly[key][11] = value;
    assert.equal(planOutdoorTime(readForecast(data), { ...options, records: records() })[0].windows.length, 0);
  }
});

test('forecast days remain local while a task uses its own calendar date', () => {
  const tasks = { '2026-11-17': [{ title: 'Run', is_completed: false }] };
  const [first] = planOutdoorTime(readForecast(forecast()), { ...options, records: tasks, taskTimeZone: 'Asia/Tokyo' });
  assert.equal(first.key, today);
  assert.equal(first.windows[0].date, '2026-11-17');
  assert.equal(first.windows[0].start, hour(10));
});
