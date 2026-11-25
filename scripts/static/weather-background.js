/* One outer-window sky survives retained tab changes. Forecast requests share
   a short-lived cache and in-flight job across Calendar, Weather and the sky.
   Hidden windows pause animation and reads; failed refreshes keep the last sky.
   Only the selected scene image downloads. Frame documents expose this single
   sky while retaining their own readable glass panels and scroll positions. */
import { readForecast, weatherScene } from './weather-model.js?v=3';

const SCENE_IMAGES = {
  sun: 'fair', cloud: 'fair', overcast: 'fair', night: 'sky', nightcloud: 'sky',
  rain: 'storm', storm: 'storm', snow: 'fair', fog: 'fair',
};
const images = new Map();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const PREFIX = 'stellar:weather:';
const TTL = 15 * 60000;
const read = name => { try { return JSON.parse(localStorage.getItem(PREFIX + name)); } catch { return null; } };
const keyFor = city => [city.latitude, city.longitude].join(',');
const validCity = city => city && typeof city.name === 'string' && Number.isFinite(city.latitude) &&
  Math.abs(city.latitude) <= 90 && Number.isFinite(city.longitude) && Math.abs(city.longitude) <= 180;
const element = (tag, text, className) => { const el = document.createElement(tag); if (className) el.className = className; return el; };

export function notifyWeather() {
  top.dispatchEvent(new Event('stellar:weather-change'));
}

export function loadWeatherStyles() {
  let link = document.querySelector('link[data-weather-styles], link[href*="/app-assets/weather.css"]');
  if (link?.sheet) return Promise.resolve();
  if (!link) {
    link = document.createElement('link'); link.rel = 'stylesheet';
    link.href = '/app-assets/weather.css?v=9'; link.dataset.weatherStyles = '';
    document.head.append(link);
  }
  return new Promise((resolve, reject) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', () => { link.remove(); reject(new Error('Weather styles unavailable')); }, { once: true });
  });
}

export function requestWeatherForecast(city, force = false) {
  const key = keyFor(city);
  const state = top.stellarWeatherRequests ||= { jobs: new Map(), failures: new Map() };
  if (state.jobs.has(key)) return state.jobs.get(key);
  const cached = read('forecast');
  if (!force && cached?.key === key && Date.now() - cached.at < TTL) {
    try { readForecast(cached.data); return Promise.resolve(cached.data); } catch {}
  }
  const failure = state.failures.get(key);
  if (!force && failure && Date.now() - failure.at < 60000) return Promise.reject(failure.error);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  const job = fetch('/api/weather/forecast?' + new URLSearchParams({ latitude: city.latitude, longitude: city.longitude }), { signal: controller.signal, priority: 'low' })
    .then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Weather could not load. Try again.');
      readForecast(data);
      state.failures.delete(key);
      if (keyFor(read('place') || {}) === key) {
        try { localStorage.setItem(PREFIX + 'forecast', JSON.stringify({ key, at: Date.now(), data })); } catch {}
        notifyWeather();
      }
      return data;
    }).catch(error => { state.failures.set(key, { at: Date.now(), error }); throw error; })
    .finally(() => { clearTimeout(timer); state.jobs.delete(key); });
  state.jobs.set(key, job);
  return job;
}

export function changeScene(host) {
  let current, requested, sequence = 0;
  return async scene => {
    const key = scene ? scene.kind + ':' + scene.phase : '';
    if (key === requested) return;
    requested = key;
    const ticket = ++sequence;
    let incoming;
    if (scene) {
      const imageName = SCENE_IMAGES[scene.kind];
      const url = imageName ? '/app-assets/weather-' + imageName + '.jpg?v=1' : null;
      if (url) {
        if (!images.has(url)) {
          const img = new Image();
          img.src = url;
          images.set(url, img.decode().catch(() => images.delete(url)));
        }
        await images.get(url);
      }
      if (ticket !== sequence) return;
      incoming = element('div', null, 'weather-scene');
      incoming.dataset.scene = scene.kind;
      incoming.dataset.phase = scene.phase;
      if (url) incoming.style.setProperty('--weather-image', 'url("' + url + '")');
      if (scene.kind === 'rain' || scene.kind === 'storm') incoming.append(element('div', null, 'weather-rain-depth'));
      host.append(incoming);
    }
    const outgoing = current;
    current = incoming;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (incoming && incoming === current) incoming.classList.add('is-current');
      if (outgoing) {
        outgoing.classList.remove('is-current');
        if (reduceMotion.matches) outgoing.remove();
        else setTimeout(() => outgoing.remove(), 850);
      }
    }));
  };
}

export function mountWeatherBackground() {
  if (window !== top) return top.stellarLoadWeatherBackground?.();
  if (window.stellarWeatherBackground) return window.stellarWeatherBackground;
  let host, scene, forecast, forecastKey, forecastAt = 0, lastTry = 0, styleJob, sequence = 0;
  const roots = [];
  function documents(doc = document) {
    roots.push(doc);
    for (const frame of doc.querySelectorAll('iframe')) {
      try { if (frame.contentDocument) documents(frame.contentDocument); } catch {}
    }
  }
  function expose(active) {
    roots.length = 0; documents();
    for (const doc of roots) {
      doc.documentElement.toggleAttribute('data-weather-backdrop', active);
      doc.documentElement.toggleAttribute('data-weather-shared', active && doc !== document);
    }
  }
  function motion() {
    if (!host) return;
    const blocked = roots.some(doc => doc.querySelector('.weather-dialog[open]') &&
      doc.defaultView.stellarPageActive?.() !== false);
    const visible = !document.hidden && (window.stellarPageActive?.() !== false || document.documentElement.classList.contains('stellar-section-open'));
    host.dataset.weatherMotion = visible && !blocked ? 'running' : 'paused';
  }
  async function sync() {
    const ticket = ++sequence, enabled = read('theme') === true;
    const city = read('place'), key = validCity(city) ? keyFor(city) : '';
    if (key !== forecastKey) { forecast = null; forecastAt = 0; forecastKey = key; }
    const cached = read('forecast');
    if (key && cached?.key === key && cached.at >= forecastAt && Date.now() - cached.at < 45 * 60000) {
      try { forecast = readForecast(cached.data); forecastAt = cached.at; } catch {}
    }
    if (enabled && forecast) {
      if (!styleJob) styleJob = loadWeatherStyles().catch(error => { styleJob = null; throw error; });
      try { await styleJob; } catch { return; }
      if (ticket !== sequence) return;
      if (!host) {
        host = document.querySelector('body > .space-backdrop');
        if (!host) { host = element('div', null, 'space-backdrop'); host.setAttribute('aria-hidden', 'true'); document.body.prepend(host); }
        host.classList.add('stellar-weather-backdrop'); host.classList.remove('stellar-primary-hidden');
        scene = changeScene(host);
      }
      await scene(weatherScene(forecast, Date.now() / 1000));
      if (ticket !== sequence) return;
      expose(true); motion();
    } else {
      if (scene) {
        await scene(null);
        if (document.documentElement.hasAttribute('data-weather-backdrop') && !reduceMotion.matches) await new Promise(resolve => setTimeout(resolve, 850));
      }
      if (ticket !== sequence) return;
      expose(false); motion();
    }
    if (enabled && key && !document.hidden && Date.now() - forecastAt >= TTL && Date.now() - lastTry >= 60000) {
      lastTry = Date.now();
      requestWeatherForecast(city).then(sync).catch(() => {});
    }
  }
  const controller = { sync, hasForecast: key => !!forecast && forecastKey === key };
  window.stellarWeatherBackground = controller;
  window.addEventListener('focus', sync);
  window.addEventListener('pageshow', sync);
  window.addEventListener('stellar:visibility', sync);
  window.addEventListener('stellar:section', sync);
  document.addEventListener('load', event => { if (event.target.tagName === 'IFRAME') sync(); }, true);
  document.addEventListener('visibilitychange', () => { motion(); if (!document.hidden) sync(); });
  window.addEventListener('pagehide', () => { if (host) host.dataset.weatherMotion = 'paused'; });
  setInterval(() => { if (!document.hidden) sync(); }, 60000);
  sync();
  return controller;
}
