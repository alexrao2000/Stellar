/* Weather is loaded on demand. The shared app backdrop refreshes
   with the planner closed, and location requests contain no task data.
   Hidden or occluded scenes pause in place to resume without a phase reset.
   Failed refreshes retain the last known sky and label the forecast as stale. */

import { changeScene, notifyWeather, requestWeatherForecast } from './weather-background.js?v=2';

import { dayKeyFor, daylightAt, describeWeather, planOutdoorTime, readForecast, weatherScene } from './weather-model.js?v=3';

const PREFIX = 'stellar:weather:';
const FORECAST_TTL = 15 * 60000;
const CACHE_AGE = 45 * 60000;
const DEFAULT_CITIES = [
  { name: 'Fremont', detail: 'California, United States', latitude: 37.54827, longitude: -121.98857 },
  { name: 'Los Angeles', detail: 'California, United States', latitude: 34.05223, longitude: -118.24368 },
];
function readSetting(name) {
  try { return JSON.parse(localStorage.getItem(PREFIX + name)); }
  catch { return null; }
}

function saveSetting(name, value) {
  try { localStorage.setItem(PREFIX + name, JSON.stringify(value)); }
  catch {}
  if (['place', 'forecast', 'theme'].includes(name)) notifyWeather();
}

function savedCity(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() ||
      !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90 ||
      !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180) return null;
  return { name: value.name.trim().slice(0, 100), latitude: value.latitude, longitude: value.longitude,
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 140) : '' };
}

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
}

async function getJSON(base, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const url = new URL(base, location.origin);
    url.search = new URLSearchParams(params);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Your session expired. Reopen Stellar to sign in.');
      const error = await response.json().catch(() => ({}));
      throw new Error(typeof error.detail === 'string' ? error.detail : 'Weather could not load. Try again.');
    }
    return await response.json();
  } finally { clearTimeout(timeout); }
}

function weatherIcon(code, daylit) {
  const [name, symbol, kind] = describeWeather(code, daylit);
  const icon = element('span', symbol, 'weather-icon');
  icon.dataset.kind = kind;
  icon.setAttribute('aria-hidden', 'true');
  icon.title = name;
  return icon;
}

const degrees = celsius => Number.isFinite(celsius) ? Math.round(celsius * 9 / 5 + 32) + '°' : '—';
const percent = value => Number.isFinite(value) ? value + '%' : '—';
const pointKey = place => [place.latitude, place.longitude].join(',');

function hourlyCode(hour, end) {
  if (!end || !Number.isFinite(end.precipitation)) return hour.code;
  if (end.precipitation > .1) return end.code >= 51 ? end.code : hour.code >= 51 ? hour.code : 63;
  if (Number.isFinite(end.sunshine) && end.sunshine >= 1800) return 1;
  return end.code;
}

export function mountWeather({ dialog, trigger, taskTimeZone, loadTaskDays, openDay }) {
  dialog.innerHTML = `
    <div class="weather-dialog-sky" aria-hidden="true"></div>
    <header class="weather-top">
      <h2 id="weather-title">Weather</h2>
      <div class="weather-actions">
        <button type="button" class="weather-button" data-change hidden>Cities</button>
        <button type="button" class="weather-button weather-close" aria-label="Close weather" autofocus>×</button>
      </div>
    </header>
    <div class="weather-shell">
    <div class="weather-hero">
      <div class="weather-current" hidden>
        <div class="weather-current-details">
          <p class="weather-place" data-place></p>
          <p class="weather-temperature" data-temp></p>
          <p class="weather-condition" data-condition></p>
          <p class="weather-highlow" data-highlow></p>
          <p class="weather-solar" data-solar></p>
        </div>
        <label class="weather-theme"><input type="checkbox" data-theme role="switch"><span class="weather-switch-track" aria-hidden="true"></span><span>Use across Stellar</span></label>
      </div>
      <section class="weather-location" aria-label="Weather location" hidden>
        <h3>Weather where you are</h3>
        <div class="weather-saved-cities"></div>
        <form class="weather-search">
          <label for="weather-city">City or postal code</label>
          <div>
            <input id="weather-city" type="search" required minlength="2" maxlength="100" autocomplete="off" enterkeyhint="search" placeholder="Search for a city">
            <button class="weather-button" type="submit">Search</button>
          </div>
        </form>
        <div class="weather-results"></div>
        <p class="weather-search-note" role="status"></p>
      </section>
      <div class="weather-feedback" role="status"><span data-forecast-status></span><button type="button" class="weather-button" data-retry hidden>Retry</button></div>
    </div>
    <div class="weather-content" hidden>
      <section class="weather-card weather-hourly" aria-labelledby="weather-hourly-title">
        <div class="weather-card-head"><h3 id="weather-hourly-title">Hourly forecast</h3><span>°F · chance of precipitation</span></div>
        <div class="weather-hours" tabindex="0" aria-label="Upcoming hours"></div>
      </section>
      <section class="weather-card weather-planner" aria-labelledby="weather-planner-title">
        <div class="weather-card-head"><h3 id="weather-planner-title">Outdoor planner</h3><span data-planner-timezone></span></div>
        <div class="weather-options">
          <label>Task<select data-task aria-label="Task"><option value="">Any outdoor activity</option></select></label>
          <label>Duration<select data-duration aria-label="Duration"><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option><option value="90">90 min</option></select></label>
        </div>
        <div class="weather-week" role="group" aria-label="Seven-day forecast"></div>
        <div class="weather-window" aria-live="polite"></div>
        <details class="weather-method"><summary>How windows are picked</summary>
          <p>Daylight, low precipitation risk (30% or less), gusts up to 25 mph and a feels-like temperature of 36–86°F. Windows with more sunshine rank higher. Stellar checks your task schedule and deadline for each window.</p>
        </details>
      </section>
    </div>
    <footer class="weather-footer">
      <small>Forecast by <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> · Cities from <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a></small>
    </footer>
    </div>`;

  const $ = selector => dialog.querySelector(selector);
  const ui = {
    current: $('.weather-current'), location: $('.weather-location'), content: $('.weather-content'),
    hours: $('.weather-hours'), week: $('.weather-week'), window: $('.weather-window'),
    status: $('[data-forecast-status]'), retry: $('[data-retry]'), change: $('[data-change]'),
    task: $('[data-task]'), duration: $('[data-duration]'), theme: $('[data-theme]'),
  };
  const dialogScene = changeScene($('.weather-dialog-sky'));
  const appDay = dayKeyFor(taskTimeZone);
  const savedRecents = readSetting('recent');
  let recents = (Array.isArray(savedRecents) ? savedRecents : []).map(savedCity).filter(Boolean).slice(0, 6);
  let place = savedCity(readSetting('place')) || recents[0] || null;
  let task = readSetting('task'), forecast, forecastAt = 0, lastTry = 0;
  let dateFormat, weekdayFormat, monthDayFormat, timeFormat, dateKey, selectedDay, taskRecords, taskPending = false, taskError = false;
  let forecastJob, taskJob, taskReadVersions, citySearch = 0, placeVersion = 0, taskVersion = 0;
  let themed = readSetting('theme') === true;
  ui.theme.checked = themed;
  ui.duration.value = ['30', '45', '60', '90'].includes(readSetting('duration')) ? readSetting('duration') : '45';

  function rememberPlace(city) {
    recents = [city, ...recents.filter(recent => pointKey(recent) !== pointKey(city))].slice(0, 6);
    saveSetting('place', city);
    saveSetting('recent', recents);
  }

  function cityButton(city) {
    const button = element('button', null, 'weather-button weather-city');
    button.type = 'button';
    const active = place && pointKey(place) === pointKey(city);
    button.setAttribute('aria-pressed', String(!!active));
    button.append(element('strong', city.name));
    if (city.detail) button.append(element('span', city.detail));
    button.addEventListener('click', () => selectPlace(city));
    return button;
  }

  function paintCities() {
    const groups = [];
    for (const [label, cities] of [['Recently used', recents], ['Defaults', DEFAULT_CITIES]]) {
      if (!cities.length) continue;
      const section = element('div', null, 'weather-city-group');
      const heading = element('h4', label);
      const list = element('div', null, 'weather-city-list');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', label);
      list.append(...cities.map(cityButton));
      section.append(heading, list);
      groups.push(section);
    }
    $('.weather-saved-cities').replaceChildren(...groups);
  }

  function syncMotion() {
    const visible = !document.hidden && window.stellarPageActive();
    dialog.dataset.weatherMotion = visible && dialog.open ? 'running' : 'paused';
    notifyWeather();
  }

  function applyTheme() { notifyWeather(); }

  function acceptForecast(data, saved) {
    forecast = readForecast(data);
    forecastAt = saved;
    const badge = trigger.querySelector('[data-weather-temp]');
    badge.textContent = degrees(forecast.current.temperature_2m);
    badge.hidden = !Number.isFinite(forecast.current.temperature_2m);
    const timeZone = forecast.timezone;
    dateFormat = new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
    weekdayFormat = new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short' });
    monthDayFormat = new Intl.DateTimeFormat(undefined, { timeZone, month: 'short', day: 'numeric' });
    timeFormat = new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });
    dateKey = dayKeyFor(timeZone);
    applyTheme();
  }

  function restoreForecast() {
    const saved = readSetting('forecast');
    if (place && saved?.key === pointKey(place) && (Date.now() - saved.at < CACHE_AGE || top.stellarWeatherBackground?.hasForecast(saved.key))) {
      try { acceptForecast(saved.data, saved.at); }
      catch {}
    }
  }

  function paintStatus(message = '', failed = false) {
    ui.status.textContent = message;
    ui.retry.hidden = !failed;
  }

  function paintForecast() {
    syncMotion();
    if (!dialog.open) return;
    ui.current.hidden = !forecast && !themed;
    $('.weather-current-details').hidden = !forecast;
    ui.content.hidden = !forecast;
    ui.change.hidden = !place;
    ui.theme.disabled = !forecast && !themed;
    if (!place) ui.location.hidden = false;
    const now = Date.now() / 1000;
    dialogScene(forecast ? weatherScene(forecast, now) : null);
    if (!forecast) return;
    const { current, days, hours } = forecast;
    const { daylight } = daylightAt(forecast, now);
    const [condition] = describeWeather(current.weather_code, daylight);
    $('[data-place]').textContent = place.name;
    $('[data-temp]').textContent = degrees(current.temperature_2m);
    $('[data-condition]').textContent = condition + ' · Feels like ' + degrees(current.apparent_temperature);
    const today = days.find(day => day.key === dateKey(now));
    $('[data-highlow]').textContent = today ? 'High ' + degrees(today.high) + '   Low ' + degrees(today.low) : '';
    const edge = daylight ? today?.sunset : days.find(day => day.sunrise > now)?.sunrise;
    $('[data-solar]').textContent = Number.isFinite(edge) ? (daylight ? 'Sunset ' : 'Sunrise ') + timeFormat.format(edge * 1000) : '';
    const next = hours.findIndex(hour => hour.time > now);
    const upcoming = next < 0 ? [] : hours.slice(next, next + 8).map((hour, i) => {
      const end = hours[next + i + 1];
      return { ...hour, code: hourlyCode(hour, end), rain: end?.rain };
    });
    upcoming.unshift({ time: now, temperature: current.temperature_2m, code: current.weather_code, daylit: daylight, rain: hours[next]?.rain });
    ui.hours.replaceChildren(...upcoming.map((hour, i) => {
      const slot = element('div', null, 'weather-hour');
      const conditions = describeWeather(hour.code, hour.daylit)[0];
      slot.append(element('span', i === 0 ? 'Now' : timeFormat.format(hour.time * 1000)),
        weatherIcon(hour.code, hour.daylit), element('strong', degrees(hour.temperature)),
        element('span', percent(hour.rain), 'weather-rain'),
        element('span', conditions, 'weather-sr'));
      return slot;
    }));
    paintPlanner();
  }

  function populateTasks() {
    const titles = [...new Set(Object.values(taskRecords || {}).flatMap(rows => rows.map(row => row.title)))]
      .filter(title => title !== 'Weigh yourself' && title !== 'Wake Up').sort((a, b) => a.localeCompare(b));
    if (task == null && taskRecords) task = titles.find(title => /\b(run|running|jog)\b/i.test(title)) || '';
    if (task && !titles.includes(task)) titles.unshift(task);
    const values = ['', ...titles];
    if ([...ui.task.options].map(option => option.value).join('\0') !== values.join('\0')) {
      ui.task.replaceChildren(new Option('Any outdoor activity', ''), ...titles.map(title => new Option(title, title)));
    }
    ui.task.value = task || '';
  }

  function paintPlanner() {
    if (!dialog.open || !forecast) return;
    populateTasks();
    const now = Date.now() / 1000;
    const duration = Number(ui.duration.value);
    const timeZone = forecast.timezone;
    $('[data-planner-timezone]').textContent = timeZone.replaceAll('_', ' ').split('/').at(-1) + ' local time';
    const days = planOutdoorTime(forecast, { now, duration, title: task, records: taskRecords, taskTimeZone })
      .filter(day => day.key >= dateKey(now));
    const day = days.find(day => day.key === selectedDay) || days.find(day => day.windows.length) || days[0];
    const previousFocus = ui.week.contains(document.activeElement);
    const scroll = ui.week.scrollLeft;
    ui.week.replaceChildren(...days.map(day => {
      const tile = element('button', null, 'weather-date');
      tile.type = 'button';
      tile.dataset.day = day.key;
      const name = day.key === dateKey(now) ? 'Today' : weekdayFormat.format(day.time * 1000);
      const best = day.windows[0];
      tile.append(element('strong', name), element('span', monthDayFormat.format(day.time * 1000), 'weather-range'),
        weatherIcon(day.code, true),
        element('span', degrees(day.low) + ' / ' + degrees(day.high), 'weather-range'),
        element('span', best ? timeFormat.format(best.start * 1000) : day.reason === 'Task complete' ? 'Done' : '—', best ? 'weather-time-chip' : 'weather-range'));
      const forecastLabel = describeWeather(day.code)[0] + ' · ' + percent(day.rain) + ' peak chance of precipitation';
      tile.title = forecastLabel;
      tile.setAttribute('aria-description', forecastLabel);
      return tile;
    }));
    const picked = [...ui.week.children].find(tile => tile.dataset.day === day?.key);
    [...ui.week.children].forEach(tile => tile.setAttribute('aria-pressed', String(tile === picked)));
    ui.week.scrollLeft = scroll;
    if (previousFocus) picked?.focus({ preventScroll: true });
    ui.window.replaceChildren();
    if (!day) {
      ui.window.append(element('p', 'Waiting for the next forecast.'));
      return;
    }
    const date = day.key === dateKey(now) ? 'Today' : dateFormat.format(day.time * 1000);
    const best = day.windows[0];
    if (task && (taskPending && !taskRecords || taskError)) {
      ui.window.append(element('p', taskError ? 'Could not load the task schedule.' : 'Checking your task schedule…'));
      if (taskError) {
        const retry = element('button', 'Retry', 'weather-button');
        retry.type = 'button';
        retry.addEventListener('click', () => refreshTasks(true));
        ui.window.append(retry);
      }
      return;
    }
    const rainOutlook = Number.isFinite(day.rain) ? ' · ' + day.rain + '% peak precipitation chance' : '';
    if (!best) {
      ui.window.append(element('strong', date), element('p', day.reason + rainOutlook));
      return;
    }
    const label = best.sun >= .35 ? 'Sunny window' : 'Dry window';
    const span = window => timeFormat.format(window.start * 1000) + ' – ' + timeFormat.format(window.end * 1000);
    const low = degrees(best.low), high = degrees(best.high);
    const feels = (low === high ? high : low + '–' + high) + 'F';
    const primary = element('div', null, 'weather-best');
    primary.append(element('span', label + ' · ' + date, 'weather-window-label'),
      element('strong', span(best), 'weather-window-time'),
      element('p', percent(best.rain) + ' precipitation chance · Feels like ' + feels + ' · Gusts ' + Math.round(best.gust / 1.609344) + ' mph'));
    if (task) {
      const link = element('button', 'Open tasks', 'weather-button');
      link.type = 'button';
      link.addEventListener('click', () => { dialog.close(); openDay(best.date); });
      primary.append(link);
    }
    ui.window.append(primary);
    if (day.windows.length > 1) {
      const other = element('p', 'Also looks dry · ' + day.windows.slice(1).map(span).join('  ·  '), 'weather-alternates');
      ui.window.append(other);
    } else if (day.rain > 30) {
      ui.window.append(element('p', 'The day peaks at a ' + percent(day.rain) + ' chance of precipitation.', 'weather-alternates'));
    }
  }

  function refreshTasks(force = false, observed) {
    if (!dialog.open || !place) return Promise.resolve(false);
    if (observed && taskReadVersions && ['records', 'definitions'].every(scope => observed[scope] === taskReadVersions[scope])) {
      if (taskJob) return taskJob;
      if (taskRecords && !taskError) return Promise.resolve(true);
    }
    if (!force && taskJob) return taskJob;
    const ticket = ++taskVersion;
    const now = Date.now() / 1000;
    const start = appDay(now);
    const end = appDay(now + 8 * 86400); // Covers seven forecast days even across time zones and a clock change.
    taskReadVersions = window.StellarSync?.revisions;
    taskPending = true; taskError = false;
    taskJob = loadTaskDays(start, end, force).then(days => {
      if (ticket !== taskVersion) return false;
      taskRecords = days;
      return true;
    }).catch(() => {
      if (ticket === taskVersion) taskError = true;
      return false;
    }).finally(() => {
      if (ticket !== taskVersion) return;
      taskJob = null; taskPending = false;
      paintPlanner();
    });
    return taskJob;
  }

  function refreshForecast(force = false) {
    if (!place || document.hidden || !dialog.open && !themed) return Promise.resolve(false);
    if (forecastJob) return forecastJob;
    if (!force && Date.now() - forecastAt < FORECAST_TTL) return Promise.resolve(true);
    const ticket = placeVersion;
    lastTry = Date.now();
    paintStatus(forecast ? 'Updating forecast…' : 'Loading forecast…');
    forecastJob = requestWeatherForecast(place, force).then(data => {
      if (ticket !== placeVersion) return false;
      acceptForecast(data, Date.now());
      paintStatus();
      paintForecast();
      return true;
    }).catch(error => {
      if (ticket === placeVersion) {
        const message = error.name === 'AbortError' ? 'Weather took too long. Try again.' : error.message;
        paintStatus((forecast ? 'Showing the last available forecast. ' : '') + message, true);
      }
      return false;
    }).finally(() => { if (ticket === placeVersion) forecastJob = null; });
    return forecastJob;
  }

  function refreshWeather(force = false) {
    refreshTasks(force);
    return refreshForecast(force);
  }

  function selectPlace(city, remote = false) {
    if (forecast && place && pointKey(place) === pointKey(city)) {
      place = city;
      rememberPlace(place);
      ui.location.hidden = true;
      paintCities(); paintForecast(); refreshWeather();
      return;
    }
    place = city;
    placeVersion++; taskVersion++; citySearch++;
    forecast = null; forecastAt = 0; forecastJob = null;
    if (!remote) saveSetting('forecast', null);
    applyTheme();
    taskRecords = null; taskJob = null; taskReadVersions = null; selectedDay = null;
    taskPending = false; taskError = false;
    trigger.querySelector('[data-weather-temp]').hidden = true;
    if (!remote) rememberPlace(place);
    restoreForecast();
    ui.location.hidden = true;
    $('.weather-results').replaceChildren();
    $('.weather-search-note').textContent = '';
    $('#weather-city').value = '';
    paintCities();
    paintForecast();
    refreshWeather();
  }

  $('.weather-search').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('#weather-city').value.trim();
    if (name.length < 2) return;
    const ticket = ++citySearch;
    const status = $('.weather-search-note'), results = $('.weather-results');
    status.textContent = 'Searching…'; results.replaceChildren();
    try {
      const data = await getJSON('/api/weather/cities', { name });
      if (ticket !== citySearch) return;
      const cities = (data.results || []).filter(city => Number.isFinite(city.latitude) && Number.isFinite(city.longitude));
      status.textContent = cities.length ? '' : 'No matching cities. Try a nearby city or postal code.';
      cities.forEach(city => results.append(cityButton({
        name: city.name, detail: [city.admin1, city.country].filter(Boolean).join(', '),
        latitude: city.latitude, longitude: city.longitude,
      })));
    } catch (error) {
      if (ticket === citySearch) status.textContent = error.name === 'AbortError' ? 'City search took too long. Try again.' : error.message;
    }
  });

  $('.weather-close').addEventListener('click', () => dialog.close());
  ui.change.addEventListener('click', () => {
    ui.location.hidden = !ui.location.hidden;
    ui.change.setAttribute('aria-expanded', String(!ui.location.hidden));
    if (!ui.location.hidden) paintCities();
  });
  ui.retry.addEventListener('click', () => refreshWeather(true));
  ui.theme.addEventListener('change', () => {
    themed = ui.theme.checked;
    saveSetting('theme', themed);
    applyTheme();
    if (!forecast) paintForecast();
  });
  ui.task.addEventListener('change', () => {
    task = ui.task.value; selectedDay = null;
    saveSetting('task', task); paintPlanner();
  });
  ui.duration.addEventListener('change', () => {
    saveSetting('duration', ui.duration.value); paintPlanner();
  });
  ui.week.addEventListener('click', event => {
    const button = event.target.closest('[data-day]');
    if (!button) return;
    selectedDay = button.dataset.day;
    paintPlanner();
  });
  dialog.addEventListener('close', () => {
    syncMotion();
    trigger.focus({ preventScroll: true });
  });

  if (place) rememberPlace(place);
  paintCities();
  restoreForecast();
  if (themed) refreshForecast();
  window.StellarSync?.subscribe(['records', 'definitions'], observed => refreshTasks(true, observed));
  function tick() {
    syncMotion();
    if (!window.stellarPageActive() || !dialog.open && !themed) return;
    if (dialog.open) paintForecast();
    if (themed && forecast) applyTheme();
    if (Date.now() - lastTry > 60000 && Date.now() - forecastAt >= FORECAST_TTL) {
      refreshWeather();
    }
  }
  setInterval(tick, 60000);
  window.addEventListener('focus', tick);
  window.addEventListener('stellar:visibility', tick);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('storage', event => {
    if (event.key === PREFIX + 'place') {
      const city = savedCity(readSetting('place'));
      if (city && (!place || pointKey(city) !== pointKey(place))) selectPlace(city, true);
    }
    if (event.key === PREFIX + 'theme') {
      themed = readSetting('theme') === true;
      ui.theme.checked = themed;
      syncMotion();
    }
    if (event.key === PREFIX + 'forecast') restoreForecast();
    if (dialog.open) paintForecast();
  });
  window.addEventListener('pageshow', tick);
  window.addEventListener('pagehide', () => {
    dialog.dataset.weatherMotion = 'paused';
  });
  return {
    open() {
      if (!dialog.open) return;
      paintForecast();
      refreshWeather();
    },
  };
}
