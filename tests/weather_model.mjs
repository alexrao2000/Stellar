import assert from 'node:assert/strict';
import test from 'node:test';
import { daylightAt, planOutdoorTime, readForecast, weatherScene } from '../scripts/static/weather-model.js';
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

test('sky phases use the forecast city sunrise and sunset even with a stale daylight flag', () => {
  const data = readForecast(forecast(63, 1));
  for (const [time, phase, daylight] of [
    [hour(6), 'night', false], [hour(6.75), 'dawn', false], [hour(7.25), 'dawn', true],
    [hour(8), 'day', true], [hour(16.75), 'dusk', true], [hour(17.25), 'dusk', false],
    [hour(18), 'night', false], [hour(6.75, 1), 'dawn', false],
  ]) assert.deepEqual(daylightAt(data, time), { phase, daylight });
  data.days[0].sunrise = null;
  assert.deepEqual(daylightAt(data, hour(22)), { phase: 'night', daylight: false });
});

test('current conditions choose a stable scene independently of the selected forecast day', () => {
  for (const [code, kind] of [[0, 'sun'], [1, 'sun'], [2, 'cloud'], [3, 'overcast'], [45, 'fog'],
    [53, 'rain'], [63, 'rain'], [81, 'rain'], [73, 'snow'], [95, 'storm'], [null, 'unknown'], [100, 'unknown']]) {
    const data = readForecast(forecast(code));
    assert.deepEqual(weatherScene(data, hour(8)), { kind, phase: 'day' });
    data.days.forEach(day => { day.code = 95; });
    data.hours.forEach(hour => { hour.code = 95; });
    assert.deepEqual(weatherScene(data, hour(8)), { kind, phase: 'day' });
  }
});

test('twilight colors do not select a moon before sunset or after sunrise', () => {
  const data = readForecast(forecast(0));
  assert.deepEqual(weatherScene(data, hour(16.75)), { kind: 'sun', phase: 'dusk' });
  assert.deepEqual(weatherScene(data, hour(17.25)), { kind: 'night', phase: 'dusk' });
  assert.deepEqual(weatherScene(data, hour(6.75)), { kind: 'night', phase: 'dawn' });
  assert.deepEqual(weatherScene(data, hour(7.25)), { kind: 'sun', phase: 'dawn' });
  assert.deepEqual(weatherScene(readForecast(forecast(3)), hour(18)), { kind: 'overcast', phase: 'night' });
});
