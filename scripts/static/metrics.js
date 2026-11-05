/* The selected chart loads before catalog discovery and idle prefetches. All
   task charts share one in-memory history request; nothing is stored on disk.
   Loaded chart frames are reused, with core charts warmed one at a time while
   idle and only two recent task charts retained. Record revisions clear both
   caches. Task discovery stays in a searchable menu. */
(() => {
  const tabs = document.getElementById('metric-tabs');
  if (!tabs) return;
  const initialFrame = document.getElementById('metric-frame');
  let frame = initialFrame, activeView = null;
  const panel = document.getElementById('metric-panel');
  const status = document.getElementById('metric-status');
  const retry = document.getElementById('metric-retry');
  const picker = document.querySelector('.metric-picker');
  const toggle = document.getElementById('metric-task-toggle');
  const menu = document.getElementById('metric-task-menu');
  const search = document.getElementById('metric-task-search');
  const options = document.getElementById('metric-task-options');
  let modules = [
    { id: 'overview', label: 'Overview', kind: 'overview' },
    { id: 'weight', label: 'Weight', kind: 'weight' },
    { id: 'wake', label: 'Wake', kind: 'wake' },
  ];
  let dirty = false;
  let revision = null, busy = false, checked = 0, queued = false, initialized = false;
  let catalogReady = false, catalogError = false, activeReady = false, activeFailed = false, generation = 0, epoch = 0, warmQueued = false;
  const cache = new Map(), warmed = new Set();
  const views = new Map();
  const requests = new Set();
  let leaving = false;
  let selected = new URLSearchParams(location.search).get('tab');
  try { selected ||= localStorage.getItem('stellar:metric-tab'); } catch {}
  selected ||= 'overview';
  const endpointFor = module => module.kind === 'weight' ? '/api/weights' : module.kind === 'wake' ? '/api/wake' : '/api/consistency';
  const dataFor = (endpoint, background = false) => {
    if (!['/api/weights', '/api/wake', '/api/consistency'].includes(endpoint)) return Promise.reject(Error('Unknown metric'));
    if (cache.has(endpoint)) return cache.get(endpoint);
    const controller = new AbortController();
    requests.add(controller);
    const promise = fetch(endpoint, { cache: 'no-store', priority: background ? 'low' : 'high', signal: controller.signal }).then(response => {
      if (!response.ok) throw Error('Could not load metric');
      return response.json();
    }).catch(error => {
      if (cache.get(endpoint) === promise) cache.delete(endpoint);
      throw error;
    }).finally(() => requests.delete(controller));
    promise.catch(() => {});
    cache.set(endpoint, promise);
    return promise;
  };
  window.stellarMetricData = dataFor;
  const scheduleWarm = () => {
    if (leaving || warmQueued || !activeReady || !catalogReady || !window.stellarPageActive()) return;
    const module = modules.find(module => module.kind !== 'task' && module.id !== selected &&
      !views.has(urlFor(module)) && !warmed.has(urlFor(module)));
    if (!module) return;
    warmQueued = true;
    const version = epoch;
    const run = async () => {
      if (version !== epoch) { warmQueued = false; scheduleWarm(); return; }
      if (leaving || !activeReady || !window.stellarPageActive()) { warmQueued = false; return; }
      warmed.add(urlFor(module));
      try {
        await dataFor(endpointFor(module), true);
        if (version === epoch) {
          if (activeReady && window.stellarPageActive()) await buildView(module).promise;
          else warmed.delete(urlFor(module));
        }
      } catch {}
      warmQueued = false;
      scheduleWarm();
    };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 150);
  };
  const urlFor = module => {
    if (module.kind === 'weight' || module.kind === 'wake') return '/' + module.kind + '?embedded=true';
    return '/consistency?embedded=true' + (module.kind === 'task'
      ? '&task=' + encodeURIComponent(module.label) + '&titles=' + encodeURIComponent(JSON.stringify(module.titles)) : '');
  };
  const showActiveState = () => {
    activeReady = activeView.ready; activeFailed = activeView.failed;
    panel.setAttribute('aria-busy', String(!activeReady));
    if (activeFailed) { status.textContent = 'Could not load this metric. Check your connection and retry.'; retry.hidden = false; }
    else if (activeReady && !catalogError) { status.textContent = ''; retry.hidden = true; }
  };
  const finishView = (view, failed) => {
    view.ready = true; view.failed = failed; clearTimeout(view.timer); view.resolve();
    if (view !== activeView || leaving) return;
    showActiveState();
    if (!catalogReady && !busy && !catalogError) load(true);
    scheduleWarm();
  };
  function buildView(module) {
    const key = urlFor(module);
    if (views.has(key)) return views.get(key);
    const node = initialFrame.isConnected && !initialFrame.dataset.key ? initialFrame : document.createElement('iframe');
    node.removeAttribute('id'); node.className = 'metric-frame'; node.hidden = true;
    node.title = module.label + ' metrics'; node.style.height = '180px';
    node.dataset.key = key; node.dataset.url = key + '&metric_version=' + (++generation);
    const view = { frame: node, kind: module.kind, ready: false, failed: false, timer: null };
    view.promise = new Promise(resolve => { view.resolve = resolve; });
    views.set(key, view);
    if (!node.isConnected) panel.appendChild(node);
    node.addEventListener('load', () => {
      try { if (node.contentWindow.location.href !== 'about:blank' && node.contentDocument.body.dataset.embedded !== 'true') finishView(view, true); }
      catch { finishView(view, true); }
    });
    view.timer = setTimeout(() => { if (!view.ready) finishView(view, true); }, 20000);
    node.contentWindow.location.replace(node.dataset.url);
    return view;
  }
  const discardView = key => {
    const view = views.get(key);
    if (!view) return;
    clearTimeout(view.timer); view.resolve(); view.frame.remove(); views.delete(key);
  };
  const closeMenu = (focus = false) => {
    menu.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus();
  };
  const renderOptions = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const tasks = modules.filter(module => module.kind === 'task' &&
      [module.label, ...(module.titles || [])].some(title => title.toLocaleLowerCase().includes(query)));
    options.replaceChildren(...tasks.map(module => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.metric = module.id; button.textContent = module.label;
      button.setAttribute('aria-current', String(module.id === selected));
      return button;
    }));
    document.getElementById('metric-task-empty').hidden = tasks.length > 0;
  };
  const syncSelection = () => {
    const module = modules.find(m => m.id === selected);
    tabs.querySelectorAll('button').forEach(button => {
      const active = button.dataset.metric === selected;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active || (!module || module.kind === 'task') && button.dataset.metric === 'overview' ? 0 : -1;
    });
    const active = [...tabs.children].find(button => button.dataset.metric === selected);
    toggle.dataset.active = String(module?.kind === 'task');
    toggle.title = module?.kind === 'task' ? module.label : 'Choose a task metric';
    document.getElementById('metric-task-label').textContent = module?.kind === 'task' ? module.label : 'Task metrics';
    panel.setAttribute('aria-labelledby', active?.id || toggle.id);
    renderOptions();
  };
  const renderNavigation = () => {
    tabs.replaceChildren(...modules.filter(module => module.kind !== 'task').map(module => {
      const button = document.createElement('button');
      button.type = 'button'; button.id = 'metric-tab-' + module.id; button.dataset.metric = module.id;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'metric-panel');
      button.textContent = module.label;
      return button;
    }));
    const hasTasks = modules.some(module => module.kind === 'task');
    picker.hidden = catalogReady && !hasTasks;
    toggle.disabled = !hasTasks;
    syncSelection();
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
    syncSelection();
    const url = urlFor(module);
    if (refresh || views.get(url)?.failed && (userAction || views.get(url) !== activeView)) discardView(url);
    const view = buildView(module);
    if (frame !== view.frame) { frame.hidden = true; frame.removeAttribute('id'); }
    frame = view.frame; activeView = view;
    frame.id = 'metric-frame'; frame.hidden = false;
    views.delete(url); views.set(url, view);
    const taskViews = [...views.entries()].filter(([, item]) => item.kind === 'task');
    taskViews.slice(0, Math.max(0, taskViews.length - 2)).forEach(([key]) => discardView(key));
    if (!view.ready) { status.textContent = 'Loading ' + module.label.toLocaleLowerCase() + '…'; retry.hidden = true; }
    showActiveState();
    frame.title = module.label + ' metrics';
  };
  const load = async (force = false) => {
    if (!window.stellarPageActive()) { dirty ||= force; return; }
    force ||= dirty; dirty = false;
    if (busy) { queued ||= force; return; }
    if (!force && Date.now() - checked < 15000) return;
    busy = true;
    try {
      const response = await fetch('/api/metrics', { cache: 'no-store', priority: 'low' });
      if (!response.ok) throw Error('Could not load metrics');
      const data = await response.json();
      if (!Array.isArray(data.modules) || !data.modules.length) throw Error('Missing metrics');
      const changed = !catalogReady || JSON.stringify(modules) !== JSON.stringify(data.modules);
      const refresh = revision !== null && revision !== data.revision;
      modules = data.modules; revision = data.revision; catalogReady = true; catalogError = false;
      if (refresh) { cache.clear(); warmed.clear(); epoch++; [...views.keys()].forEach(discardView); }
      if (changed) renderNavigation();
      select(selected, refresh, false);
      const allowed = new Set(modules.map(urlFor));
      [...views.keys()].filter(key => !allowed.has(key)).forEach(discardView);
      if (activeReady) {
        status.textContent = activeFailed ? 'Could not load this metric. Check your connection and retry.' : '';
        retry.hidden = !activeFailed;
      }
      checked = Date.now();
      scheduleWarm();
    } catch {
      catalogError = true;
      status.textContent = 'Could not refresh the task list. Check your connection and retry.';
      retry.hidden = false;
    } finally { busy = false; if (queued) { queued = false; load(true); } }
  };
  tabs.addEventListener('click', event => { const button = event.target.closest('[data-metric]'); if (button) { closeMenu(); select(button.dataset.metric); } });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...tabs.children], index = buttons.indexOf(event.target.closest('button'));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    select(buttons[next].dataset.metric); buttons[next].focus();
  });
  toggle.addEventListener('click', () => {
    if (!menu.hidden) { closeMenu(); return; }
    search.value = ''; renderOptions(); menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true'); search.focus();
  });
  search.addEventListener('input', renderOptions);
  options.addEventListener('click', event => {
    const button = event.target.closest('[data-metric]');
    if (button) { select(button.dataset.metric); closeMenu(true); }
  });
  picker.addEventListener('keydown', event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
        event.target === search && ['Home', 'End'].includes(event.key)) return;
    const buttons = [...options.children];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : index < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0)
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  document.addEventListener('click', event => { if (!picker.contains(event.target)) closeMenu(); });
  picker.addEventListener('focusout', () => setTimeout(() => { if (!picker.contains(document.activeElement)) closeMenu(); }, 0));
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'stellar:metric-height') return;
    const view = [...views.values()].find(view => event.source === view.frame.contentWindow);
    if (!view) return;
    const url = new URL(view.frame.dataset.url, location.origin);
    if (event.data.url !== url.pathname + url.search) return;
    const height = Number(event.data.height);
    if (Number.isFinite(height) && height > 0 && height < 30000) view.frame.style.height = Math.ceil(height) + 'px';
    if (event.data.ready) finishView(view, !!event.data.failed);
  });
  retry.addEventListener('click', () => {
    if (catalogError || !catalogReady) load(true);
    if (activeFailed) {
      const module = modules.find(m => m.id === selected);
      cache.delete(endpointFor(module)); select(selected, true);
    }
  });
  window.addEventListener('popstate', () => select(new URLSearchParams(location.search).get('tab') || 'overview', false, false));
  const resume = () => {
    if (!window.stellarPageActive()) return;
    if (!initialized && modules.some(module => module.id === selected)) select(selected, false, false);
    else if (catalogReady || !initialized) load(!initialized);
    scheduleWarm();
  };
  window.addEventListener('stellar:visibility', resume);
  window.addEventListener('focus', () => { if (catalogReady) load(); });
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('stellar:records-changed', () => load(true));
  window.addEventListener('storage', event => { if (event.key === 'stellar:records-changed') load(true); });
  const cancelRequests = () => { leaving = true; epoch++; requests.forEach(controller => controller.abort()); };
  window.addEventListener('stellar:navigate', cancelRequests);
  window.addEventListener('pagehide', cancelRequests);
  window.addEventListener('pageshow', () => {
    leaving = false;
    if (activeView?.failed) select(selected, true, false);
    else if (activeView) showActiveState();
    scheduleWarm();
  });
  setInterval(() => { if (window.stellarPageActive() && catalogReady) load(); }, 60000);
  renderNavigation();
  resume();
})();
