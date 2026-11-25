/* Calendar permissions are chosen before OAuth. Read-only is the suggested
   default; upgrading requires a new authorization. Task planning is enabled by default and
   saved by task series, independently from historic completion settings. */
import { taskDurationSeconds } from './calendar-model.js?v=5';
import { assignTaskIcons, taskIcon, taskIconChoices } from './task-icons.js?v=1';

const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, cache: 'no-store', priority: 'low', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Check the time window and weather limits, then try again.');
  return data;
}
function announce(scope) {
  try { localStorage.setItem('stellar:calendar:' + scope, Date.now() + ':' + Math.random()); } catch {}
  window.dispatchEvent(new Event('stellar:calendar:' + scope));
}
const clock = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const minutes = text => { const [h, m] = text.split(':').map(Number); return h * 60 + m; };
function field(label, input) { const wrapper = node('label', label, 'cal-setting-field'); input.setAttribute('aria-label', label); wrapper.append(input); return wrapper; }
function input(type, value, name) { const el = node('input'); el.type = type; el.name = name; el.value = value; return el; }
function choice(label, checked, name, help) {
  const wrapper = node('label', null, 'cal-setting-choice'), control = input('checkbox', '', name); control.checked = checked;
  const copy = node('span'); copy.append(node('strong', label)); if (help) copy.append(node('small', help)); wrapper.append(control, copy); return wrapper;
}

function iconPicker(task, tasks) {
  const picker = node('details', null, 'cal-icon-picker');
  const summary = node('summary');
  const preview = node('span', null, 'cal-icon-preview');
  summary.append(node('span', 'Calendar icon'), preview);
  picker.append(summary);
  const options = node('div', null, 'cal-icon-options');
  options.setAttribute('role', 'radiogroup');
  options.setAttribute('aria-label', 'Calendar icon');
  const selected = taskIconChoices.has(task.rule.icon) ? task.rule.icon : '';
  const automatic = assignTaskIcons(tasks.map(row => row === task ? { ...task, rule: { ...task.rule, icon: null } } : row)).get(String(task.series_id));
  function updatePreview(key) {
    const label = key ? taskIconChoices.get(key)[0] : 'Automatic';
    preview.replaceChildren(taskIcon(key ? { key } : automatic), node('span', label));
  }
  for (const [key, [label]] of [['', ['Automatic']], ...taskIconChoices]) {
    const option = node('label', null, key ? 'cal-icon-option' : 'cal-icon-option is-automatic');
    option.title = label;
    const radio = input('radio', key, 'icon');
    radio.setAttribute('aria-label', label);
    radio.checked = key === selected;
    radio.onchange = () => updatePreview(key);
    const face = node('span');
    face.append(taskIcon(key ? { key } : automatic));
    if (!key) face.append(node('span', label));
    option.append(radio, face);
    options.append(option);
  }
  updatePreview(selected);
  picker.append(options);
  return picker;
}

export function mountConnections(button, changed = () => {}) {
  let model, wizard = null;
  const dialog = node('dialog', null, 'cal-dialog calendar-settings-dialog'); dialog.setAttribute('aria-labelledby', 'cal-connections-title');
  const header = node('header'), heading = node('h2', 'Connected calendars'); heading.id = 'cal-connections-title';
  const close = node('button', '×', 'cal-button cal-icon-button'); close.type = 'button'; close.setAttribute('aria-label', 'Close calendar connections'); close.onclick = () => dialog.close();
  header.append(heading, close);
  const content = node('div', null, 'cal-settings-content'), feedback = node('p', '', 'cal-settings-feedback'); feedback.setAttribute('role', 'status');
  dialog.append(header, content, feedback); document.body.append(dialog);
  async function load() {
    feedback.textContent = 'Loading calendar connections…';
    try { model = await api('/api/calendar/connections'); feedback.textContent = ''; render(); }
    catch (error) { feedback.textContent = error.message; }
  }
  async function save(row, form) {
    const button = form.querySelector('button[type=submit]'); button.disabled = true;
    try {
      await api('/api/calendar/connections/' + row.id, 'PUT', { selected_ids: [...form.querySelectorAll('[name=calendar]:checked')].map(el => el.value),
        allow_writes: form.allow_writes.checked, write_calendar_id: form.destination.value || null });
      announce('connections-changed'); changed(); await load(); feedback.textContent = 'Calendar preferences saved.';
    } catch (error) { feedback.textContent = error.message; }
    finally { button.disabled = false; }
  }
  function authorize(provider, row = null) {
    wizard = { provider, row }; content.replaceChildren();
    const back = node('button', '← Connections', 'cal-link'); back.type = 'button'; back.onclick = () => { wizard = null; render(); };
    const title = node('h3', 'Connect ' + provider.label);
    const toggle = choice('Allow edits from Stellar', row?.mode === 'write', 'allow_writes');
    const control = toggle.querySelector('input'); control.setAttribute('role', 'switch');
    const suggestion = node('p', 'Suggested: read-only access', 'cal-setting-suggestion');
    const summary = node('p', '', 'cal-setting-summary');
    const submit = node('button', 'Continue with ' + provider.label, 'cal-button cal-primary'); submit.type = 'button'; submit.disabled = !provider.ready;
    const explain = () => { summary.textContent = control.checked ? 'Two-way sync: Stellar can create, edit and remove events in the writable calendars you select. Changes will also appear in ' + provider.label + '.' :
      'Read-only sync: selected calendars appear here and block conflicting task suggestions. Stellar cannot change their events.'; suggestion.hidden = control.checked; };
    control.onchange = explain; explain();
    submit.onclick = async () => {
      submit.disabled = true; feedback.textContent = 'Preparing authorization…';
      try {
        const result = await api('/api/calendar/connect/' + provider.id, 'POST', { allow_writes: control.checked, connection_id: row?.id || null });
        top.location.assign(result.url);
      } catch (error) { feedback.textContent = error.message; submit.disabled = !provider.ready; }
    };
    content.append(back, title, toggle, suggestion, summary, node('p', 'After authorization, choose which calendars to show. New events have an explicit calendar destination.', 'cal-setting-summary'));
    if (!provider.ready) content.append(node('p', 'Account connections for this provider haven’t been enabled by the app owner yet.', 'cal-setting-summary'));
    content.append(submit); feedback.textContent = '';
  }
  function render() {
    if (wizard) return authorize(wizard.provider, wizard.row);
    content.replaceChildren();
    const intro = node('p', 'Bring your calendars together. Choose read-only or two-way access before signing in.', 'cal-setting-summary'); content.append(intro);
    const providers = node('div', null, 'cal-provider-buttons');
    for (const provider of model.providers || []) {
      const button = node('button', '+ ' + provider.label, 'cal-button'); button.type = 'button'; button.onclick = () => authorize(provider); providers.append(button);
    }
    content.append(providers);
    for (const row of model.connections || []) {
      const form = node('form', null, 'cal-connection-card');
      const label = row.provider === 'google' ? 'Google Calendar' : row.provider === 'outlook' ? 'Outlook' : 'Calendar subscription';
      form.append(node('h3', label), node('p', row.mode === 'write' ? 'Two-way sync authorized' : 'Read-only sync', 'cal-setting-suggestion'));
      for (const calendar of row.calendars) { const label = choice(calendar.label, row.selected_ids.includes(calendar.id), 'calendar'); label.querySelector('input').value = calendar.id; form.append(label); }
      const toggle = choice('Allow edits from Stellar', row.mode === 'write', 'allow_writes');
      const control = toggle.querySelector('input'); control.setAttribute('role', 'switch'); control.disabled = row.provider === 'ics';
      control.onchange = () => {
        if (control.checked && row.mode !== 'write') {
          const provider = model.providers.find(p => p.id === row.provider); return authorize(provider, row);
        }
        form.destination.disabled = !control.checked;
        if (!control.checked) form.destination.value = '';
      };
      const select = node('select'); select.name = 'destination'; select.append(new Option('Stellar only until I choose a destination', ''));
      for (const calendar of row.calendars.filter(c => c.can_write)) select.append(new Option(calendar.label, calendar.id));
      select.value = row.write_calendar_id || ''; select.disabled = row.mode !== 'write';
      form.append(toggle, field('Suggested destination for new events', select));
      const footer = node('footer'), remove = node('button', 'Disconnect', 'cal-link cal-danger'); remove.type = 'button';
      remove.onclick = async () => { remove.disabled = true; try { await api('/api/calendar/connections/' + row.id, 'DELETE'); announce('connections-changed'); changed(); await load(); }
        catch (error) { feedback.textContent = error.message; remove.disabled = false; } };
      const submit = node('button', 'Save preferences', 'cal-button'); submit.type = 'submit'; footer.append(remove, submit); form.append(footer);
      form.onsubmit = event => { event.preventDefault(); save(row, form); }; content.append(form);
    }
    const details = node('details', null, 'cal-connection-card'); details.append(node('summary', 'Other calendars · subscription link'));
    const form = node('form');
    const name = input('text', '', 'label'); name.required = true; name.maxLength = 100; name.placeholder = 'Calendar name';
    const url = input('url', '', 'url'); url.required = true; url.maxLength = 4096; url.placeholder = 'https://…/calendar.ics'; url.autocomplete = 'off';
    const submit = node('button', 'Subscribe', 'cal-button'); submit.type = 'submit';
    form.append(node('p', 'Calendar subscriptions are read-only. Changes refresh when Calendar is open. Your private link stays on the server.', 'cal-setting-summary'), field('Name', name), field('Calendar subscription URL', url), submit);
    form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; feedback.textContent = 'Checking subscription…';
      try { await api('/api/calendar/feeds', 'POST', { label: name.value, url: url.value }); announce('connections-changed'); changed(); await load(); }
      catch (error) { feedback.textContent = error.message; } finally { submit.disabled = false; } };
    details.append(form); content.append(details);
  }
  function open() { wizard = null; dialog.showModal(); load(); }
  button?.addEventListener('click', open);
  return { open, dialog };
}

function mountPlanningEditor(host) {
  const dialog = node('dialog', null, 'cal-dialog calendar-settings-dialog');
  dialog.setAttribute('aria-labelledby', 'task-planning-title');
  const header = node('header');
  const title = node('h2', 'Task planning');
  title.id = 'task-planning-title';
  const close = node('button', '×', 'cal-button cal-icon-button');
  close.setAttribute('aria-label', 'Close task planning');
  close.onclick = () => dialog.close();
  header.append(title, close);
  const content = node('div', null, 'cal-settings-content');
  dialog.append(header, content);
  document.body.append(dialog);

  function showForm(task, defaults, tasks) {
    const rule = task.rule;
    const saved = Boolean(task.updated_at);
    const form = node('form', null, 'task-planning-form');
    form.append(iconPicker(task, tasks), choice('Suggest times for this task', rule.enabled, 'enabled'));
    const fields = node('div', null, 'cal-form-row');
    function number(label, name, min, max, display = value => value) {
      const control = input('number', saved ? display(rule[name]) : '', name);
      control.placeholder = String(display(defaults[name]));
      control.min = min;
      control.max = max;
      return field(label, control);
    }
    const duration = node('div', null, 'cal-duration');
    const durationInput = input('number', '', 'duration');
    const unit = node('select');
    unit.name = 'duration_unit';
    unit.append(new Option('Minutes', 'minutes'), new Option('Seconds', 'seconds'));
    unit.value = rule.duration_seconds == null ? 'minutes' : 'seconds';
    const storedSeconds = taskDurationSeconds(rule);
    const setDurationBounds = () => {
      durationInput.min = 1;
      durationInput.max = unit.value === 'seconds' ? 28800 : 480;
      const fallback = taskDurationSeconds(defaults);
      durationInput.placeholder = String(unit.value === 'seconds' ? fallback : Math.ceil(fallback / 60));
    };
    if (saved) durationInput.value = unit.value === 'seconds' ? storedSeconds : storedSeconds / 60;
    unit.onchange = setDurationBounds;
    setDurationBounds();
    duration.append(field('Duration', durationInput), field('Duration unit', unit));
    function timeField(label, name) {
      const control = input('time', saved ? clock(rule[name]) : '', name);
      const wrapper = field(label, control);
      wrapper.classList.add('planning-time');
      const hour = Math.floor(defaults[name] / 60) % 24;
      const minute = String(defaults[name] % 60).padStart(2, '0');
      const hint = node('span', `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`, 'planning-time-example');
      hint.id = 'planning-default-' + name;
      control.setAttribute('aria-describedby', hint.id);
      const syncPlaceholder = () => { control.toggleAttribute('data-empty', !control.value); };
      control.addEventListener('input', syncPlaceholder);
      syncPlaceholder();
      const entry = node('span', null, 'planning-time-entry');
      entry.append(control, hint);
      wrapper.append(entry);
      return wrapper;
    }
    fields.append(duration, timeField('Earliest start', 'earliest'), timeField('Finish by', 'latest'));
    form.append(fields);

    const weather = node('select');
    weather.name = 'weather';
    weather.append(new Option('Any weather', 'any'), new Option('Dry', 'dry'), new Option('Sunny and dry', 'sunny'));
    weather.value = rule.weather;
    form.append(field('Weather', weather));
    const advanced = node('details', null, 'cal-connection-card');
    advanced.append(node('summary', 'Daylight, weather limits and buffer'));
    const options = node('div', null, 'planning-options');
    options.append(choice('Daylight only', rule.daylight_only, 'daylight_only'));
    const limits = node('div', null, 'cal-weather-limits');
    const fahrenheit = value => Math.round(value * 9 / 5 + 32);
    limits.append(number('Minimum feels-like °F', 'min_temperature_c', -40, 122, fahrenheit),
      number('Maximum feels-like °F', 'max_temperature_c', -40, 122, fahrenheit),
      number('Max rain chance %', 'max_rain_percent', 0, 100),
      number('Max gusts mph', 'max_wind_kph', 0, 74, value => Math.round(value / 1.609344)));
    weather.onchange = () => { limits.hidden = weather.value === 'any'; };
    weather.onchange();
    options.append(limits, number('Free time before and after (minutes)', 'buffer_minutes', 0, 120));
    advanced.append(options);
    form.append(advanced);
    const submit = node('button', 'Save planning settings', 'cal-button cal-primary');
    submit.type = 'submit';
    const status = node('p', '', 'cal-settings-feedback');
    status.setAttribute('role', 'status');
    form.append(submit, status);
    form.onsubmit = async event => {
      event.preventDefault();
      const controls = form.elements;
      const get = (key, parse = Number) => controls[key].value === '' ? defaults[key] : parse(controls[key].value);
      const celsius = value => (Number(value) - 32) * 5 / 9;
      const body = {
        enabled: controls.enabled.checked,
        icon: controls.icon.value || null,
        duration_minutes: unit.value === 'minutes' ? Number(durationInput.value || durationInput.placeholder) : defaults.duration_minutes,
        duration_seconds: unit.value === 'seconds' ? Number(durationInput.value || durationInput.placeholder) : null,
        earliest: get('earliest', minutes),
        latest: get('latest', minutes),
        weather: weather.value,
        daylight_only: controls.daylight_only.checked,
        min_temperature_c: get('min_temperature_c', celsius),
        max_temperature_c: get('max_temperature_c', celsius),
        max_rain_percent: get('max_rain_percent'),
        max_wind_kph: get('max_wind_kph', value => Math.round(Number(value) * 1.609344)),
        buffer_minutes: get('buffer_minutes'),
      };
      submit.disabled = true;
      try {
        await api('/api/calendar/task-planning/' + task.series_id, 'PUT', body);
        announce('planning-changed');
        status.textContent = 'Planning settings saved.';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    };
    content.replaceChildren(form);
  }

  let latestRequest = 0;
  host.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-plan-task]');
    if (!trigger) return;
    const request = ++latestRequest;
    title.textContent = trigger.getAttribute('aria-label');
    content.textContent = 'Loading planning settings…';
    dialog.showModal();
    try {
      const data = await api('/api/calendar/task-planning');
      const task = data.tasks.find(item => String(item.series_id) === trigger.dataset.planTask);
      if (!task) throw new Error('This task is no longer available.');
      const defaults = data.defaults || task.rule;
      if (dialog.open && request === latestRequest) showForm(task, defaults, data.tasks);
    } catch (error) {
      if (request === latestRequest) content.textContent = error.message;
    }
  });
}

if (document.body.dataset.page === 'tasks') {
  mountPlanningEditor(document.getElementById('live'));
  mountConnections(document.getElementById('settings-calendar-connections'));
}
