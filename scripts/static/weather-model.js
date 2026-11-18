/* Forecast rain, gusts and sunshine describe the hour ending at each
   timestamp. Task dates and deadlines follow Stellar's timezone, while
   the calendar and suggested times follow the forecast location's timezone. */

const HOUR = 3600;
const QUARTER = 900;
const TWILIGHT = 1800;
const LIMITS = { rain: 30, precipitation: 0.1, gust: 40, cold: 2, hot: 30 };
const unsuitableCodes = new Set([56, 57, 66, 67, 71, 73, 75, 77, 85, 86, 95, 96, 99]);

export const forecastFields = {
  current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m',
  hourly: 'temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_gusts_10m,sunshine_duration,is_day',
  daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max',
};

export function dayKeyFor(timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return seconds => {
    const parts = Object.fromEntries(format.formatToParts(seconds * 1000).map(({ type, value }) => [type, value]));
    return [parts.year, parts.month, parts.day].join('-');
  };
}

export function describeWeather(code, isDay = true) {
  if (code === 0) return isDay ? ['Clear', '☀', 'sun'] : ['Clear', '☾', 'moon'];
  if (code === 1 || code === 2) return ['Partly cloudy', isDay ? '⛅︎' : '☾', isDay ? 'sun' : 'moon'];
  if (code === 3) return ['Overcast', '☁', 'cloud'];
  if (code === 45 || code === 48) return ['Fog', '≋', 'cloud'];
  if (code >= 95) return ['Thunderstorms', 'ϟ', 'rain'];
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return ['Snow', '❄︎', 'cloud'];
  if (code >= 51) return [code < 60 ? 'Drizzle' : 'Rain', '☂︎', 'rain'];
  return ['Conditions unavailable', '·', 'cloud'];
}

export function readForecast(data) {
  const { current, hourly, daily, timezone } = data;
  if (!timezone || !Number.isFinite(current?.time) || !hourly?.time?.length || !daily?.time?.length) {
    throw new Error('Forecast is unavailable.');
  }
  const dateKey = dayKeyFor(timezone);
  const hours = hourly.time.map((time, i) => ({
    time, temperature: hourly.temperature_2m[i], feels: hourly.apparent_temperature[i],
    code: hourly.weather_code[i], daylit: hourly.is_day[i] === 1,
    rain: hourly.precipitation_probability[i], precipitation: hourly.precipitation[i],
    gust: hourly.wind_gusts_10m[i], sunshine: hourly.sunshine_duration[i],
  }));
  const intervals = hours.slice(1).flatMap((hour, i) => {
    const previous = hours[i];
    return hour.time - previous.time === HOUR ? [{
      start: previous.time, end: hour.time, rain: hour.rain, precipitation: hour.precipitation,
      gust: hour.gust, sunshine: hour.sunshine, minFeels: Math.min(previous.feels, hour.feels),
      maxFeels: Math.max(previous.feels, hour.feels),
      known: [previous.feels, hour.feels, previous.code, hour.code, hour.rain, hour.precipitation, hour.gust].every(Number.isFinite),
      blocked: unsuitableCodes.has(previous.code) || unsuitableCodes.has(hour.code),
    }] : [];
  });
  const days = daily.time.map((time, i) => ({
    key: dateKey(time), time, sunrise: daily.sunrise[i], sunset: daily.sunset[i],
    low: daily.temperature_2m_min[i], high: daily.temperature_2m_max[i],
    rain: daily.precipitation_probability_max[i], code: daily.weather_code[i],
  }));
  return { current, hours, intervals, days, timezone };
}

export function daylightAt(forecast, now) {
  const day = forecast.days.findLast(day => day.time <= now);
  const sunrise = day?.sunrise, sunset = day?.sunset;
  if (!Number.isFinite(sunrise) || !Number.isFinite(sunset) || sunset <= sunrise) {
    const hour = forecast.hours.findLast(hour => hour.time <= now);
    const daylight = hour?.daylit ?? (forecast.current.is_day === 1);
    return { phase: daylight ? 'day' : 'night', daylight };
  }
  const edge = Math.min(TWILIGHT, (sunset - sunrise) / 2);
  const daylight = now >= sunrise && now < sunset;
  let phase = daylight ? 'day' : 'night';
  if (now >= sunrise - edge && now < sunrise + edge) phase = 'dawn';
  else if (now >= sunset - edge && now < sunset + edge) phase = 'dusk';
  return { phase, daylight };
}

export function weatherScene(forecast, now) {
  const { phase, daylight } = daylightAt(forecast, now);
  const code = forecast.current.weather_code;
  let kind = 'unknown';
  if (code === 0 || code === 1) kind = daylight ? 'sun' : 'night';
  else if (code === 2) kind = daylight ? 'cloud' : 'nightcloud';
  else if (code === 3) kind = 'overcast';
  else if (code === 45 || code === 48) kind = 'fog';
  else if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) kind = 'rain';
  else if ([71, 73, 75, 77, 85, 86].includes(code)) kind = 'snow';
  else if ([95, 96, 99].includes(code)) kind = 'storm';
  return { kind, phase };
}

export function outdoorSuitable(hour) {
  return hour.known && !hour.blocked && hour.rain <= LIMITS.rain &&
    hour.precipitation <= LIMITS.precipitation && hour.gust <= LIMITS.gust &&
    hour.minFeels >= LIMITS.cold && hour.maxFeels <= LIMITS.hot;
}

export function planOutdoorTime(forecast, { now, duration, title, records, taskTimeZone }) {
  const taskDay = dayKeyFor(taskTimeZone);
  const seconds = duration * 60;
  return forecast.days.map(day => {
    const candidates = [];
    const relevant = forecast.intervals.filter(hour => hour.end > day.sunrise && hour.start < day.sunset);
    const availableTasks = new Set();
    let completed = false, beforeDeadline = false;
    if (!Number.isFinite(day.sunrise) || !Number.isFinite(day.sunset)) return { ...day, windows: [], reason: 'No daylight forecast' };

    const first = Math.ceil(Math.max(now, day.sunrise) / QUARTER) * QUARTER;
    const last = day.sunset - seconds;
    for (let start = first; start <= last; start += QUARTER) {
      const end = start + seconds;
      const date = taskDay(start);
      if (title) {
        const task = records?.[date]?.find(row => row.title === title);
        if (!task) continue;
        if (task.is_completed) { completed = true; continue; }
        availableTasks.add(date);
        const deadline = Date.parse(task.deadline_at || task.report_due_at) / 1000;
        if (taskDay(end - 1) !== date || Number.isFinite(deadline) && end > deadline) continue;
      }
      beforeDeadline = true;
      const hours = relevant.filter(hour => hour.end > start && hour.start < end);
      const covered = hours.reduce((sum, hour) => sum + Math.min(end, hour.end) - Math.max(start, hour.start), 0);
      if (covered !== seconds || !hours.every(outdoorSuitable)) continue;
      const sun = hours.reduce((sum, hour) => {
        const overlap = Math.min(end, hour.end) - Math.max(start, hour.start);
        return sum + overlap * (Number.isFinite(hour.sunshine) ? hour.sunshine / HOUR : 0);
      }, 0) / seconds;
      const rain = Math.max(...hours.map(hour => hour.rain));
      const gust = Math.max(...hours.map(hour => hour.gust));
      const low = Math.min(...hours.map(hour => hour.minFeels));
      const high = Math.max(...hours.map(hour => hour.maxFeels));
      const score = sun * 35 - rain * 1.5 - gust * .3 - Math.abs((low + high) / 2 - 15) * .8;
      candidates.push({ start, end, date, sun, rain, gust, low, high, score });
    }
    const windows = [];
    candidates.sort((a, b) => b.score - a.score || a.start - b.start);
    for (const candidate of candidates) {
      if (windows.some(window => window.start < candidate.end && window.end > candidate.start)) continue;
      windows.push(candidate);
      if (windows.length === 3) break;
    }
    let reason = 'No dry window found';
    if (first > last) reason = 'No daylight time left';
    else if (title && !records) reason = 'Task schedule unavailable';
    else if (title && !availableTasks.size) reason = completed ? 'Task complete' : 'Task not scheduled';
    else if (title && !beforeDeadline) reason = 'No time before the task deadline';
    return { ...day, windows, reason };
  });
}
