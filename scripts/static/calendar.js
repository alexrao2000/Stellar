/* Calendar events load independently of weather and task records. Only a fully
   read busy schedule can produce suggestions. Private events stay in memory;
   saved view, running hours and weather location are ordinary preferences.
   Visibility-aware refreshes retain the page and never replace an open editor.
   Booking uses stable IDs, server versions and database conflict checks.
*/
import { mountConnections } from './calendar-settings.js?v=6';
import { notifyWeather, requestWeatherForecast } from './weather-background.js?v=2';
import { dayKeyFor, describeWeather, readForecast } from './weather-model.js?v=4';
import { durationLabel, eventLayout, interval, localParts, overlaps, taskDurationSeconds, taskSuggestions, shiftDay, weekStart, zonedTime } from './calendar-model.js?v=5';
import { assignTaskIcons, taskIcon } from './task-icons.js?v=1';

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
const timeWithSeconds = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' });
const timeLabel = seconds => timeFormat.format(seconds * 1000);
function timeRange(start, end) {
  const formatter = start % 60 || end % 60 ? timeWithSeconds : timeFormat;
  return formatter.format(start * 1000) + ' – ' + formatter.format(end * 1000);
}

function setEditorDuration(form, seconds) {
  form.duration_unit.value = seconds % 60 ? 'seconds' : 'minutes';
  updateDurationLimit(form);
  form.duration.value = form.duration_unit.value === 'seconds' ? seconds : seconds / 60;
}

function updateDurationLimit(form) {
  form.duration.max = form.duration_unit.value === 'seconds' ? 86400 : 1440;
}
const dayLabel = day => dayFormat.format(zonedTime(day, 12 * 60, tz) * 1000);
const validDay = value => { try { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value; } catch { return false; } };
const minutes = text => { const [hours, mins] = text.split(':').map(Number); return hours * 60 + mins; };
const clock = value => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
const connectionResult = new URLSearchParams(location.search).get('connection');
let selectedDay = validDay(boot.day) ? boot.day : today();
let view = ['day', 'week'].includes(boot.view) ? boot.view : read('stellar:calendar:view') || (matchMedia('(max-width: 760px)').matches ? 'day' : 'week');
if (!['day', 'week'].includes(view)) view = 'week';
let events = [], records = {}, forecast = null, forecastAt = 0, plans = [], eventsReady = false, recordsReady = false;
let eventsError = '', recordsError = '', weatherError = '', weatherPending = false, mutating = false;
let eventSeq = 0, recordSeq = 0, eventJob, recordJob, forecastJob, citySeq = 0, locationSeq = 0, eventTag = '', eventKey = '';
let editingEvent = null, booking = null, creatorId = null, lastPlanTime = 0;
let localEvents = [], externalEvents = [], externalReady = false, planningReady = false, allTasks = [], plannedTasks = [], connections = [];
let externalError = '', planningError = '', externalJob, planningJob, externalSeq = 0, externalChecked = 0, externalKey = '', planningChecked = 0;
let selectedTaskId = read('stellar:calendar:planned-task') || '';
const plannedTask = () => plannedTasks.find(task => String(task.series_id) === String(selectedTaskId));
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
  const problem = eventsError || recordsError || externalError || planningError;
  if (problem) {
    node.append(document.createTextNode(problem + ' '));
    const retry = element('button', 'Try again', 'cal-link');
    retry.addEventListener('click', () => { loadEvents(true); loadRecords(true); loadPlanning(true); }); node.append(retry);
  } else if (!eventsReady) node.textContent = 'Loading your calendar…';
  const cityLabel = place?.name || 'Choose city';
  if ($('#cal-location').textContent !== cityLabel) $('#cal-location').textContent = cityLabel;
  $('#cal-weather-retry').disabled = weatherPending || !place;
  const task = plannedTask(), needsWeather = task && (task.rule.weather !== 'any' || task.rule.daylight_only);
  $('#cal-weather-status').textContent = !planningReady ? 'Loading task planning settings…' : !task ? 'No tasks are available for planning.' :
    !eventsReady || !externalReady || !recordsReady ? 'Checking all calendars and task records…' : needsWeather && (!forecast || weatherError) ?
    weatherError || (!place ? 'Choose a weather location for this task.' : 'Loading the forecast required for this task…') :
    `${plans.reduce((sum, day) => sum + day.slots.length, 0)} slots fit this task and your calendars`;

}

function calculate() {
  const days = span(), task = plannedTask();
  const needsWeather = task && (task.rule.weather !== 'any' || task.rule.daylight_only);
  const weather = forecast && Date.now() - forecastAt < 45 * 60000 ? forecast : null;
  if (task && eventsReady && externalReady && planningReady && recordsReady && (!needsWeather || weather)) {
    plans = taskSuggestions(weather, { task, days, events, records, timeZone: tz, now: Date.now() / 1000 });
  } else plans = days.map(day => ({ day, slots: [], reason: !planningReady ? 'Task settings unavailable' : !task ? 'No tasks available for planning' :
    !eventsReady || !externalReady ? 'Waiting for all connected calendars' : !recordsReady ? 'Task records unavailable' : 'Weather forecast required for this task' }));
  lastPlanTime = Date.now();
}

function isDone(event) { return ['run', 'task'].includes(event.kind) && records[dateKey(interval(event).start)]?.some(row => row.title === (event.task_title || 'Run') && row.is_completed); }
function conflicted(event) { return ['run', 'task'].includes(event.kind) && events.some(other => other.id !== event.id && other.blocks_time !== false && overlaps(interval(event), interval(other))); }

function eventButton(event) {
  const button = element('button', null, 'cal-event'); button.type = 'button';
  button.dataset.kind = event.kind; if (event.source) button.dataset.source = event.source; button.dataset.event = event.id;
  const done = isDone(event), conflict = conflicted(event);
  if (done) button.classList.add('is-complete');
  if (conflict) button.classList.add('is-conflicted');
  button.append(element('strong', (['run', 'task'].includes(event.kind) ? '✦ ' : '') + event.title));
  const time = event.all_day ? 'All day' : timeRange(interval(event).start, interval(event).end);
  if (!event.all_day && event.anchor == null) button.append(element('small', time));
  button.title = `${event.title} · ${time}` + (conflict ? ' · Conflicts with another event' : done ? ' · Task recorded' : '');
  if (event.anchor != null) button.setAttribute('aria-label', button.title);
  button.addEventListener('click', () => openEditor(event));
  return button;
}

function taskCallout(button, item, icon) {
  const bubble = element('div', null, 'cal-callout');
  bubble.style.top = `${item.top}px`;
  bubble.style.height = `${item.height}px`;
  button.classList.add('is-callout');
  button.removeAttribute('title');
  const name = element('span', item.slot?.taskTitle || item.title, 'cal-callout-name');
  name.setAttribute('aria-hidden', 'true');
  button.replaceChildren(taskIcon(icon), name);
  const reset = () => button.removeAttribute('data-label-dismissed');
  button.addEventListener('pointerleave', reset);
  button.addEventListener('blur', reset);

  const offset = item.anchor - item.top;
  const port = item.height / 2 + 2;
  const leaderTop = Math.min(offset, port) - 4;
  const leaderHeight = Math.abs(offset - port) + 8;
  const anchor = offset - leaderTop;
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const leader = document.createElementNS(svgNamespace, 'svg');
  leader.setAttribute('class', 'cal-callout-leader');
  leader.setAttribute('viewBox', `0 0 32 ${leaderHeight}`);
  leader.setAttribute('height', leaderHeight);
  leader.setAttribute('aria-hidden', 'true');
  leader.style.top = `${leaderTop}px`;
  const line = document.createElementNS(svgNamespace, 'path');
  line.setAttribute('d', `M3 ${port - leaderTop} L28 ${anchor}`);
  const dot = document.createElementNS(svgNamespace, 'circle');
  dot.setAttribute('cx', 28);
  dot.setAttribute('cy', anchor);
  dot.setAttribute('r', 1.8);
  leader.append(line, dot);
  bubble.append(button, leader);
  return bubble;
}

function render() {
  calculate(); status();
  const titleToSeries = new Map(allTasks.flatMap(task => task.titles.map(title => [title, task.series_id])));
  const seriesFor = item => item.slot?.taskSeriesId ?? item.task_series_id ?? titleToSeries.get(item.task_title || item.title) ?? `event:${item.task_title || item.title}`;
  const known = new Set(allTasks.map(task => String(task.series_id)));
  const otherSeries = new Set(events.filter(item => item.kind === 'task' || item.kind === 'run').map(seriesFor).map(String).filter(id => !known.has(id)));
  const icons = assignTaskIcons([...allTasks, ...[...otherSeries].map(id => ({ series_id: `legacy:${id}` }))]);
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
        const label = item.anchor == null ? `${timeLabel(item.slot.start)} · ${item.slot.taskTitle}` : item.slot.taskTitle;
        button.append(element('strong', `✧ ${label}`));
        button.setAttribute('aria-label', `${dayLabel(day)}, ${timeLabel(item.slot.start)}, suggested ${item.slot.taskTitle}, ${durationLabel(item.slot.end - item.slot.start)}${item.slot.rank === 1 ? ', best match' : ''}`);
        button.title = slotDescription(item.slot);
        button.addEventListener('click', () => openRun(item.slot));
      } else button = eventButton(item);
      if (item.anchor != null) {
        const series = String(seriesFor(item));
        column.append(taskCallout(button, item, icons.get(known.has(series) ? series : `legacy:${series}`)));
        continue;
      }
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
      button.append(element('span', timeLabel(slot.start)), element('small', slot.rank === 1 ? 'Best match ✧' : slot.rain == null ? 'Free slot' : `${slot.rain}% rain`));
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
  selectedDay = day; view = nextView; eventsReady = recordsReady = externalReady = false; eventTag = ''; remember(); render(); loadEvents(); loadRecords();
}

async function loadEvents(force = false) {
  loadExternal(force);
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
    const changed = !eventsReady || data && signature(localEvents) !== signature(data.events);
    eventsReady = true; eventsError = ''; eventKey = key; eventTag = response.headers.get('ETag') || eventTag;
    if (data) localEvents = data.events;
    events = [...localEvents, ...externalEvents];
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
  editingEvent = event; creatorId = event && !event.source ? event.id : crypto.randomUUID(); form.reset();
  const local = event ? localParts(interval(event).start, tz) : { day, minutes: start ?? 9 * 60 };
  form.elements.title.value = event?.title || ''; form.day.value = local.day; form.time.value = clock(local.minutes);
  setEditorDuration(form, event ? Math.round(interval(event).end - interval(event).start) : 3600);
  form.notes.value = event?.notes || ''; form.kind.value = event && ['task', 'run'].includes(event.kind) ? 'task' : 'event'; form.all_day.checked = event?.all_day || false;
  form.all_day.disabled = form.kind.value === 'task';
  populateDestinations(form.destination, event); populateTaskChoice(event);
  form.querySelectorAll('input,textarea,select,button[type=submit]').forEach(el => { el.disabled = !!event?.read_only; });
  form.destination.disabled = !!event;
  form.all_day.disabled = !!event?.read_only || form.kind.value === 'task';
  form.querySelector('button[type=submit]').hidden = !!event?.read_only;
  $('#cal-editor-title').textContent = event?.read_only ? 'Calendar event · read only' : event ? 'Edit event' : 'New event'; $('#cal-delete').hidden = !event || event.read_only;
  $('#cal-event-source').textContent = event?.source ? `${event.calendar_label} · ${event.recurring ? 'This occurrence only. ' : ''}${event.has_guests ? 'Edits may notify invited guests.' : ''}` : 'Choose where this event is saved.';
  $('#cal-event-time').hidden = form.all_day.checked;
  dialog.querySelector('.cal-form-error').textContent = event && conflicted(event) ? 'This task overlaps another event. Move it to a free time.' : '';
  dialog.showModal(); form.elements.title.focus();
}

function openRun(slot) {
  if (mutating) return;
  booking = slot; creatorId = crypto.randomUUID();
  $('#cal-run-time').textContent = `${dayLabel(slot.day)} · ${timeRange(slot.start, slot.end)}`;
  $('#cal-run h2').textContent = slot.taskTitle;
  $('#cal-book-run').textContent = 'Schedule ' + slot.taskTitle;
  $('#cal-run-weather').textContent = slotDescription(slot);
  populateDestinations($('#cal-run-destination'));
  $('#cal-run .cal-form-error').textContent = ''; $('#cal-run').showModal();
}

async function writeEvent(body, dialog, method = 'POST') {
  if (mutating) return;
  mutating = true;
  dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const destination = dialog.id === 'cal-run' ? $('#cal-run-destination').value : $('#cal-event-destination').value;
    const external = method === 'PUT' ? !!editingEvent.source : destination !== 'local';
    if (external) {
      const [connection_id, calendar_id] = method === 'PUT' ? [editingEvent.connection_id, editingEvent.calendar_id] : JSON.parse(destination);
      body = { ...body, connection_id, calendar_id, remote_version: editingEvent?.updated_at, version: null };
    }
    const url = external ? '/api/calendar/external-events' + (method === 'PUT' ? '/' + encodeURIComponent(editingEvent.id) : '') :
      method === 'PUT' ? '/api/calendar/events/' + editingEvent.id : '/api/calendar/events';
    const { data } = await request(url, { method, body: JSON.stringify(body) });
    if (external) externalEvents = [...externalEvents.filter(event => event.id !== data.id), data];
    else localEvents = [...localEvents.filter(event => event.id !== data.id), data];
    events = [...localEvents, ...externalEvents]; eventTag = ''; eventSeq++; eventJob = null;
    save('stellar:calendar:changed', Date.now() + ':' + crypto.randomUUID());
    dialog.close();
  } catch (error) { dialog.querySelector('.cal-form-error').textContent = error.message; loadEvents(true); }
  finally { mutating = false; dialog.querySelectorAll('button').forEach(button => { button.disabled = false; }); if (!dialog.open) render(); }
}

$('#cal-event-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget, day = form.day.value;
  let start = zonedTime(day, form.all_day.checked ? 0 : minutes(form.time.value), tz);
  if (editingEvent && !form.all_day.checked && !editingEvent.all_day) {
    const originalStart = interval(editingEvent).start;
    const original = localParts(originalStart, tz);
    if (day === original.day && form.time.value === clock(original.minutes)) start = originalStart;
  }
  const duration = Number(form.duration.value) * (form.duration_unit.value === 'seconds' ? 1 : 60);
  const end = form.all_day.checked ? zonedTime(shiftDay(day, 1), 0, tz) : start + duration;
  if (start == null || end == null) { $('#cal-editor .cal-form-error').textContent = 'That local time does not exist because the clocks change. Choose another time.'; return; }
  writeEvent({ id: creatorId, title: form.elements.title.value, notes: form.notes.value, starts_at: new Date(start * 1000).toISOString(),
    ends_at: new Date(end * 1000).toISOString(), all_day: form.all_day.checked, kind: form.kind.value,
    task_title: form.kind.value === 'task' ? plannedTasks.find(t => String(t.series_id) === form.planned_task.value)?.title || editingEvent?.task_title : null, task_series_id: form.kind.value === 'task' ? +form.planned_task.value || editingEvent?.task_series_id : null, version: editingEvent?.updated_at },
  $('#cal-editor'), editingEvent ? 'PUT' : 'POST');
});
$('#cal-event-form').all_day.addEventListener('change', event => { $('#cal-event-time').hidden = event.target.checked; });
$('#cal-event-form').kind.addEventListener('change', event => {
  const form = $('#cal-event-form'), run = event.target.value === 'task';
  $('#cal-event-task-label').hidden = !run;
  form.all_day.disabled = run;
  if (run) {
    const task = plannedTasks.find(t => String(t.series_id) === form.planned_task.value);
    form.all_day.checked = false;
    setEditorDuration(form, task ? taskDurationSeconds(task.rule) : 1800);
    $('#cal-event-time').hidden = false;
  }
});
$('#cal-book-run').addEventListener('click', () => {
  if (!booking || Date.now() / 1000 >= booking.start) { $('#cal-run .cal-form-error').textContent = 'This slot has passed. Choose another suggestion.'; return; }
  if (!eventsReady || !externalReady || !recordsReady || !planningReady || !plans.some(day => day.slots.some(slot => slot.start === booking.start && slot.end === booking.end && slot.taskSeriesId === booking.taskSeriesId))) { $('#cal-run .cal-form-error').textContent = 'Refresh the calendars and task settings before reserving this slot.'; return; }
  if (records[booking.day]?.some(row => row.title === booking.taskTitle && row.is_completed)) { $('#cal-run .cal-form-error').textContent = 'This run is already recorded. No reservation is needed.'; return; }
  writeEvent({ id: creatorId, title: booking.taskTitle, notes: '', starts_at: new Date(booking.start * 1000).toISOString(), ends_at: new Date(booking.end * 1000).toISOString(),
    all_day: false, kind: 'task', task_title: booking.taskTitle, task_series_id: booking.taskSeriesId }, $('#cal-run'));
});
$('#cal-delete').addEventListener('click', async () => {
  if (mutating || !editingEvent) return;
  const button = $('#cal-delete'); button.disabled = true; mutating = true;
  try {
    await request((editingEvent.source ? '/api/calendar/external-events/' : '/api/calendar/events/') + encodeURIComponent(editingEvent.id) + '?' + new URLSearchParams({ version: editingEvent.updated_at }), { method: 'DELETE' });
    localEvents = localEvents.filter(event => event.id !== editingEvent.id); externalEvents = externalEvents.filter(event => event.id !== editingEvent.id);
    events = [...localEvents, ...externalEvents]; eventTag = ''; eventSeq++; eventJob = null;
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
  if (['stellar:calendar:changed', 'stellar:calendar:connections-changed'].includes(event.key)) { externalChecked = 0; loadEvents(true); }
  if (event.key === 'stellar:calendar:planning-changed') { planningChecked = 0; loadPlanning(true); }
  if (event.key === 'stellar:weather:place') {
    const city = read(event.key);
    if (cityValid(city) && (!place || pointKey(city) !== pointKey(place))) { place = city; locationSeq++; forecast = null; forecastAt = 0; forecastJob = null; restoreForecast(); render(); loadForecast(); }
  }
  if (event.key === 'stellar:weather:forecast') { restoreForecast(); if (active() && !editing()) render(); }
});
function resume() {
  if (!active()) return;
  const changed = restoreForecast();
  loadEvents(); loadPlanning(); loadForecast(); if (!window.StellarSync?.managed) loadRecords();
  if (!editing() && (changed || Date.now() - lastPlanTime > 5 * 60000)) render(); else paintNow();
}
window.addEventListener('focus', resume); window.addEventListener('pageshow', resume); window.addEventListener('stellar:visibility', resume);
document.addEventListener('visibilitychange', () => { if (active()) resume(); });
window.StellarSync?.subscribe(['records', 'definitions'], () => loadRecords());
setInterval(() => { if (active()) { loadEvents(); loadPlanning(); if (Date.now() - lastPlanTime > 5 * 60000 && !editing()) { render(); loadForecast(); } else paintNow(); } }, 30000);
$('#cal-timezone').textContent = tz.replaceAll('_', ' ');
document.querySelectorAll('[data-calendar-timezone]').forEach(node => { node.textContent = tz.replaceAll('_', ' '); });
restoreForecast(); remember(); render(); loadEvents(); loadPlanning(); loadRecords(); loadForecast();
requestAnimationFrame(() => { $('#cal-scroll').scrollTop = (selectedDay === today() ? Math.max(6, localParts(Date.now() / 1000, tz).minutes / 60 - 1) : 7) * 76; });

function slotDescription(slot) {
  const duration = durationLabel(slot.end - slot.start);
  return slot.rain == null ? duration + ' · within allowed hours · no calendar conflicts' :
    `${duration} · ${slot.rain}% precipitation chance · feels like ${Math.round(slot.feels * 9 / 5 + 32)}°F · gusts ${Math.round(slot.gust / 1.609344)} mph`;
}
function populateTaskChoice(event) {
  const select = $('#cal-event-task'); select.replaceChildren(...plannedTasks.map(task => new Option(task.title, task.series_id)));
  if (event?.task_title && !plannedTasks.some(task => task.titles.includes(event.task_title))) select.append(new Option(event.task_title, event.task_series_id || ''));
  select.value = String(event?.task_series_id || selectedTaskId || plannedTasks[0]?.series_id || '');
  $('#cal-event-task-label').hidden = $('#cal-event-form').kind.value !== 'task';
}
function populateDestinations(select, event) {
  select.replaceChildren(new Option('Stellar', 'local'));
  for (const connection of connections.filter(c => c.mode === 'write')) for (const calendar of connection.calendars.filter(c => c.can_write && connection.selected_ids.includes(c.id))) {
    select.append(new Option(calendar.label + ' · ' + (connection.provider === 'google' ? 'Google' : 'Outlook'), JSON.stringify([connection.id, calendar.id])));
  }
  let selected = event?.source ? JSON.stringify([event.connection_id, event.calendar_id]) : read('stellar:calendar:destination') ||
    connections.filter(c => c.write_calendar_id).map(c => JSON.stringify([c.id, c.write_calendar_id]))[0] || 'local';
  if (event?.source && ![...select.options].some(o => o.value === selected)) select.append(new Option(event.calendar_label, selected));
  if (![...select.options].some(o => o.value === selected)) selected = 'local';
  select.value = selected;
}
async function loadExternal(force = false) {
  if (!active() || !force && editing()) return;
  const days = span(), key = days[0] + ':' + days.at(-1);
  if (externalJob?.key === key) return externalJob.promise;
  if (!force && externalKey === key && Date.now() - externalChecked < 60000) return;
  const ticket = ++externalSeq;
  const promise = request('/api/calendar/external-events?' + new URLSearchParams({ start: days[0], end: days.at(-1), fresh: String(force) }), { priority: 'low' })
    .then(({ data }) => {
      if (ticket !== externalSeq) return;
      if (!Array.isArray(data.events) || typeof data.complete !== 'boolean') throw new Error('Connected calendars could not load. Task suggestions are paused.');
      externalEvents = data.events; connections = data.connections || []; externalReady = data.complete;
      externalError = data.complete ? '' : 'A connected calendar could not sync. Task suggestions are paused until all calendars are available.';
      externalKey = key; externalChecked = Date.now(); events = [...localEvents, ...externalEvents];
      if (!editing()) render(); else status();
    }).catch(error => { if (ticket === externalSeq) { externalReady = false; externalError = error.message; if (!editing()) render(); else status(); } })
    .finally(() => { if (ticket === externalSeq) externalJob = null; });
  externalJob = { key, promise }; return promise;
}
async function loadPlanning(force = false) {
  if (!active() || !force && (editing() || Date.now() - planningChecked < 60000)) return;
  if (planningJob) return planningJob;
  planningJob = request('/api/calendar/task-planning', { priority: 'low' }).then(({ data }) => {
    if (!Array.isArray(data.tasks)) throw new Error('Task planning settings could not load.');
    allTasks = data.tasks;
    plannedTasks = allTasks.filter(task => task.rule.enabled);
    if (!plannedTask()) {
      const first = plannedTasks.find(task => task.updated_at && task.rule.weather !== 'any')
        || plannedTasks.find(task => task.updated_at) || plannedTasks[0];
      selectedTaskId = String(first?.series_id || '');
    }
    const select = $('#cal-plan-task'); select.replaceChildren(...(plannedTasks.length ? plannedTasks.map(task => new Option(task.title, task.series_id)) : [new Option('No tasks to plan', '')]));
    select.value = selectedTaskId; planningReady = true; planningError = ''; planningChecked = Date.now();
    if (!editing()) render(); else status();
  }).catch(error => { planningReady = false; planningError = error.message; if (!editing()) render(); else status(); }).finally(() => { planningJob = null; });
  return planningJob;
}
$('#cal-plan-task').addEventListener('change', event => { selectedTaskId = event.target.value; save('stellar:calendar:planned-task', selectedTaskId); render(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || editing()) return;
  document.querySelectorAll('.is-callout:is(:hover,:focus-visible)').forEach(button => button.setAttribute('data-label-dismissed', ''));
});
for (const select of [$('#cal-event-destination'), $('#cal-run-destination')]) select.addEventListener('change', () => save('stellar:calendar:destination', select.value));
$('#cal-event-form').duration_unit.addEventListener('change', event => updateDurationLimit(event.target.form));
$('#cal-event-task').addEventListener('change', event => {
  const task = plannedTasks.find(t => String(t.series_id) === event.target.value);
  if (task) setEditorDuration($('#cal-event-form'), taskDurationSeconds(task.rule));
});
const connectionPanel = mountConnections($('#cal-connections'), () => { externalChecked = 0; loadExternal(true); });
connectionPanel.dialog.addEventListener('close', () => { if (!mutating) render(); });
if (connectionResult) { connectionPanel.open(); if (connectionResult !== 'connected') $('#cal-status').textContent = 'Calendar authorization was cancelled or could not finish. Try connecting again.'; }
window.addEventListener('stellar:calendar:planning-changed', () => loadPlanning(true));
window.addEventListener('stellar:calendar:connections-changed', () => loadExternal(true));
