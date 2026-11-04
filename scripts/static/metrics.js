/* Tabs come from saved task records, not a hardcoded list. Module selection and
   chart controls live locally; record changes are refreshed from the server. */
(() => {
  const tabs = document.getElementById('metric-tabs');
  if (!tabs) return;
  const frame = document.getElementById('metric-frame');
  const status = document.getElementById('metric-status');
  const retry = document.getElementById('metric-retry');
  let modules = [], revision = null, busy = false, checked = 0, queued = false, initialized = false;
  let selected = new URLSearchParams(location.search).get('tab');
  try { selected ||= localStorage.getItem('stellar:metric-tab'); } catch {}
  const urlFor = module => {
    if (module.kind === 'weight' || module.kind === 'wake') return '/' + module.kind + '?embedded=true';
    return '/consistency?embedded=true' + (module.kind === 'task'
      ? '&task=' + encodeURIComponent(module.label) + '&titles=' + encodeURIComponent(JSON.stringify(module.titles)) : '');
  };
  const select = (id, refresh = false, userAction = true) => {
    const module = modules.find(m => m.id === id) || modules[0];
    if (!module) return;
    const remember = userAction || !initialized || selected !== module.id;
    selected = module.id;
    if (remember) {
      try { localStorage.setItem('stellar:metric-tab', selected); } catch {}
      const url = '/metrics?tab=' + encodeURIComponent(selected);
      if (location.pathname + location.search !== url) history.replaceState(history.state, '', url);
    }
    initialized = true;
    tabs.querySelectorAll('button').forEach(button => {
      const active = button.dataset.metric === selected;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    const active = [...tabs.children].find(b => b.dataset.metric === selected);
    document.getElementById('metric-panel').setAttribute('aria-labelledby', active.id);
    const url = urlFor(module);
    if (refresh || frame.dataset.url !== url) {
      frame.style.height = '180px'; frame.dataset.url = url;
      frame.contentWindow.location.replace(url);
    }
    frame.title = module.label + ' metrics';
    if (active.offsetLeft < tabs.scrollLeft || active.offsetLeft + active.offsetWidth > tabs.scrollLeft + tabs.clientWidth) {
      tabs.scrollLeft = Math.max(0, active.offsetLeft - tabs.offsetLeft);
    }
  };
  const load = async (force = false) => {
    if (busy) { queued ||= force; return; }
    if (!force && Date.now() - checked < 15000) return;
    busy = true;
    try {
      const response = await fetch('/api/metrics', { cache: 'no-store' });
      if (!response.ok) throw Error('Could not load metrics');
      const data = await response.json();
      const changed = JSON.stringify(modules) !== JSON.stringify(data.modules);
      const refresh = revision !== null && revision !== data.revision;
      modules = data.modules;
      revision = data.revision;
      if (changed) {
        tabs.replaceChildren(...modules.map((module, i) => {
          const button = document.createElement('button');
          button.type = 'button'; button.id = 'metric-tab-' + i; button.dataset.metric = module.id;
          button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'metric-panel');
          button.textContent = module.label;
          return button;
        }));
      }
      select(selected, refresh, false);
      status.textContent = ''; retry.hidden = true;
      checked = Date.now();
    } catch {
      status.textContent = 'Could not refresh your metrics. Check your connection and retry.';
      retry.hidden = false;
    } finally { busy = false; if (queued) { queued = false; load(true); } }
  };
  tabs.addEventListener('click', event => { const button = event.target.closest('[data-metric]'); if (button) select(button.dataset.metric); });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = modules.findIndex(m => m.id === selected);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? modules.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + modules.length) % modules.length;
    select(modules[next].id);
    tabs.querySelector('[aria-selected=true]').focus();
  });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'stellar:metric-height') return;
    const url = new URL(frame.dataset.url, location.origin);
    if (event.data.url !== url.pathname + url.search) return;
    const height = Number(event.data.height);
    if (Number.isFinite(height) && height > 0 && height < 30000) frame.style.height = Math.ceil(height) + 'px';
  });
  retry.addEventListener('click', () => load(true));
  window.addEventListener('focus', () => load());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  window.addEventListener('stellar:records-changed', () => load(true));
  window.addEventListener('storage', event => { if (event.key === 'stellar:records-changed') load(true); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  load(true);
})();
