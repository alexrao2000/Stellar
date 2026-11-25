/* Shared by Calendar and the task planning editor. Explicit selections reserve
   their symbols first. Automatic assignments follow series order so adding a
   new task or renaming an existing one keeps the other icons familiar. */

export const taskIconChoices = new Map([
  ['comet', ['Comet', 'M10 5a4 4 0 1 1 5 5l-7 3 3-7m-2 9-4 4m5-1-2 2']],
  ['moon', ['Moon', 'M16 14A7 7 0 0 1 9 5a7.5 7.5 0 1 0 7 9Z']],
  ['planet', ['Planet', 'M16 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM7 10c-4 2-5 5-4 6 2 2 17-4 17-7 0-1-2-2-5-1']],
  ['sun', ['Sun', 'M15 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM11 4v2m0 12v2m-8-8h2m12 0h2M5 6l2 2m8 8 2 2m-12 0 2-2']],
  ['bolt', ['Lightning', 'm12 4-7 9h6l-1 7 8-10h-6l1-6Z']],
  ['heart', ['Heart', 'M11 19 5 13c-4-4 2-9 6-4 4-5 10 0 6 4Z']],
  ['leaf', ['Leaf', 'M5 17c-3-7 5-10 12-10-1 8-5 13-11 11m-2 2 9-9']],
  ['diamond', ['Crystal', 'm11 4 7 7-7 8-7-8Zm-7 7h14m-7-7 3 7-3 8-3-8Z']],
  ['drop', ['Droplet', 'M11 4c-2 4-6 8-6 11a6 6 0 0 0 12 0c0-3-4-7-6-11Z']],
  ['flame', ['Flame', 'M11 20c-5 0-7-4-5-8l2 2c0-5 4-6 4-10 4 4 6 8 5 12-1 3-3 4-6 4Z']],
  ['cloud', ['Cloud', 'M7 18h9a3 3 0 0 0 0-6 5 5 0 0 0-9-2 4 4 0 0 0 0 8Z']],
  ['flag', ['Flag', 'M6 20V5h11l-3 4 3 4H6']],
  ['book', ['Book', 'M3 7c3-1 5 0 8 2 2-2 5-3 8-2v11c-3-1-6 0-8 2-3-2-5-3-8-2Zm8 2v11']],
  ['pencil', ['Pencil', 'm5 16 9-10 4 4-9 10-5 1Zm7-8 4 4']],
  ['capsule', ['Capsule', 'M7 19a4.5 4.5 0 0 1-3-7l6-6a4.5 4.5 0 0 1 7 6l-6 6a4.5 4.5 0 0 1-4 1Zm0-10 7 7']],
  ['clock', ['Clock', 'M18 13a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-7-4v4l3 2']],
  ['headphones', ['Headphones', 'M4 15v-3a7 7 0 0 1 14 0v3M4 14h3v5H6a2 2 0 0 1-2-2Zm14 0h-3v5h1a2 2 0 0 0 2-2Z']],
  ['footprint', ['Footprint', 'M17 15c-1 4-6 4-8 2l-4 1-2-4 6-2 2-5 3 1v4l4 1Zm-12 3 1 2 10-2 2-3']],
  ['dumbbell', ['Dumbbell', 'M3 9h3v8H3Zm3 4h10m0-4h3v8h-3Z']],
  ['mountain', ['Mountain', 'm3 19 7-13 4 7 2-3 4 9Zm5-9 2 2 2-2']],
  ['coffee', ['Cup', 'M5 8h10v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Zm10 1h2a2 2 0 0 1 0 4h-2M4 20h13']],
  ['camera', ['Camera', 'M3 10h4l2-3h4l2 3h4v9H3Zm11 4.5a3 3 0 1 1-6 0 3 3 0 1 1 6 0Z']],
  ['music', ['Music', 'M9 17V8l9-2v9m0 0c0 3-5 4-5 2 0-2 3-3 5-2ZM9 17c0 3-5 4-5 2 0-2 3-3 5-2Z']],
  ['gift', ['Gift', 'M4 10h14v4H4Zm1 4v6h12v-6m-6-4v10M11 10C4 10 7 3 11 10c4-7 7 0 0 0Z']],
  ['code', ['Code', 'm7 9-4 4 4 4m8-8 4 4-4 4m-2-10-4 12']],
  ['sparkle', ['Star', 'M11 4c1 5 2 7 7 8-5 1-6 3-7 8-1-5-3-7-8-8 5-1 7-3 8-8Z']],
]);

const seriesOrder = new Intl.Collator('en', { numeric: true });

export function assignTaskIcons(tasks) {
  const keys = [...taskIconChoices.keys()];
  const explicit = new Set(tasks.map(task => task.rule?.icon));
  const available = keys.filter(key => !explicit.has(key));
  const ordered = [...tasks].sort((a, b) => seriesOrder.compare(a.series_id, b.series_id));
  let index = 0;
  return new Map(ordered.map(task => {
    const selected = task.rule?.icon;
    if (taskIconChoices.has(selected)) return [String(task.series_id), { key: selected }];
    const overflow = index - available.length;
    const icon = overflow < 0 ? { key: available[index] } : { key: keys[overflow % keys.length], variant: Math.floor(overflow / keys.length) + 1 };
    index++;
    return [String(task.series_id), icon];
  }));
}

export function taskIcon({ key = 'sparkle', variant } = {}) {
  const icon = document.createElement('span');
  icon.className = 'task-icon';
  icon.dataset.icon = key;
  icon.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const shape = document.createElementNS(svg.namespaceURI, 'path');
  shape.setAttribute('d', (taskIconChoices.get(key) || taskIconChoices.get('sparkle'))[1]);
  const star = document.createElementNS(svg.namespaceURI, 'path');
  star.setAttribute('class', 'task-icon-glint');
  star.setAttribute('d', 'M19.5 2q.5 2.5 3 3-2.5.5-3 3-.5-2.5-3-3 2.5-.5 3-3Z');
  svg.append(shape, star);
  icon.append(svg);
  if (variant) {
    const number = document.createElement('sup');
    number.textContent = variant;
    icon.append(number);
  }
  return icon;
}
