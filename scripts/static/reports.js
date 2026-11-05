/* Optional outcomes stay unreported until entered. Mandatory outcomes become
   incomplete at their deadline, or at the end of their day when none is set.
   Bonus completions never replace required work. Optional frequency measures
   occurrences per calendar week; missing reports remain a separate category. */
(() => {
  const labels = { done: 'Done', incomplete: 'Incomplete', unreported: 'Unreported' };
  const today = () => { const date = new Date(); return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); };
  const overdue = row => {
    const due = row.report_due_at || row.deadline_at;
    return due ? Date.now() >= Date.parse(due) : row.day < today();
  };
  const state = row => row.is_completed ? 'done' : row.status === 'incomplete' ? 'incomplete' : row.status === 'unreported' ? 'unreported' :
    !row.optional && overdue(row) ? 'incomplete' : 'unreported';
  const apply = (row, value) => {
    row.is_completed = value === 'done';
    row.status = { done: 'completed', incomplete: 'incomplete', unreported: 'unreported' }[value];
    row.completed_at = value === 'done' ? new Date().toISOString() : null;
    row.report_state = state(row);
  };
  const counts = rows => {
    const required = rows.filter(row => !row.optional), done = rows.filter(row => state(row) === 'done').length;
    const requiredDone = required.filter(row => state(row) === 'done').length;
    return { done, required: required.length, requiredDone, bonus: done - requiredDone,
      incomplete: rows.filter(row => state(row) === 'incomplete').length,
      unreported: rows.filter(row => state(row) === 'unreported').length,
      percent: required.length ? requiredDone / required.length * 100 : null,
      complete: required.length > 0 && requiredDone === required.length };
  };
  const fraction = count => count.required ? count.done + '/' + count.required : count.done + ' optional';
  const description = count => count.requiredDone + '/' + count.required + ' required' + (count.bonus ? ' · +' + count.bonus + ' optional' : '');
  const frequency = rows => {
    const past = rows.filter(row => row.day <= today()).sort((a, b) => a.day.localeCompare(b.day));
    if (!past.length) return null;
    const span = Math.round((Date.parse(past.at(-1).day + 'T12:00:00Z') - Date.parse(past[0].day + 'T12:00:00Z')) / 86400000) + 1;
    return past.filter(row => state(row) === 'done').length * 7 / span;
  };
  const progress = (host, source) => {
    const overview = document.createElement('div'); overview.className = 'range-overview';
    const count = document.createElement('span'); count.className = 'range-total';
    const percent = document.createElement('span'); percent.className = 'range-percent';
    const track = document.createElement('div'); track.className = 'range-progress'; track.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('span'); track.append(bar);
    const breakdown = document.createElement('p'); breakdown.className = 'range-breakdown';
    overview.append(count, percent, track, breakdown); host.append(overview);
    const update = () => {
      const result = counts(typeof source === 'function' ? source() : source);
      const strong = document.createElement('strong'); strong.textContent = fraction(result);
      count.replaceChildren(strong, ' completed');
      percent.textContent = result.percent === null ? '—' : Math.round(result.percent) + '%';
      bar.style.width = (result.percent || 0) + '%';
      breakdown.hidden = !result.bonus; breakdown.textContent = description(result);
      overview.title = description(result);
    };
    update(); return update;
  };
  const choose = (row, opener) => new Promise(resolve => {
    const existing = document.querySelector('.report-picker');
    if (existing) { existing.hidePopover?.(); existing.close?.(); }
    const popover = 'showPopover' in HTMLElement.prototype;
    const dialog = document.createElement(popover ? 'div' : 'dialog'); dialog.className = 'report-picker'; dialog._opener = opener;
    if (popover) dialog.setAttribute('popover', 'manual');
    dialog.setAttribute('role', 'dialog');
    const hide = () => popover ? dialog.hidePopover() : dialog.close();
    const title = document.createElement('h2'); title.id = 'report-picker-title'; title.textContent = row.title;
    const date = document.createElement('p'); date.textContent = row.day + (row.optional ? ' · Optional' : ' · Required');
    const close = document.createElement('button'); close.type = 'button'; close.className = 'report-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Close status picker');
    let result = null;
    close.addEventListener('click', hide);
    dialog.append(close, title, date); dialog.setAttribute('aria-labelledby', title.id);
    for (const value of ['done', 'incomplete', 'unreported']) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'report-option'; button.dataset.state = value;
      const icon = document.createElement('span'); icon.className = 'report-symbol'; icon.textContent = '✦'; icon.setAttribute('aria-hidden', 'true');
      button.append(icon, labels[value]); button.setAttribute('aria-pressed', String(state(row) === value));
      button.addEventListener('click', () => { result = value; hide(); }); dialog.append(button);
    }
    if (!row.optional && overdue(row)) { const hint = document.createElement('p'); hint.className = 'report-explanation'; hint.textContent = 'Unreported clears the outcome you entered.'; dialog.append(hint); }
    dialog.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); hide(); } });
    dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) hide(); });
    const outside = event => { if (!dialog.contains(event.target) && (event.target !== opener || event.button === 0)) hide(); };
    document.addEventListener('pointerdown', outside, true);
    const finish = () => { document.removeEventListener('pointerdown', outside, true); const restore = result !== null || dialog.contains(document.activeElement); dialog.remove(); if (restore && opener?.isConnected) opener.focus({ preventScroll: true }); resolve(result); };
    if (popover) dialog.addEventListener('toggle', event => { if (event.newState === 'closed') finish(); });
    else dialog.addEventListener('close', finish);
    (opener?.closest('dialog[open]') || document.body).append(dialog);
    if (popover) {
      const rect = opener?.getBoundingClientRect() || { left: innerWidth / 2 - 165, bottom: innerHeight / 2 - 140 };
      dialog.style.left = Math.max(12, Math.min(rect.left, innerWidth - 342)) + 'px';
      dialog.style.top = Math.max(12, Math.min(rect.bottom + 6, innerHeight - 310)) + 'px';
      const top = matchMedia('(max-width: 760px)').matches ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-nav-height')) || 58) + 12 : 12;
      const height = window.visualViewport?.height || innerHeight;
      dialog.style.maxHeight = Math.max(120, height - top - 12) + 'px';
      dialog.showPopover();
      dialog.style.top = Math.max(top, Math.min(rect.bottom + 6, height - dialog.getBoundingClientRect().height - 12)) + 'px';
    } else dialog.showModal();
    dialog.querySelector('[aria-pressed=true]')?.focus({ preventScroll: true });
  });
  const bind = (button, row, update) => {
    let timer, origin, pointer = null, pressOpened = false, suppressUntil = 0;
    const current = () => typeof row === 'function' ? row() : row;
    const open = () => { const existing = document.querySelector('.report-picker'); if (existing?._opener === button && (existing.hasAttribute('popover') && existing.matches(':popover-open') || existing.open)) return; if (!button.disabled && current()) choose(current(), button).then(value => { if (value && (value !== (current().is_completed ? 'done' : current().status === 'incomplete' ? 'incomplete' : 'unreported') || value === 'unreported')) update(value); }); };
    button.addEventListener('click', event => {
      if (button.disabled || performance.now() < suppressUntil) { event.preventDefault(); return; }
      if (current()) update(state(current()) === 'done' ? 'incomplete' : 'done');
    });
    button.addEventListener('contextmenu', event => { event.preventDefault(); clearTimeout(timer); if (pointer !== null) pressOpened = true; suppressUntil = performance.now() + 700; open(); });
    button.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); open(); } });
    button.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch') return;
      pointer = event.pointerId; origin = [event.clientX, event.clientY];
      timer = setTimeout(() => { pressOpened = true; suppressUntil = performance.now() + 1000; open(); }, 550);
    });
    button.addEventListener('pointermove', event => { if (event.pointerId === pointer && origin && Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 10) clearTimeout(timer); });
    for (const event of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(event, input => { if (pointer !== null && input.pointerId !== pointer) return; clearTimeout(timer); origin = null; pointer = null; if (pressOpened) { suppressUntil = performance.now() + 700; pressOpened = false; } });
  };
  const tick = () => { if (!document.hidden && window.stellarPageActive?.() !== false && (window === parent || frameElement && !frameElement.hidden && frameElement.getClientRects().length)) window.dispatchEvent(new Event('stellar:report-clock')); };
  setInterval(tick, 60000);
  window.addEventListener('stellar:visibility', tick);
  document.addEventListener('visibilitychange', tick);
  window.StellarReports = { state, apply, counts, fraction, description, frequency, progress, choose, bind, labels, overdue, today };
})();
