/* Calendar dates follow the app timezone, including 23/25-hour DST days.
   Run candidates use complete hourly weather intervals, daylight, task outcomes
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
