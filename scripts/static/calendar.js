/* Calendar events load independently of weather and task records. Only a fully
   read busy schedule can produce suggestions. Private events stay in memory;
   saved view, running hours and weather location are ordinary preferences.
   Visibility-aware refreshes retain the page and never replace an open editor.
   Booking uses stable IDs, server versions and database conflict checks.
*/
import { notifyWeather, requestWeatherForecast } from './weather-background.js?v=1';
import { dayKeyFor, describeWeather, readForecast } from './weather-model.js?v=4';
import { eventLayout, interval, localParts, overlaps, runSuggestions, shiftDay, weekStart, zonedTime } from './calendar-model.js?v=1';

const boot = JSON.parse(document.getElementById('calendar-boot').textContent);
const $ = selector => document.querySelector(selector);
const app = $('.calendar-app'), tz = boot.tz;
const dateKey = dayKeyFor(tz);
const today = () => dateKey(Date.now() / 1000);
const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} if (key.startsWith('stellar:weather:')) notifyWeather(); };
const element = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
const dayFormat = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric' });
const shortDay = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short' });
const periodFormat = new Intl.DateTimeFormat(undefined, { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
const timeLabel = seconds => timeFormat.format(seconds * 1000);
const dayLabel = day => dayFormat.format(zonedTime(day, 12 * 60, tz) * 1000);
const validDay = value => { try { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value; } catch { return false; } };
const minutes = text => { const [hours, mins] = text.split(':').map(Number); return hours * 60 + mins; };
const clock = value => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
const pref = read('stellar:calendar:hours') || {};
let selectedDay = validDay(boot.day) ? boot.day : today();
let view = ['day', 'week'].includes(boot.view) ? boot.view : read('stellar:calendar:view') || (matchMedia('(max-width: 760px)').matches ? 'day' : 'week');
if (!['day', 'week'].includes(view)) view = 'week';
let events = [], records = {}, forecast = null, forecastAt = 0, plans = [], eventsReady = false, recordsReady = false;
let eventsError = '', recordsError = '', weatherError = '', weatherPending = false, mutating = false;
let eventSeq = 0, recordSeq = 0, eventJob, recordJob, forecastJob, citySeq = 0, locationSeq = 0, eventTag = '', eventKey = '';
let editingEvent = null, booking = null, creatorId = null, selectedTask = 'Run', lastPlanTime = 0;
const cityValid = value => value && typeof value.name === 'string' && value.name.trim() && Number.isFinite(value.latitude) && Number.isFinite(value.longitude) &&
  Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180;
let place = read('stellar:weather:place');
if (!cityValid(place)) place = null;
const pointKey = city => [city.latitude, city.longitude].join(',');
const defaults = [{ name: 'Fremont', detail: 'California, United States', latitude: 37.54827, longitude: -121.98857 },
  { name: 'Los Angeles', detail: 'California, United States', latitude: 34.05223, longitude: -118.24368 }];
const span = () => { const first = view === 'week' ? weekStart(selectedDay) : selectedDay; return Array.from({ length: view === 'week' ? 7 : 1 }, (_, i) => shiftDay(first, i)); };
const active = () => !document.hidden && window.stellarPageActive?.() !== false;
const editing = () => !!document.querySelector('.cal-dialog[open]');

async function request(url, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    if (response.status === 304) return { response, data: null };
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not save or load the calendar. Try again.');
    return { response, data };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('This is taking too long. Try again.');
    throw error;
  } finally { clearTimeout(timer); }
}

function status() {
  const node = $('#cal-status'); node.replaceChildren();
  const problem = eventsError || recordsError;
  if (problem) {
    node.append(document.createTextNode(problem + ' '));
    const retry = element('button', 'Try again', 'cal-link');
    retry.addEventListener('click', () => { loadEvents(true); loadRecords(true); }); node.append(retry);
  } else if (!eventsReady) node.textContent = 'Loading your calendar…';
  const cityLabel = place?.name || 'Choose city';
  if ($('#cal-location').textContent !== cityLabel) $('#cal-location').textContent = cityLabel;
  $('#cal-weather-retry').disabled = weatherPending || !place;
  $('#cal-weather-status').textContent = weatherError || (weatherPending ? (forecast ? 'Updating forecast…' : 'Finding weather windows…') :
    !place ? 'Choose your weather location to find running slots.' : !forecast ? 'Forecast unavailable. Try refreshing.' :
    !eventsReady || !recordsReady ? 'Reading your schedule before suggesting times…' :
    `${plans.reduce((sum, day) => sum + day.slots.length, 0)} slots fit your schedule and forecast`);
}

function calculate() {
  const days = span();
  const taskNames = [...new Set(Object.values(records).flatMap(rows => rows.map(row => row.title)))];
  selectedTask = taskNames.find(title => /^run$/i.test(title)) || taskNames.find(title => /\b(run|running|jog)\b/i.test(title)) || 'Run';
  const form = $('#cal-preferences');
  if (forecast && eventsReady && recordsReady && Date.now() - forecastAt < 45 * 60000) {
    plans = runSuggestions(forecast, { days, events, records, taskTitle: selectedTask, timeZone: tz, now: Date.now() / 1000,
      earliest: minutes(form.earliest.value), latest: minutes(form.latest.value), buffer: +form.buffer.value });
  } else plans = days.map(day => ({ day, slots: [], reason: !place ? 'Choose a weather location' : !eventsReady ? 'Calendar unavailable' :
    !recordsReady ? 'Task records unavailable' : 'Forecast unavailable' }));
  lastPlanTime = Date.now();
}

function isDone(event) { return event.kind === 'run' && records[dateKey(interval(event).start)]?.some(row => row.title === (event.task_title || 'Run') && row.is_completed); }
function conflicted(event) { return event.kind === 'run' && events.some(other => other.id !== event.id && overlaps(interval(event), interval(other))); }

function eventButton(event) {
  const button = element('button', null, 'cal-event'); button.type = 'button';
  button.dataset.kind = event.kind; button.dataset.event = event.id;
  if (isDone(event)) button.classList.add('is-complete');
  if (conflicted(event)) button.classList.add('is-conflicted');
  button.append(element('strong', (event.kind === 'run' ? '✦ ' : '') + event.title));
  if (!event.all_day) button.append(element('small', `${timeLabel(interval(event).start)} – ${timeLabel(interval(event).end)}`));
  button.title = event.title + (event.all_day ? ' · All day' : ` · ${timeLabel(interval(event).start)} – ${timeLabel(interval(event).end)}`) +
    (conflicted(event) ? ' · Conflicts with another event' : isDone(event) ? ' · Run recorded' : '');
  button.addEventListener('click', () => openEditor(event));
  return button;
}

function render() {
  calculate(); status();
  const days = span(), heads = $('#cal-day-heads'), grid = $('#cal-grid'), outlook = $('#cal-outlook');
  app.dataset.view = view; app.style.setProperty('--cal-days', days.length);
  $('#cal-date').value = selectedDay;
  $('#cal-period').textContent = view === 'day' ? dayLabel(selectedDay) :
    periodFormat.formatRange(new Date(zonedTime(days[0], 720, tz) * 1000), new Date(zonedTime(days.at(-1), 720, tz) * 1000));
  document.querySelectorAll('[data-cal-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.calView === view)));
  heads.replaceChildren(element('div')); grid.replaceChildren(); outlook.replaceChildren();
  const hours = element('div', null, 'cal-hours');
  for (let hour = 1; hour < 24; hour++) { const label = element('span', hour % 12 || 12, 'cal-hour'); label.style.top = hour * 76 + 'px'; hours.append(label); }
  grid.append(hours);
  const mobileAllDay = $('#cal-mobile-all-day'); mobileAllDay.replaceChildren();
  for (const day of days) {
    const noon = zonedTime(day, 720, tz), first = zonedTime(day, 0, tz), last = zonedTime(shiftDay(day, 1), 0, tz);
    const head = element('div', null, 'cal-day-head'), dayButton = element('button', null, 'cal-select-day');
    dayButton.type = 'button'; dayButton.setAttribute('aria-label', dayLabel(day)); dayButton.setAttribute('aria-pressed', String(day === selectedDay));
    head.dataset.selected = String(day === selectedDay);
    head.classList.toggle('is-today', day === today());
    dayButton.append(document.createTextNode(shortDay.format(noon * 1000)), element('strong', +day.slice(-2)));
    if (forecast) {
      const weatherDay = forecast.days.find(row => row.key === dayKeyFor(forecast.timezone)(noon));
      if (weatherDay) dayButton.append(element('small', `${describeWeather(weatherDay.code)[1]} ${Math.round(weatherDay.high * 9 / 5 + 32)}°`, 'cal-day-weather'));
    }
    const allDay = element('div', null, 'cal-all-day');
    events.filter(event => event.all_day && overlaps(interval(event), { start: first, end: last })).forEach(event => {
      const button = eventButton(event); button.addEventListener('click', e => e.stopPropagation()); allDay.append(button);
      if (day === selectedDay) mobileAllDay.append(eventButton(event));
    });
    head.append(dayButton, allDay);
    dayButton.addEventListener('click', () => { selectedDay = day; remember(); render(); });
    heads.append(head);
    const column = element('div', null, 'cal-day-column'); column.dataset.day = day;
    column.classList.toggle('is-today', day === today()); column.classList.toggle('is-selected', day === selectedDay);
    const suggestionEvents = (plans.find(plan => plan.day === day)?.slots || []).map(slot => ({ id: 'suggestion-' + slot.start,
      starts_at: new Date(slot.start * 1000).toISOString(), ends_at: new Date(slot.end * 1000).toISOString(), slot }));
    const positioned = eventLayout([...events.filter(event => !event.all_day), ...suggestionEvents], day, tz);
    for (const item of positioned) {
      let button;
      if (item.slot) {
        button = element('button', null, 'cal-event is-suggestion'); button.dataset.slot = item.slot.start;
        button.append(element('strong', `✧ ${timeLabel(item.slot.start)} · Run`));
        button.setAttribute('aria-label', `${dayLabel(day)}, ${timeLabel(item.slot.start)}, suggested 10-minute run${item.slot.rank === 1 ? ', best match' : ''}`);
        button.title = `10-minute run · ${item.slot.rain}% precipitation chance · ${Math.round(item.slot.gust / 1.609344)} mph gusts`;
        button.addEventListener('click', () => openRun(item.slot));
      } else button = eventButton(item);
      button.style.top = item.top + 'px'; button.style.height = item.height + 'px';
      button.style.left = `calc(${item.column / item.columns * 100}% + 3px)`;
      button.style.width = `calc(${100 / item.columns}% - 6px)`;
      button.classList.toggle('is-compact', item.height < 42); column.append(button);
    }
    column.addEventListener('dblclick', e => { if (e.target === column) openEditor(null, day, Math.floor(e.offsetY / 76 * 60 / 5) * 5); });
    grid.append(column);
    const plan = plans.find(row => row.day === day), card = element('article', null, 'cal-outlook-day');
    card.append(element('strong', dayLabel(day)));
    if (!plan.slots.length) card.append(element('p', plan.reason));
    plan.slots.forEach(slot => {
      const button = element('button', null, 'cal-slot-link'); button.type = 'button';
      button.append(element('span', timeLabel(slot.start)), element('small', slot.rank === 1 ? 'Best match ✧' : `${slot.rain}% rain`));
      button.addEventListener('click', () => openRun(slot)); card.append(button);
    });
    outlook.append(card);
  }
  paintNow();
}

function paintNow() {
  document.querySelectorAll('.cal-now').forEach(line => line.remove());
  const now = localParts(Date.now() / 1000, tz);
  const column = document.querySelector(`.cal-day-column[data-day="${now.day}"]`);
  if (column) { const line = element('div', null, 'cal-now'); line.style.top = now.minutes / 60 * 76 + 'px'; column.append(line); }
}

function remember() {
  save('stellar:calendar:view', view);
  history.replaceState(null, '', '/calendar?' + new URLSearchParams({ day: selectedDay, view }));
}

function navigate(day = selectedDay, nextView = view) {
  selectedDay = day; view = nextView; eventsReady = recordsReady = false; eventTag = ''; remember(); render(); loadEvents(); loadRecords();
}

async function loadEvents(force = false) {
  if (!active() || !force && (editing() || mutating)) return false;
  const days = span(), key = days[0] + ':' + days.at(-1);
  if (eventJob?.key === key) return eventJob.promise;
  const ticket = ++eventSeq;
  const promise = request('/api/calendar/events?' + new URLSearchParams({ start: days[0], end: days.at(-1) }), {
    headers: eventKey === key && eventTag ? { 'If-None-Match': eventTag } : {},
  }).then(({ data, response }) => {
    if (ticket !== eventSeq) return false;
    if (data && !Array.isArray(data.events)) throw new Error('Calendar data could not load. Try again.');
    const signature = rows => rows.map(row => row.id + ':' + row.updated_at).sort().join('|');
    const changed = !eventsReady || data && signature(events) !== signature(data.events);
    eventsReady = true; eventsError = ''; eventKey = key; eventTag = response.headers.get('ETag') || eventTag;
    if (data) events = data.events;
    if (changed && !editing()) render(); else status();
    return true;
  }).catch(error => { if (ticket === eventSeq) { eventsReady = false; eventsError = error.message; if (!editing()) render(); } return false; })
    .finally(() => { if (ticket === eventSeq) eventJob = null; });
  eventJob = { key, promise }; return promise;
}

async function loadRecords(force = false) {
  if (!active() || !force && (editing() || mutating)) return false;
  const days = span(), key = days[0] + ':' + days.at(-1);
  if (recordJob?.key === key) return recordJob.promise;
  const ticket = ++recordSeq;
  const promise = request('/api/range?' + new URLSearchParams({ start: days[0], end: days.at(-1) })).then(({ data }) => {
    if (ticket !== recordSeq) return false;
    if (!data.days || typeof data.days !== 'object' || Array.isArray(data.days)) throw new Error('Task records could not load.');
    const changed = !recordsReady || JSON.stringify(records) !== JSON.stringify(data.days);
    records = data.days; recordsReady = true; recordsError = '';
    if (changed && !editing()) render(); else status(); return true;
  }).catch(error => { if (ticket === recordSeq) { recordsReady = false; recordsError = 'Task records could not load. Running suggestions are paused.'; if (!editing()) render(); } return false; })
    .finally(() => { if (ticket === recordSeq) recordJob = null; });
  recordJob = { key, promise }; return promise;
}

function restoreForecast() {
  const cached = read('stellar:weather:forecast');
  if (place && cached?.key === pointKey(place) && cached.at > forecastAt && Date.now() - cached.at < 45 * 60000) {
    try { forecast = readForecast(cached.data); forecastAt = cached.at; return true; } catch {}
  }
  return false;
}

async function loadForecast(force = false) {
  if (!place || !active()) return;
  if (forecastJob) return forecastJob;
  if (!force && Date.now() - forecastAt < 15 * 60000) return;
  const ticket = locationSeq, city = place;
  weatherPending = true; weatherError = ''; status();
  const promise = requestWeatherForecast(city, force).then(data => {
    if (ticket !== locationSeq) return;
    forecast = readForecast(data); forecastAt = Date.now();
  }).catch(error => { if (ticket === locationSeq) weatherError = (forecast ? 'Last available forecast. ' : '') + error.message; })
    .finally(() => { if (ticket === locationSeq) { weatherPending = false; forecastJob = null; if (!editing()) render(); else status(); } });
  forecastJob = promise; return promise;
}

function cities() {
  const container = $('#cal-saved-cities'); container.replaceChildren();
  const saved = read('stellar:weather:recent');
  const seen = new Set();
  for (const city of [...(Array.isArray(saved) ? saved : []).filter(cityValid), ...defaults]) {
    if (seen.has(pointKey(city))) continue; seen.add(pointKey(city)); container.append(cityButton(city));
  }
}

function cityButton(city) {
  const button = element('button', city.name, 'cal-button'); button.type = 'button';
  if (city.detail) button.append(element('small', city.detail));
  button.addEventListener('click', () => {
    const changed = !place || pointKey(place) !== pointKey(city);
    place = city; save('stellar:weather:place', city);
    const recents = read('stellar:weather:recent');
    save('stellar:weather:recent', [city, ...(Array.isArray(recents) ? recents : []).filter(cityValid).filter(row => pointKey(row) !== pointKey(city))].slice(0, 6));
    if (changed) { locationSeq++; forecast = null; forecastAt = 0; forecastJob = null; weatherError = ''; }
    $('#cal-cities').close(); loadForecast();
  }); return button;
}

function openEditor(event = null, day = selectedDay, start = null) {
  if (mutating) return;
  const dialog = $('#cal-editor'), form = $('#cal-event-form');
  editingEvent = event; creatorId = event?.id || crypto.randomUUID(); form.reset();
  const local = event ? localParts(interval(event).start, tz) : { day, minutes: start ?? 9 * 60 };
  form.elements.title.value = event?.title || ''; form.day.value = local.day; form.time.value = clock(local.minutes);
  form.duration.value = event ? Math.round((interval(event).end - interval(event).start) / 60) : 60;
  form.notes.value = event?.notes || ''; form.kind.value = event?.kind || 'event'; form.all_day.checked = event?.all_day || false;
  form.all_day.disabled = form.kind.value === 'run';
  $('#cal-editor-title').textContent = event ? 'Edit event' : 'New event'; $('#cal-delete').hidden = !event;
  $('#cal-event-time').hidden = form.all_day.checked;
  dialog.querySelector('.cal-form-error').textContent = event && conflicted(event) ? 'This run overlaps another event. Move it to a free time.' : '';
  dialog.showModal(); form.elements.title.focus();
}

function openRun(slot) {
  if (mutating) return;
  booking = slot; creatorId = crypto.randomUUID();
  $('#cal-run-time').textContent = `${dayLabel(slot.day)} · ${timeLabel(slot.start)}–${timeLabel(slot.end)}`;
  $('#cal-run-weather').textContent = `${slot.rain}% precipitation chance · feels like ${Math.round(slot.feels * 9 / 5 + 32)}°F · gusts ${Math.round(slot.gust / 1.609344)} mph`;
  $('#cal-run .cal-form-error').textContent = ''; $('#cal-run').showModal();
}

async function writeEvent(body, dialog, method = 'POST') {
  if (mutating) return;
  mutating = true;
  dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const url = method === 'PUT' ? '/api/calendar/events/' + editingEvent.id : '/api/calendar/events';
    const { data } = await request(url, { method, body: JSON.stringify(body) });
    events = [...events.filter(event => event.id !== data.id), data]; eventTag = ''; eventSeq++; eventJob = null;
    save('stellar:calendar:changed', Date.now() + ':' + crypto.randomUUID());
    dialog.close();
  } catch (error) { dialog.querySelector('.cal-form-error').textContent = error.message; loadEvents(true); }
  finally { mutating = false; dialog.querySelectorAll('button').forEach(button => { button.disabled = false; }); if (!dialog.open) render(); }
}

$('#cal-event-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget, day = form.day.value;
  const start = zonedTime(day, form.all_day.checked ? 0 : minutes(form.time.value), tz);
  const end = form.all_day.checked ? zonedTime(shiftDay(day, 1), 0, tz) : start + +form.duration.value * 60;
  if (start == null || end == null) { $('#cal-editor .cal-form-error').textContent = 'That local time does not exist because the clocks change. Choose another time.'; return; }
  writeEvent({ id: creatorId, title: form.elements.title.value, notes: form.notes.value, starts_at: new Date(start * 1000).toISOString(),
    ends_at: new Date(end * 1000).toISOString(), all_day: form.all_day.checked, kind: form.kind.value,
    task_title: form.kind.value === 'run' ? editingEvent?.task_title || selectedTask : null, version: editingEvent?.updated_at },
  $('#cal-editor'), editingEvent ? 'PUT' : 'POST');
});
$('#cal-event-form').all_day.addEventListener('change', event => { $('#cal-event-time').hidden = event.target.checked; });
$('#cal-event-form').kind.addEventListener('change', event => {
  const form = $('#cal-event-form'), run = event.target.value === 'run';
  form.all_day.disabled = run;
  if (run) { form.all_day.checked = false; form.duration.value = 10; $('#cal-event-time').hidden = false; }
});
$('#cal-book-run').addEventListener('click', () => {
  if (!booking || Date.now() / 1000 >= booking.start) { $('#cal-run .cal-form-error').textContent = 'This slot has passed. Choose another suggestion.'; return; }
  if (!eventsReady || !recordsReady || Date.now() - forecastAt >= 45 * 60000) { $('#cal-run .cal-form-error').textContent = 'Refresh the calendar and forecast before reserving this slot.'; return; }
  if (records[booking.day]?.some(row => row.title === booking.taskTitle && row.is_completed)) { $('#cal-run .cal-form-error').textContent = 'This run is already recorded. No reservation is needed.'; return; }
  writeEvent({ id: creatorId, title: 'Run', notes: '', starts_at: new Date(booking.start * 1000).toISOString(), ends_at: new Date(booking.end * 1000).toISOString(),
    all_day: false, kind: 'run', task_title: booking.taskTitle }, $('#cal-run'));
});
$('#cal-delete').addEventListener('click', async () => {
  if (mutating || !editingEvent) return;
  const button = $('#cal-delete'); button.disabled = true; mutating = true;
  try {
    await request('/api/calendar/events/' + editingEvent.id + '?' + new URLSearchParams({ version: editingEvent.updated_at }), { method: 'DELETE' });
    events = events.filter(event => event.id !== editingEvent.id); eventTag = ''; eventSeq++; eventJob = null;
    save('stellar:calendar:changed', Date.now() + ':' + crypto.randomUUID()); $('#cal-editor').close();
  } catch (error) { $('#cal-editor .cal-form-error').textContent = error.message; loadEvents(true); }
  finally { mutating = false; button.disabled = false; if (!$('#cal-editor').open) render(); }
});

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $('#' + button.dataset.close).close()));
document.querySelectorAll('.cal-dialog').forEach(dialog => dialog.addEventListener('close', () => { if (!mutating) render(); }));
$('#cal-add').addEventListener('click', () => openEditor());
$('#cal-date').addEventListener('change', event => { if (validDay(event.target.value)) navigate(event.target.value); });
$('#cal-prev').addEventListener('click', () => navigate(shiftDay(selectedDay, view === 'week' ? -7 : -1)));
$('#cal-next').addEventListener('click', () => navigate(shiftDay(selectedDay, view === 'week' ? 7 : 1)));
$('#cal-today').addEventListener('click', () => navigate(today()));
document.querySelectorAll('[data-cal-view]').forEach(button => button.addEventListener('click', () => navigate(selectedDay, button.dataset.calView)));
$('#cal-options').addEventListener('click', () => { $('#cal-preferences').hidden = !$('#cal-preferences').hidden; });
$('#cal-preferences').earliest.value = clock(Number.isInteger(pref.earliest) && pref.earliest >= 0 && pref.earliest < 1440 ? pref.earliest : 420);
$('#cal-preferences').latest.value = clock(Number.isInteger(pref.latest) && pref.latest > 0 && pref.latest < 1440 ? pref.latest : 1260);
$('#cal-preferences').buffer.value = [0, 5, 10, 15].includes(pref.buffer) ? String(pref.buffer) : '0';
$('#cal-preferences').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  if (minutes(form.latest.value) <= minutes(form.earliest.value)) { form.latest.setCustomValidity('Choose an end time after the start.'); form.latest.reportValidity(); return; }
  form.latest.setCustomValidity(''); save('stellar:calendar:hours', { earliest: minutes(form.earliest.value), latest: minutes(form.latest.value), buffer: +form.buffer.value }); form.hidden = true; render();
});
$('#cal-preferences').latest.addEventListener('input', event => event.target.setCustomValidity(''));
$('#cal-location').addEventListener('click', () => { cities(); $('#cal-cities').showModal(); });
$('#cal-weather-retry').addEventListener('click', () => loadForecast(true));
$('#cal-city-search').addEventListener('submit', async event => {
  event.preventDefault(); const ticket = ++citySeq, query = event.currentTarget.city.value.trim();
  $('#cal-city-status').textContent = 'Searching…'; $('#cal-city-results').replaceChildren();
  try {
    const { data } = await request('/api/weather/cities?' + new URLSearchParams({ name: query }));
    if (ticket !== citySeq) return;
    const results = (data.results || []).map(city => ({ name: city.name, latitude: city.latitude, longitude: city.longitude,
      detail: [city.admin1, city.country].filter(Boolean).join(', ') })).filter(cityValid);
    $('#cal-city-status').textContent = results.length ? '' : 'No matching cities. Try a nearby city.';
    $('#cal-city-results').append(...results.map(cityButton));
  } catch (error) { if (ticket === citySeq) $('#cal-city-status').textContent = error.message; }
});
window.addEventListener('storage', event => {
  if (event.key === 'stellar:calendar:changed') loadEvents();
  if (event.key === 'stellar:weather:place') {
    const city = read(event.key);
    if (cityValid(city) && (!place || pointKey(city) !== pointKey(place))) { place = city; locationSeq++; forecast = null; forecastAt = 0; forecastJob = null; restoreForecast(); render(); loadForecast(); }
  }
  if (event.key === 'stellar:weather:forecast') { restoreForecast(); if (active() && !editing()) render(); }
});
function resume() {
  if (!active()) return;
  const changed = restoreForecast();
  loadEvents(); loadForecast(); if (!window.StellarSync?.managed) loadRecords();
  if (!editing() && (changed || Date.now() - lastPlanTime > 5 * 60000)) render(); else paintNow();
}
window.addEventListener('focus', resume); window.addEventListener('pageshow', resume); window.addEventListener('stellar:visibility', resume);
document.addEventListener('visibilitychange', () => { if (active()) resume(); });
window.StellarSync?.subscribe(['records', 'definitions'], () => loadRecords());
setInterval(() => { if (active()) { loadEvents(); if (Date.now() - lastPlanTime > 5 * 60000 && !editing()) { render(); loadForecast(); } else paintNow(); } }, 30000);
$('#cal-timezone').textContent = tz.replaceAll('_', ' ');
document.querySelectorAll('[data-calendar-timezone]').forEach(node => { node.textContent = tz.replaceAll('_', ' '); });
restoreForecast(); remember(); render(); loadEvents(); loadRecords(); loadForecast();
requestAnimationFrame(() => { $('#cal-scroll').scrollTop = (selectedDay === today() ? Math.max(6, localParts(Date.now() / 1000, tz).minutes / 60 - 1) : 7) * 76; });
