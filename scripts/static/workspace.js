/* Tasks float within the Pool canvas while its editable stars retain clear
   space beside the panel. Pool stays mounted across range changes so edits
   survive. Range comparisons keep a compact width beside the stars.
   Width changes animate from the current size; Pool controls follow the panel.
   The observed task subtree includes the Pool toggle, so unchanged labels must
   not be rewritten and schedule another layout. */
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
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let widthAnimation = null, initialized = false;
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
    const previousWidth = tasks.getBoundingClientRect().width;
    const wasOpen = open;
    widthAnimation?.cancel(); widthAnimation = null;
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
    const label = open ? 'Hide Pool' : 'Show Pool';
    if (toggle.textContent !== label) toggle.textContent = label;
    host.classList.toggle('workspace-open', open);
    document.body.classList.toggle('space-open', open);
    host.dataset.taskColumns = '1';
    const maximum = available - 420 - 24;
    let width = view === 'day' ? Math.min(maximum, 460) : minimum;
    if (view === '3days') width = Math.min(maximum, 480);
    if (view === 'week' || view === 'custom') width = Math.min(maximum, 560);
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
    const targetWidth = tasks.getBoundingClientRect().width;
    if (initialized && wasOpen && open && !reducedMotion.matches && window.stellarPageActive() && Math.abs(targetWidth - previousWidth) > 1) {
      const animation = tasks.animate([{ width: previousWidth + 'px' }, { width: targetWidth + 'px' }],
        { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      widthAnimation = animation;
      animation.onfinish = () => { if (widthAnimation === animation) { widthAnimation = null; notify(); } };
    }
    initialized = true;
    notify();
  };
  new ResizeObserver(notify).observe(tasks);
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) { widthAnimation?.cancel(); widthAnimation = null; notify(); }
  });
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
