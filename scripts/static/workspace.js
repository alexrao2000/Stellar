/* Tasks float within the Pool canvas while its editable stars retain clear
   space beside the panel. Pool stays mounted across range changes so edits
   survive. Range days wrap into rows instead of requiring every day to fit
   across the screen. Week stays at two columns rather than growing with the
   viewport. Compact screens keep the individual views. */
(() => {
  const toggle = document.getElementById('pool-toggle');
  if (!toggle) return;
  const host = document.querySelector('.wrap');
  const pane = document.getElementById('pool-pane');
  const frame = document.getElementById('pool-frame');
  const tasks = host.querySelector('.dated-tasks');
  const dayList = host.querySelector('#day-card');
  const fallback = document.getElementById('pool-fallback');
  const desktop = matchMedia('(min-width: 1100px)');
  let enabled = true;
  try { enabled = localStorage.getItem('stellar:show-pool') !== 'false'; } catch {}
  let open = false;
  let notified = '';
  const notify = () => {
    frame.contentWindow?.stellarSetActive?.(open && window.stellarPageActive());
    const inset = open ? tasks.offsetWidth + 48 : 0;
    const state = open + ':' + inset;
    if (state === notified) return;
    notified = state;
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'stellar:pool-visibility', visible: open,
      inset }, location.origin);
  };
  const layout = () => {
    const view = document.body.dataset.range || 'day';
    const columns = Math.max(1, Number(document.body.dataset.columns) || 1);
    const minimum = view === 'month' || columns > 3 ? 560 : 380;
    const navWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-w')) || 172;
    const available = Math.min(document.documentElement.clientWidth, innerWidth - 20) - navWidth - 48;
    const fits = desktop.matches && available >= minimum + 420 + 24;
    open = enabled && fits;
    toggle.hidden = !fits;
    fallback.hidden = !desktop.matches || fits;
    toggle.setAttribute('aria-pressed', String(open));
    toggle.textContent = open ? 'Hide Pool' : 'Show Pool';
    host.classList.toggle('workspace-open', open);
    document.body.classList.toggle('space-open', open);
    host.dataset.taskColumns = '1';
    const maximum = available - 420 - 24;
    let width = view === 'day' ? Math.min(maximum, 460) : minimum;
    if (view !== 'day' && view !== 'month') {
      const dayWidth = 160, gap = 10, panelPadding = 34;
      const capacity = Math.max(1, Math.floor((maximum - panelPadding + gap) / (dayWidth + gap)));
      const across = view === 'week' ? 2 : capacity >= columns ? columns : Math.min(4, capacity);
      host.style.setProperty('--workspace-range-columns', across);
      width = view === 'week' ? minimum : Math.min(maximum, across * (across > 4 ? 168 : 200) + (across - 1) * gap + panelPadding);
    }
    host.style.setProperty('--workspace-task-width', Math.max(minimum, width) + 'px');
    if (open && view === 'day' && dayList.scrollHeight > dayList.clientHeight + 1 && maximum >= 520) {
      width = Math.min(maximum, 680);
      host.dataset.taskColumns = '2';
      host.style.setProperty('--workspace-task-width', width + 'px');
      if (dayList.scrollHeight > dayList.clientHeight + 1 && maximum >= 740) {
        host.dataset.taskColumns = '3';
        host.style.setProperty('--workspace-task-width', Math.min(maximum, 980) + 'px');
      }
    }
    pane.hidden = !open;
    if (open && !frame.hasAttribute('src')) frame.src = '/pool?embedded=true';
    notify();
  };
  toggle.addEventListener('click', () => {
    enabled = !enabled;
    try { localStorage.setItem('stellar:show-pool', String(enabled)); } catch {}
    layout();
  });
  frame.addEventListener('load', () => { notified = ''; notify(); });
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === frame.contentWindow && event.data?.type === 'stellar:pool-background-ready') {
      frame.dataset.ready = 'true';
    }
  });
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; layout(); });
  };
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['data-range', 'data-columns'] });
  new MutationObserver(schedule).observe(tasks, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('stellar:sidebar', layout);
  layout();
})();
