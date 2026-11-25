/* Calendar dates follow the app timezone, including 23/25-hour DST days.
   Task candidates use complete hourly weather intervals, daylight, task outcomes
   and busy events. Ranking is stable; alternatives are at least an hour apart.
   Recommendations reserve no time until the user selects a slot. */
import { dayKeyFor, daylightAt, outdoorSuitable } from './weather-model.js?v=4';

const formats = new Map();

export const shiftDay = (day, count) => new Date(Date.parse(day + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10);

export function localParts(seconds, timeZone) {
  if (!formats.has(timeZone)) formats.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const parts = Object.fromEntries(formats.get(timeZone).formatToParts(seconds * 1000).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute };
}

export function zonedTime(day, minutes, timeZone) {
  const wanted = Date.parse(day + 'T00:00:00Z') / 1000 + minutes * 60;
  let guess = wanted;
  for (let i = 0; i < 4; i++) {
    const actual = localParts(guess, timeZone);
    const observed = Date.parse(actual.day + 'T00:00:00Z') / 1000 + actual.minutes * 60;
    if (observed === wanted) return guess;
    guess += wanted - observed;
  }
  return null;
}

export function weekStart(day) {
  const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

export function overlaps(a, b) { return a.start < b.end && a.end > b.start; }
export const interval = event => ({ start: Date.parse(event.starts_at) / 1000, end: Date.parse(event.ends_at) / 1000 });

export function runSuggestions(forecast, { days, events, records = {}, taskTitle = 'Run', timeZone, now,
  earliest = 7 * 60, latest = 21 * 60, buffer = 0 }) {
  const duration = 10 * 60;
  const dateKey = dayKeyFor(timeZone);
  const busy = events.map(interval).filter(event => Number.isFinite(event.start) && Number.isFinite(event.end));
  const slots = new Map(days.map(day => [day, []]));
  const scheduled = new Set(events.filter(e => e.kind === 'run' && (e.task_title || 'Run') === taskTitle).map(e => dateKey(interval(e).start)));
  const done = new Set(Object.entries(records).filter(([, rows]) => rows.some(row => row.title === taskTitle && row.is_completed)).map(([day]) => day));
  const weatherDate = dayKeyFor(forecast.timezone);
  const coveredDays = new Set(forecast.days.filter(day => Number.isFinite(day.sunrise) && Number.isFinite(day.sunset)).map(day => day.key));
  const candidates = [];
  for (const day of days) {
    if (scheduled.has(day) || done.has(day)) continue;
    const first = zonedTime(day, earliest, timeZone), last = zonedTime(day, latest, timeZone);
    if (first == null || last == null) continue;
    const row = records[day]?.find(row => row.title === taskTitle);
    const deadline = Date.parse(row?.deadline_at || row?.report_due_at) / 1000;
    const start = Math.ceil(Math.max(first, now + 5 * 60) / 300) * 300;
    for (let time = start; time + duration <= last; time += 300) {
      const end = time + duration;
      const local = localParts(time, timeZone), finish = localParts(end, timeZone);
      if (local.minutes < earliest || finish.day !== day || finish.minutes > latest || Number.isFinite(deadline) && end > deadline) continue;
      if (!daylightAt(forecast, time).daylight || !daylightAt(forecast, end - 1).daylight) continue;
      if (!coveredDays.has(weatherDate(time))) continue;
      if (busy.some(event => overlaps({ start: time - buffer * 60, end: end + buffer * 60 }, event))) continue;
      const weather = forecast.intervals.filter(hour => hour.end > time && hour.start < end);
      if (weather.reduce((sum, hour) => sum + Math.min(end, hour.end) - Math.max(time, hour.start), 0) !== duration) continue;
      if (!weather.every(outdoorSuitable)) continue;
      const sun = weather.reduce((sum, hour) => sum + (Math.min(end, hour.end) - Math.max(time, hour.start)) *
        (Number.isFinite(hour.sunshine) ? hour.sunshine / 3600 : 0), 0) / duration;
      const rain = Math.max(...weather.map(hour => hour.rain));
      const gust = Math.max(...weather.map(hour => hour.gust));
      const feels = weather.reduce((sum, hour) => sum + hour.minFeels + hour.maxFeels, 0) / (weather.length * 2);
      const score = sun * 35 - rain * 1.5 - gust * .3 - Math.abs(feels - 15) * .8;
      candidates.push({ day, start: time, end, rain, gust, feels, sun, score, taskTitle });
    }
  }
  for (const day of days) {
    const chosen = slots.get(day), available = candidates.filter(slot => slot.day === day);
    while (chosen.length < 3) {
      const distance = slot => chosen.length ? Math.min(...chosen.map(other => Math.abs(slot.start - other.start))) : 0;
      const eligible = available.filter(slot => !chosen.includes(slot) && (!chosen.length || distance(slot) >= 3600));
      eligible.sort((a, b) => b.score - a.score || distance(b) - distance(a) || a.start - b.start);
      if (!eligible.length) break;
      chosen.push(eligible[0]);
    }
  }
  return days.map(day => ({ day, slots: slots.get(day).map((slot, index) => ({ ...slot, rank: index + 1 })).sort((a, b) => a.start - b.start),
    reason: done.has(day) ? 'Run recorded' : scheduled.has(day) ? 'Run scheduled' : 'No suitable free weather window' }));
}

export function eventLayout(items, day, timeZone, hourHeight = 76) {
  const first = zonedTime(day, 0, timeZone), last = zonedTime(shiftDay(day, 1), 0, timeZone);
  if (first == null || last == null) return [];
  const visible = items.filter(event => overlaps(interval(event), { start: first, end: last })).map(event => {
    const span = interval(event);
    const top = Math.max(0, localParts(Math.max(span.start, first), timeZone).minutes) / 60 * hourHeight;
    const until = span.end >= last ? 1440 : localParts(span.end, timeZone).minutes;
    return { ...event, top, height: Math.max(28, until / 60 * hourHeight - top), column: 0, columns: 1 };
  }).sort((a, b) => a.top - b.top || b.height - a.height || a.id.localeCompare(b.id));
  let group = [], ends = [], bottom = -1;
  const finish = () => { group.forEach(event => { event.columns = ends.length; }); group = []; ends = []; };
  for (const event of visible) {
    if (event.top >= bottom) finish();
    let column = ends.findIndex(end => end <= event.top);
    if (column < 0) column = ends.length;
    ends[column] = event.top + event.height;
    event.column = column; group.push(event); bottom = Math.max(...ends);
  }
  finish();
  return visible;
}

export function taskSuggestions(forecast, { task, days, events, records = {}, timeZone, now }) {
  const rule = task.rule, duration = rule.duration_minutes * 60;
  const busy = events.filter(event => event.blocks_time !== false).map(interval);
  const needsWeather = rule.weather !== 'any' || rule.daylight_only;
  const matches = event => event.task_series_id != null && String(event.task_series_id) === String(task.series_id) ||
    (task.titles || [task.title]).includes(event.task_title);
  return days.map(day => {
    const rows = records[day] || [], row = rows.find(row => row.series_id != null && String(row.series_id) === String(task.series_id)) ||
      rows.find(row => (task.titles || [task.title]).includes(row.title));
    const scheduled = events.some(event => ['run', 'task'].includes(event.kind) && matches(event) && localParts(interval(event).start, timeZone).day === day);
    const unavailable = !rule.enabled ? 'Planning is off for this task' : !row || day < task.starts_on || task.ends_on && day > task.ends_on ? 'Not scheduled this day' :
      row.is_completed ? 'Task recorded' : scheduled ? 'Task scheduled' : needsWeather && !forecast ? 'Waiting for the weather forecast' : '';
    if (unavailable) return { day, slots: [], reason: unavailable };
    const overnight = rule.latest <= rule.earliest;
    const first = zonedTime(day, rule.earliest, timeZone);
    const last = zonedTime(overnight ? shiftDay(day, 1) : day, rule.latest, timeZone);
    const deadline = Date.parse(row.deadline_at || row.report_due_at) / 1000;
    const candidates = [], chosen = [];
    if (first == null || last == null) return { day, slots: [], reason: 'The clocks change during this time window' };
    for (let start = Math.ceil(Math.max(first, now + 5 * 60) / 300) * 300; start + duration <= last; start += 300) {
      const end = start + duration;
      if (Number.isFinite(deadline) && end > deadline) continue;
      if (busy.some(event => overlaps({ start: start - rule.buffer_minutes * 60, end: end + rule.buffer_minutes * 60 }, event))) continue;
      let rain = null, gust = null, feels = null, sun = 0;
      if (needsWeather) {
        const hours = forecast.intervals.filter(hour => hour.end > start && hour.start < end);
        if (hours.reduce((sum, hour) => sum + Math.min(end, hour.end) - Math.max(start, hour.start), 0) !== duration) continue;
        if (rule.daylight_only) {
          const solar = forecast.days.find(d => d.key === dayKeyFor(forecast.timezone)(start));
          if (!solar || !Number.isFinite(solar.sunrise) || !Number.isFinite(solar.sunset) || start < solar.sunrise || end > solar.sunset) continue;
        }
        if (rule.weather !== 'any' && !hours.every(hour => hour.known && !hour.blocked && hour.rain <= rule.max_rain_percent &&
          hour.precipitation <= .1 && hour.gust <= rule.max_wind_kph && hour.minFeels >= rule.min_temperature_c && hour.maxFeels <= rule.max_temperature_c)) continue;
        sun = hours.reduce((sum, hour) => sum + (Math.min(end, hour.end) - Math.max(start, hour.start)) * (Number.isFinite(hour.sunshine) ? hour.sunshine / 3600 : 0), 0) / duration;
        if (rule.weather === 'sunny' && sun < .35) continue;
        rain = Math.max(...hours.map(h => h.rain)); gust = Math.max(...hours.map(h => h.gust));
        feels = hours.reduce((sum, h) => sum + h.minFeels + h.maxFeels, 0) / (hours.length * 2);
      }
      const score = needsWeather && rule.weather !== 'any' ? sun * 35 - rain * 1.5 - gust * .3 - Math.abs(feels - 15) * .8 : 0;
      candidates.push({ day, start, end, rain, gust, feels, sun, score, taskTitle: row.title, taskSeriesId: task.series_id });
    }
    while (chosen.length < 3) {
      const distance = slot => chosen.length ? Math.min(...chosen.map(other => Math.abs(slot.start - other.start))) : 0;
      const eligible = candidates.filter(slot => !chosen.includes(slot) && (!chosen.length || distance(slot) >= Math.max(3600, duration)));
      eligible.sort((a, b) => b.score - a.score || distance(b) - distance(a) || a.start - b.start);
      if (!eligible.length) break;
      chosen.push(eligible[0]);
    }
    return { day, slots: chosen.map((slot, i) => ({ ...slot, rank: i + 1 })).sort((a, b) => a.start - b.start),
      reason: needsWeather ? 'No free slot meets this task’s time and weather settings' : 'No free slot within this task’s allowed hours' };
  });
}
