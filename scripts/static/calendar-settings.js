/* Calendar permissions are chosen before OAuth. Read-only is the suggested
   default; upgrading requires a new authorization. Task planning is opt-in and
   stored by task series, independently from historic completion settings. */
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

export async function mountPlanning(host) {
  const feedback = node('p', 'Loading task planning…', 'cal-settings-feedback'); feedback.setAttribute('role', 'status'); host.append(feedback);
  try {
    const data = await api('/api/calendar/task-planning');
    host.replaceChildren(node('p', 'Opt in per task. Suggestions must fit its duration, allowed hours, deadline and calendar availability.', 'cal-setting-summary'));
    for (const task of data.tasks) {
      const details = node('details', null, 'cal-planning-task'), summary = node('summary');
      summary.append(node('strong', task.title), node('span', task.rule.enabled ? task.rule.duration_minutes + ' min · planning on' : 'Planning off', 'cal-setting-suggestion')); details.append(summary);
      const form = node('form'); const rule = task.rule;
      form.append(choice('Suggest times for this task', rule.enabled, 'enabled'));
      const duration = input('number', rule.duration_minutes, 'duration_minutes'); duration.min = 5; duration.max = 480; duration.required = true;
      const earliest = input('time', clock(rule.earliest), 'earliest'); earliest.required = true;
      const latest = input('time', clock(rule.latest), 'latest'); latest.required = true;
      const hours = node('div', null, 'cal-form-row'); hours.append(field('Minutes needed', duration), field('Earliest start', earliest), field('Finish by', latest)); form.append(hours);
      form.append(node('p', 'A finish time before the start means overnight. Task deadlines still apply.', 'cal-setting-summary'));
      const weather = node('select'); weather.name = 'weather'; weather.append(new Option('Any weather · indoor tasks', 'any'), new Option('Dry conditions', 'dry'), new Option('Sunshine and dry conditions', 'sunny')); weather.value = rule.weather;
      form.append(field('Weather requirement', weather), choice('Daylight only', rule.daylight_only, 'daylight_only'));
      const limits = node('div', null, 'cal-weather-limits');
      const min = input('number', Math.round(rule.min_temperature_c * 9 / 5 + 32), 'min_f'); min.min = -40; min.max = 122;
      const max = input('number', Math.round(rule.max_temperature_c * 9 / 5 + 32), 'max_f'); max.min = -40; max.max = 122;
      const rain = input('number', rule.max_rain_percent, 'max_rain_percent'); rain.min = 0; rain.max = 100;
      const wind = input('number', Math.round(rule.max_wind_kph / 1.609344), 'wind_mph'); wind.min = 0; wind.max = 74;
      limits.append(field('Minimum feels-like °F', min), field('Maximum feels-like °F', max), field('Max rain chance %', rain), field('Max gusts mph', wind)); form.append(limits);
      weather.onchange = () => { limits.hidden = weather.value === 'any'; limits.querySelectorAll('input').forEach(el => { el.disabled = limits.hidden; }); }; weather.onchange();
      const buffer = input('number', rule.buffer_minutes, 'buffer_minutes'); buffer.min = 0; buffer.max = 120;
      form.append(field('Minutes free before and after', buffer));
      const submit = node('button', 'Save scheduling settings', 'cal-button'); submit.type = 'submit'; const status = node('p', '', 'cal-settings-feedback'); status.setAttribute('role', 'status'); form.append(submit, status);
      form.onsubmit = async event => { event.preventDefault(); submit.disabled = true;
        const body = { ...rule, enabled: form.enabled.checked, duration_minutes: +duration.value, earliest: minutes(earliest.value), latest: minutes(latest.value), weather: weather.value,
          daylight_only: form.daylight_only.checked, min_temperature_c: (+min.value - 32) * 5 / 9, max_temperature_c: (+max.value - 32) * 5 / 9,
          max_rain_percent: +rain.value, max_wind_kph: Math.round(+wind.value * 1.609344), buffer_minutes: +buffer.value };
        try { await api('/api/calendar/task-planning/' + task.series_id, 'PUT', body); announce('planning-changed'); summary.lastChild.textContent = body.enabled ? body.duration_minutes + ' min · planning on' : 'Planning off'; status.textContent = 'Scheduling settings saved.'; }
        catch (error) { status.textContent = error.message; } finally { submit.disabled = false; }
      };
      details.append(form); host.append(details);
    }
    if (!data.tasks.length) host.append(node('p', 'Add a task above to configure its scheduling settings.', 'cal-setting-summary'));
  } catch (error) { feedback.textContent = error.message; }
}

if (document.body.dataset.page === 'tasks') {
  mountPlanning(document.getElementById('task-planning-settings'));
  mountConnections(document.getElementById('settings-calendar-connections'));
}
