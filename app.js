import {
  MOODS, moodById, rankPlaces, pick, shortlist, planEvening, hhmm, todayAt, addMin,
  roundUpToQuarter, prettyCuisine, mapsLink, shareText, shortlistText, encodePlan, decodePlan,
  statusAt,
} from './lib/planner.js';
import { fetchPlaces, searchArea, reverseName, getPosition } from './lib/osm.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  origin: null,
  originLabel: '',
  mood: 'surprise',
  data: null,
  vetoed: new Set(),
  ranked: [],
  thinMatch: false,
  plan: null,
  readyAt: null,
  map: null,
};

// ---------- Preferences (per device, best effort) ----------
const PREF_KEY = 'ovj-prefs';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      mood: state.mood,
      mode: radioValue('mode'), radius: radioValue('radius'), style: radioValue('style'),
      veggie: $('#veggie').checked,
      origin: state.origin, originLabel: state.originLabel,
    }));
  } catch { /* storage unavailable: fine */ }
}
const radioValue = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, value) => {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
};

// ---------- Azulejo tile patterns ----------
const svg = (body) => `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='none' stroke='black' stroke-width='3.2'>${body}</svg>`,
)}")`;
const PATTERNS = [
  svg(`<path d='M0 28A28 28 0 0 0 28 0M72 0A28 28 0 0 0 100 28M100 72A28 28 0 0 0 72 100M28 100A28 28 0 0 0 0 72'/><path d='M0 15A15 15 0 0 0 15 0M85 0A15 15 0 0 0 100 15M100 85A15 15 0 0 0 85 100M15 100A15 15 0 0 0 0 85'/><path d='M50 26 74 50 50 74 26 50Z'/><circle cx='50' cy='50' r='7'/>`),
  svg(`<circle cx='50' cy='50' r='24'/><circle cx='50' cy='50' r='11'/><path d='M50 0V26M50 74V100M0 50H26M74 50H100'/><path d='M0 0 18 18M100 0 82 18M100 100 82 82M0 100 18 82'/>`),
  svg(`<path d='M50 8C62 30 70 38 92 50 70 62 62 70 50 92 38 70 30 62 8 50 30 38 38 30 50 8Z'/><circle cx='50' cy='50' r='9'/><path d='M0 0H14V14H0ZM86 0H100V14H86ZM86 86H100V100H86ZM0 86H14V100H0Z'/>`),
  svg(`<path d='M0 50A50 50 0 0 1 50 0M50 100A50 50 0 0 0 100 50M50 0A50 50 0 0 0 100 50M0 50A50 50 0 0 0 50 100'/><path d='M50 30 70 50 50 70 30 50Z'/>`),
];

function renderMoods() {
  const wrap = $('#moods');
  wrap.innerHTML = MOODS.map((m) => `
    <button type="button" class="tile" role="radio" data-mood="${m.id}" aria-checked="${m.id === state.mood}"
      tabindex="${m.id === state.mood ? 0 : -1}">
      <span class="tile-text"><strong>${esc(m.name)}</strong><small>${esc(m.blurb)}</small></span>
    </button>`).join('');
  const tiles = [...wrap.querySelectorAll('.tile')];
  tiles.forEach((t, i) => t.style.setProperty('--pattern', PATTERNS[i % PATTERNS.length]));
  const select = (tile, focus) => {
    state.mood = tile.dataset.mood;
    tiles.forEach((t) => {
      const on = t === tile;
      t.setAttribute('aria-checked', on);
      t.tabIndex = on ? 0 : -1;
    });
    if (focus) tile.focus();
    savePrefs();
  };
  tiles.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const cols = window.matchMedia('(min-width: 30rem)').matches ? 4 : 2;
      const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      if (delta) {
        e.preventDefault();
        select(tiles[(i + delta + tiles.length) % tiles.length], true);
      }
    });
  });
}

// ---------- Where ----------
function setOrigin(origin, label) {
  state.origin = origin;
  state.originLabel = label;
  state.data = null;
  const s = $('#where-status');
  s.className = 'status ok';
  s.textContent = `Searching near ${label}`;
  $('#area-results').hidden = true;
  savePrefs();
}

async function useLocation() {
  const btn = $('#locate');
  const s = $('#where-status');
  btn.disabled = true;
  s.className = 'status';
  s.textContent = 'Finding you…';
  try {
    const pos = await getPosition();
    setOrigin(pos, 'your location');
    reverseName(pos).then((name) => {
      if (state.origin === pos) { state.originLabel = name; s.textContent = `Searching near ${name}`; savePrefs(); }
    });
  } catch (err) {
    s.className = 'status err';
    s.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function doAreaSearch() {
  const q = $('#area').value.trim();
  const s = $('#where-status');
  const list = $('#area-results');
  if (!q) { $('#area').focus(); return; }
  s.className = 'status';
  s.textContent = 'Looking that up…';
  try {
    const results = await searchArea(q);
    if (!results.length) {
      s.className = 'status err';
      s.textContent = `Couldn't find “${q}”. Try adding the city, e.g. “${q}, Lisboa”.`;
      list.hidden = true;
      return;
    }
    if (results.length === 1) { setOrigin(results[0], results[0].label); return; }
    s.textContent = 'Which one?';
    list.innerHTML = results.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.label)}</button></li>`).join('');
    list.hidden = false;
    list.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const r = results[+b.dataset.i];
      setOrigin(r, r.label);
    }));
    list.querySelector('button').focus();
  } catch (err) {
    s.className = 'status err';
    s.textContent = err.message || 'Area search failed. Check your connection.';
  }
}

// ---------- When ----------
function defaultReadyTime(now = new Date()) {
  const evening = todayAt('19:30', now);
  if (now < addMin(evening, -60)) return '19:30';
  return hhmm(roundUpToQuarter(addMin(now, 30)));
}

function readyAtFromInput() {
  const now = new Date();
  const val = $('#ready').value || defaultReadyTime(now);
  let t = todayAt(val, now);
  // "00:30" typed at 23:00 means tonight, not this morning.
  if (now - t > 3 * 3600000) t = addMin(t, 1440);
  return t < now ? now : t;
}

// ---------- Picking ----------
function rerank() {
  const { ranked, thinMatch } = rankPlaces(state.data.restaurants, {
    mood: state.mood,
    origin: state.origin,
    radius: +radioValue('radius'),
    readyAt: state.readyAt,
    mode: radioValue('mode'),
    veggieOnly: $('#veggie').checked,
    exclude: state.vetoed,
  });
  state.ranked = ranked;
  state.thinMatch = thinMatch;
}

function makePlan(choice) {
  return planEvening({
    origin: state.origin,
    place: choice.place,
    readyAt: state.readyAt,
    mode: radioValue('mode'),
    style: radioValue('style'),
    meetSpots: state.data.meetSpots,
  });
}

async function onSubmit(e) {
  e.preventDefault();
  const status = $('#go-status');
  if (!state.origin) {
    status.className = 'status err';
    status.textContent = 'Choose where you are first: use your location or type an area.';
    $('#locate').focus();
    return;
  }
  const go = $('#go');
  go.disabled = true;
  status.className = 'status';
  status.textContent = `Looking for places near ${state.originLabel}…`;
  savePrefs();
  try {
    state.data = await fetchPlaces(state.origin, +radioValue('radius'), (msg) => { status.textContent = msg; });
    state.readyAt = readyAtFromInput();
    state.vetoed = new Set();
    rerank();
    status.textContent = '';
    if (!state.ranked.length) {
      status.className = 'status err';
      status.textContent = state.data.restaurants.length
        ? `Nothing open within ${+radioValue('radius') / 1000} km around ${hhmm(state.readyAt)}${$('#veggie').checked ? ' with veggie options' : ''}. Try a wider distance or an earlier time.`
        : `No restaurants on the map within ${+radioValue('radius') / 1000} km of ${state.originLabel}. Try a wider distance.`;
      $('#result').hidden = true;
      return;
    }
    await choose(pick(state.ranked));
  } catch (err) {
    status.className = 'status err';
    status.textContent = err.message;
  } finally {
    go.disabled = false;
  }
}

async function choose(choice, { roll = true } = {}) {
  state.plan = makePlan(choice);
  await renderResult(state.plan, choice, roll);
}

async function pickAnother() {
  if (state.plan) state.vetoed.add(state.plan.place.id);
  rerank();
  if (!state.ranked.length) {
    toast('That was the last place that fits. Try a wider distance or another mood.');
    state.vetoed = new Set();
    rerank();
    return;
  }
  await choose(pick(state.ranked));
}

// ---------- Rendering ----------
function badgeFor(plan) {
  const st = plan.status || { state: 'unknown' };
  if (st.state === 'open') return `<span class="badge open">Open until ${hhmm(addMin(plan.dinnerAt, st.minutesLeft))}</span>`;
  if (st.state === 'closed' && st.opensInMin != null) return `<span class="badge">Opens ${hhmm(addMin(plan.dinnerAt, st.opensInMin))}</span>`;
  return `<span class="badge">Hours not listed${plan.place.phone ? ': call ahead' : ''}</span>`;
}

function boardRows(plan, { withLeave = true } = {}) {
  const r = plan.place;
  const rows = [];
  const how = { walk: 'on foot', transit: 'by metro or bus', car: 'by car' }[radioValue('mode')] || 'on foot';
  if (withLeave && plan.leaveAt) {
    rows.push(`<li><time>${hhmm(plan.leaveAt)}</time><span class="what">Leave<small>About ${plan.travelMin} min ${plan.travelMin < 12 && how !== 'on foot' ? 'on foot' : how}</small></span></li>`);
  }
  if (plan.type === 'drinks' && plan.meetSpot) {
    const s = plan.meetSpot;
    const kind = s.kind === 'square' ? 'Square' : s.kind[0].toUpperCase() + s.kind.slice(1);
    rows.push(`<li><time>${hhmm(plan.meetAt)}</time><span class="what">Meet at ${esc(s.name)}<small>${kind}, ${plan.walkMin} min walk to dinner. <a href="${mapsLink(s)}" target="_blank" rel="noopener">Map</a></small></span></li>`);
    rows.push(`<li><time>${hhmm(plan.dinnerAt)}</time><span class="what">Dinner at ${esc(r.name)}<small>${esc(r.address || prettyCuisine(r))}</small></span></li>`);
  } else if (plan.type === 'drinks') {
    rows.push(`<li><time>${hhmm(plan.meetAt)}</time><span class="what">Meet outside ${esc(r.name)}<small>No bar nearby on the map, so meet at the door</small></span></li>`);
    rows.push(`<li><time>${hhmm(plan.dinnerAt)}</time><span class="what">Dinner<small>${esc(r.address || prettyCuisine(r))}</small></span></li>`);
  } else {
    rows.push(`<li><time>${hhmm(plan.meetAt)}</time><span class="what">Meet at ${esc(r.name)}<small>${esc(r.address || 'Straight to dinner')}</small></span></li>`);
  }
  return `<ol class="board">${rows.join('')}</ol>`;
}

function shareLink(plan) {
  // A link only helps friends if the app is hosted somewhere they can open.
  if (location.protocol !== 'https:') return '';
  return `${location.origin}${location.pathname}#p=${encodePlan(plan, state.mood)}`;
}

async function rollNames(el, finalName) {
  if (reducedMotion) { el.textContent = finalName; return; }
  const names = state.ranked.slice(0, 12).map((r) => r.place.name);
  if (names.length < 2) { el.textContent = finalName; return; }
  el.classList.add('rolling');
  for (let i = 0; i < 12; i++) {
    el.textContent = names[i % names.length];
    await new Promise((r) => setTimeout(r, 55 + i * 6));
  }
  el.classList.remove('rolling');
  el.textContent = finalName;
}

async function renderResult(plan, choice, roll) {
  const box = $('#result');
  const r = plan.place;
  const mood = moodById(state.mood);
  const km = (choice.dist / 1000).toFixed(1);

  const notes = [];
  if (plan.reason === 'opens-later') notes.push(`${esc(r.name)} opens at ${hhmm(plan.dinnerAt)}, so meet for a drink first.`);
  if (state.data?.source === 'nominatim') notes.push('The main map server was busy, so this came from a smaller backup list. Try again later for more choice.');
  if (state.thinMatch) notes.push(`There aren't many “${esc(mood.name.toLowerCase())}” places around here, so this is the closest fit.`);

  state.map?.remove();
  state.map = null;
  box.innerHTML = `
    <div class="ticket-head">
      <p class="kicker">${esc(mood.name)}, ${km} km away</p>
      <h2 class="place-name" id="place-name">${esc(r.name)}</h2>
      <p class="place-meta">${esc(prettyCuisine(r))}${r.address ? `, ${esc(r.address)}` : ''}</p>
      ${badgeFor(plan)}
    </div>
    ${boardRows(plan)}
    ${notes.map((n) => `<p class="note">${n}</p>`).join('')}
    <div class="map" id="map" role="img" aria-label="Map showing the restaurant${plan.meetSpot ? ' and meeting point' : ''}"></div>
    <div class="actions">
      <button type="button" class="btn btn-send" id="send">Send to the group</button>
      <div class="row">
        <button type="button" class="btn btn-outline" id="another">Pick another</button>
        <button type="button" class="btn btn-outline" id="three">Let them vote</button>
      </div>
      <div class="row">
        <a class="btn btn-outline" href="${esc(reviewsLink(r))}" target="_blank" rel="noopener">Check reviews</a>
        <button type="button" class="btn btn-outline" id="copy">Copy plan</button>
      </div>
    </div>
    <div class="shortlist" id="shortlist" hidden></div>`;
  box.hidden = false;

  const nameEl = $('#place-name');
  if (roll) {
    box.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    await rollNames(nameEl, r.name);
  }
  box.focus({ preventScroll: true });

  drawMap('map', plan, state.origin);
  const text = () => shareText(plan, shareLink(plan));
  $('#send').addEventListener('click', () => share(text()));
  $('#copy').addEventListener('click', () => copy(text()));
  $('#another').addEventListener('click', pickAnother);
  $('#three').addEventListener('click', renderShortlist);
}

function reviewsLink(p) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${p.name} ${p.address || state.originLabel} reviews`)}`;
}

function renderShortlist() {
  const box = $('#shortlist');
  const pool = state.ranked.filter((x) => x.place.id !== state.plan.place.id);
  const current = state.ranked.find((x) => x.place.id === state.plan.place.id);
  const options = [current, ...shortlist(pool, Math.random, 2)].filter(Boolean);
  box.innerHTML = `
    <h3>Three options for the group</h3>
    <ol>${options.map((o, i) => `
      <li><button type="button" data-i="${i}"><span class="num">${i + 1}</span>
        <span><strong>${esc(o.place.name)}</strong><small>${esc(prettyCuisine(o.place))}, ${(o.dist / 1000).toFixed(1)} km. Tap to plan this one</small></span>
      </button></li>`).join('')}
    </ol>
    <button type="button" class="btn btn-send" id="send-three" style="width:100%">Send the 3 options</button>`;
  box.hidden = false;
  box.querySelectorAll('li button').forEach((b) => b.addEventListener('click', () => choose(options[+b.dataset.i], { roll: false })));
  $('#send-three').addEventListener('click', () => share(shortlistText(options)));
  box.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
}

function drawMap(id, plan, origin) {
  if (!window.L) { document.getElementById(id).hidden = true; return; }
  const map = L.map(id, { scrollWheelZoom: false, attributionControl: true, zoomControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const css = getComputedStyle(document.documentElement);
  const cobalt = css.getPropertyValue('--cobalt').trim();
  const ink = css.getPropertyValue('--ink').trim();
  const pts = [];
  const dot = (p, color, label, r = 9) => {
    L.circleMarker([p.lat, p.lon], { radius: r, color: ink, weight: 2, fillColor: color, fillOpacity: 1 })
      .addTo(map).bindTooltip(esc(label));
    pts.push([p.lat, p.lon]);
  };
  if (origin) dot(origin, '#ffffff', 'You', 6);
  if (plan.meetSpot) dot(plan.meetSpot, cobalt, plan.meetSpot.name, 8);
  dot(plan.place, '#FFC21A', plan.place.name, 11);
  if (pts.length > 1) map.fitBounds(pts, { padding: [28, 28], maxZoom: 17 });
  else map.setView(pts[0], 16);
  if (id === 'map') state.map = map;
}

// ---------- Sharing ----------
async function share(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Plan copied. Paste it in the group chat.');
  } catch {
    window.prompt('Copy this:', text);
  }
}

let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

// ---------- A plan someone sent you ----------
function renderShared() {
  const m = location.hash.match(/^#p=(.+)$/);
  if (!m) return;
  const decoded = decodePlan(m[1]);
  if (!decoded) return;
  const { plan } = decoded;
  const r = plan.place;
  plan.status = statusAt(r.openingHours, plan.dinnerAt);
  const box = $('#shared');
  box.innerHTML = `
    <div class="ticket-head">
      <p class="kicker">The plan for ${plan.dinnerAt.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</p>
      <h2 class="place-name">${esc(r.name)}</h2>
      <p class="place-meta">${esc(prettyCuisine(r))}${r.address ? `, ${esc(r.address)}` : ''}</p>
      ${badgeFor(plan)}
    </div>
    ${boardRows(plan, { withLeave: false })}
    <div class="map" id="shared-map" role="img" aria-label="Map of the plan"></div>
    <div class="actions">
      <a class="btn btn-send" href="${esc(mapsLink(plan.meetSpot || r))}" target="_blank" rel="noopener">Directions to ${esc((plan.meetSpot || r).name)}</a>
      <button type="button" class="btn btn-outline" id="own-plan">Make a different plan</button>
    </div>`;
  box.hidden = false;
  $('#picker').hidden = true;
  drawMap('shared-map', plan, null);
  $('#own-plan').addEventListener('click', () => {
    box.hidden = true;
    $('#picker').hidden = false;
    history.replaceState(null, '', location.pathname);
  });
}

// ---------- Boot ----------
function init() {
  const prefs = loadPrefs();
  if (prefs.mood) state.mood = moodById(prefs.mood).id;
  ['mode', 'radius', 'style'].forEach((k) => prefs[k] && setRadio(k, prefs[k]));
  $('#veggie').checked = !!prefs.veggie;
  if (prefs.origin?.lat != null) setOrigin(prefs.origin, prefs.originLabel || 'your last area');

  renderMoods();
  $('#ready').value = defaultReadyTime();

  $('#locate').addEventListener('click', useLocation);
  $('#area-go').addEventListener('click', doAreaSearch);
  $('#area').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doAreaSearch(); }
  });
  $('#picker').addEventListener('submit', onSubmit);
  $('#picker').addEventListener('change', savePrefs);

  renderShared();
  window.addEventListener('hashchange', renderShared);
}

init();
