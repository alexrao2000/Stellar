const time = Date.parse('2026-11-16T00:00:00-08:00') / 1000;
const hour = (hours, day = 0) => time + (day * 24 + hours) * 3600;
const today = '2026-11-16';

function forecast(currentCode = 63, isDay = 1) {
  const hours = Array.from({ length: 168 }, (_, i) => i);
  const dates = Array.from({ length: 7 }, (_, i) => i);
  const dry = i => i >= 24 || i === 11 || i === 14 || i === 15;
  return {
    timezone: 'America/Los_Angeles',
    current: { time: hour(8), temperature_2m: 15, apparent_temperature: 14, is_day: isDay, weather_code: currentCode },
    hourly: {
      time: hours.map(i => hour(i)),
      temperature_2m: hours.map(() => 15),
      apparent_temperature: hours.map(() => 14),
      precipitation: hours.map(i => dry(i) ? 0 : 2),
      precipitation_probability: hours.map(i => dry(i) ? 10 : 90),
      wind_gusts_10m: hours.map(() => 12),
      sunshine_duration: hours.map(i => i === 11 ? 3200 : dry(i) ? 1200 : 0),
      weather_code: hours.map(i => dry(i) ? 2 : 63),
      is_day: hours.map(i => i % 24 >= 7 && i % 24 < 17 ? 1 : 0),
    },
    daily: {
      time: dates.map(i => hour(0, i)),
      sunrise: dates.map(i => hour(7, i)), sunset: dates.map(i => hour(17, i)),
      temperature_2m_max: dates.map(() => 16), temperature_2m_min: dates.map(() => 9),
      precipitation_probability_max: dates.map(i => i ? 10 : 90),
      weather_code: dates.map(i => i ? 2 : 63),
    },
  };
}

function records() {
  return {
    [today]: [{ id: 1, day: today, title: 'Run', list_title: 'Daily', status: 'needsAction', is_completed: false, deadline_at: '2026-11-16T20:00:00Z' }],
    '2026-11-17': [{ id: 2, day: '2026-11-17', title: 'Run', list_title: 'Daily', status: 'completed', is_completed: true }],
    '2026-11-18': [{ id: 3, day: '2026-11-18', title: 'Take a walk', list_title: 'Daily', status: 'needsAction', is_completed: false }],
  };
}

module.exports = { forecast, hour, records, today };
