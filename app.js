import {
  MOODS, moodById, rankPlaces, pick, shortlist, planEvening, hhmm, todayAt, addMin,
  roundUpToQuarter, prettyCuisine, mapsLink, shareText, shortlistText, encodePlan, decodePlan,
  statusAt, TRAVEL_MODES, KIND_PT, km,
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
  loading: false,
  busy: false,
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

// ---------- Onde ----------
function setOrigin(origin, label) {
  state.origin = origin;
  state.originLabel = label;
  state.data = null;
  $('#where-label').textContent = label;
  $('#where-set').hidden = false;
  $('#where-pick').hidden = true;
  $('#area-results').hidden = true;
  setStatus('#where-status', '');
  setStatus('#go-status', '');
  savePrefs();
  prefetch();
}

function changeWhere() {
  $('#where-set').hidden = true;
  $('#where-pick').hidden = false;
  $('#area').focus();
}

async function useLocation() {
  const btn = $('#locate');
  btn.disabled = true;
  setStatus('#where-status', 'A procurar-te…');
  try {
    const pos = await getPosition();
    setOrigin(pos, 'a tua localização');
    reverseName(pos).then((name) => {
      if (state.origin === pos) {
        state.originLabel = name;
        $('#where-label').textContent = name;
        savePrefs();
      }
    });
  } catch (err) {
    setStatus('#where-status', err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function doAreaSearch() {
  const q = $('#area').value.trim();
  const list = $('#area-results');
  if (!q) { $('#area').focus(); return; }
  setStatus('#where-status', 'A procurar…');
  try {
    const results = await searchArea(q);
    if (!results.length) {
      setStatus('#where-status', `Não encontrámos “${q}”. Experimenta juntar a cidade, ex.: “${q}, Lisboa”.`, 'err');
      list.hidden = true;
      return;
    }
    if (results.length === 1) { setOrigin(results[0], results[0].label); return; }
    setStatus('#where-status', 'Qual destes?');
    list.innerHTML = results.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.label)}</button></li>`).join('');
    list.hidden = false;
    list.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const r = results[+b.dataset.i];
      setOrigin(r, r.label);
    }));
    list.querySelector('button').focus();
  } catch (err) {
    setStatus('#where-status', err.message || 'A pesquisa falhou. Verifica a ligação.', 'err');
  }
}

// Start loading places as soon as we know where, so "Escolher" is usually instant.
function prefetch() {
  if (!state.origin) return;
  fetchPlaces(state.origin, +radioValue('radius'), onFetchProgress).catch(() => { /* reported on submit */ });
}
function onFetchProgress(msg) {
  if (state.loading) setStatus('#go-status', msg);
}

// ---------- Quando ----------
function roundUpToHalf(date) {
  const d = roundUpToQuarter(date);
  if (d.getMinutes() % 30) d.setMinutes(d.getMinutes() + 15);
  return d;
}

function renderTimeChips() {
  const now = new Date();
  let t = todayAt('19:00', now);
  const soon = roundUpToHalf(addMin(now, 20));
  if (soon > t) t = soon;
  const slots = [0, 1, 2, 3].map((i) => hhmm(addMin(t, 30 * i)));
  const chips = [{ value: 'now', label: 'Já' }, ...slots.map((s) => ({ value: s, label: s }))];
  const wrap = $('#time-chips');
  wrap.innerHTML = chips.map((c) => `
    <label><input type="radio" name="when" value="${c.value}"><span>${c.label}</span></label>`).join('');

  const input = $('#ready');
  wrap.addEventListener('change', (e) => {
    const v = e.target.value;
    input.value = v === 'now' ? hhmm(new Date()) : v;
  });
  input.addEventListener('input', () => {
    const match = wrap.querySelector(`input[value="${input.value}"]`);
    wrap.querySelectorAll('input').forEach((i) => { i.checked = i === match; });
  });

  const def = slots.includes('19:30') ? '19:30' : slots[0];
  wrap.querySelector(`input[value="${def}"]`).checked = true;
  input.value = def;
}

function readyAtFromInput() {
  const now = new Date();
  if (radioValue('when') === 'now' || !$('#ready').value) return now;
  let t = todayAt($('#ready').value, now);
  // "00:30" escolhido às 23:00 é esta noite, não esta manhã.
  if (now - t > 3 * 3600000) t = addMin(t, 1440);
  return t < now ? now : t;
}

// ---------- Mais opções ----------
const STYLE_LABEL = { auto: 'no restaurante', drinks: 'primeiro um copo', straight: 'direto ao jantar' };
const MODE_LABEL = { walk: 'A pé', transit: 'Metro / autocarro', car: 'Carro / Uber' };
function updateMoreSummary() {
  const parts = [
    MODE_LABEL[radioValue('mode')],
    `até ${+radioValue('radius') / 1000} km`,
    STYLE_LABEL[radioValue('style')],
  ];
  if ($('#veggie').checked) parts.push('vegetariano');
  $('#more-summary').textContent = parts.join(', ');
}

// ---------- Escolher ----------
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

function setStatus(sel, text, kind = '') {
  const el = $(sel);
  el.className = `status${kind ? ` ${kind}` : ''}`;
  el.textContent = text;
}

function setLoading(on) {
  state.loading = on;
  const go = $('#go');
  go.disabled = on;
  go.classList.toggle('loading', on);
  go.setAttribute('aria-busy', on);
  $('#go .go-label').textContent = on ? 'A procurar…' : 'Escolher por nós';
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.loading) return;
  if (!state.origin) {
    setStatus('#go-status', 'Primeiro diz onde estás: usa a localização ou escreve uma zona.', 'err');
    $('#where-h').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    $('#locate').focus({ preventScroll: true });
    return;
  }
  setLoading(true);
  setStatus('#go-status', '');
  savePrefs();
  try {
    state.data = await fetchPlaces(state.origin, +radioValue('radius'), onFetchProgress);
    state.readyAt = readyAtFromInput();
    state.vetoed = new Set();
    rerank();
    setStatus('#go-status', '');
    if (!state.ranked.length) {
      const dist = `${+radioValue('radius') / 1000} km`;
      setStatus('#go-status', state.data.restaurants.length
        ? `Nada aberto num raio de ${dist} por volta das ${hhmm(state.readyAt)}${$('#veggie').checked ? ' com opções vegetarianas' : ''}. Tenta uma distância maior ou outra hora.`
        : `Não há restaurantes no mapa a menos de ${dist} de ${state.originLabel}. Tenta uma distância maior.`, 'err');
      $('#result').hidden = true;
      return;
    }
    setLoading(false);
    await choose(pick(state.ranked));
  } catch (err) {
    setStatus('#go-status', err.message, 'err');
  } finally {
    setLoading(false);
  }
}

async function choose(choice, { roll = true } = {}) {
  state.busy = true;
  try {
    state.plan = makePlan(choice);
    await renderResult(state.plan, choice, roll);
  } finally {
    state.busy = false;
  }
}

async function pickAnother() {
  if (state.busy) return;
  if (state.plan) state.vetoed.add(state.plan.place.id);
  rerank();
  if (!state.ranked.length) {
    toast('Já não há mais sítios que encaixem. Tenta uma distância maior ou outro ambiente.');
    state.vetoed = new Set();
    rerank();
    return;
  }
  await choose(pick(state.ranked));
}

// ---------- Resultado ----------
function badgeFor(plan) {
  const st = plan.status || { state: 'unknown' };
  if (st.state === 'open') return `<span class="badge open">Aberto até às ${hhmm(addMin(plan.dinnerAt, st.minutesLeft))}</span>`;
  if (st.state === 'closed' && st.opensInMin != null) return `<span class="badge">Abre às ${hhmm(addMin(plan.dinnerAt, st.opensInMin))}</span>`;
  return `<span class="badge">Sem horário no mapa${plan.place.phone ? ': liga antes' : ''}</span>`;
}

function boardRows(plan, { withLeave = true } = {}) {
  const r = plan.place;
  const rows = [];
  const row = (time, title, sub) => `<li><time>${hhmm(time)}</time><span class="what">${title}<small>${sub}</small></span></li>`;
  if (withLeave && plan.leaveAt) {
    const mode = radioValue('mode');
    const how = mode !== 'walk' && plan.travelMin <= 12 ? 'a pé' : (TRAVEL_MODES[mode] || TRAVEL_MODES.walk).label;
    rows.push(row(plan.leaveAt, 'Saída', `Cerca de ${plan.travelMin} min ${how}`));
  }
  if (plan.type === 'drinks' && plan.meetSpot) {
    const s = plan.meetSpot;
    rows.push(row(plan.meetAt, `Encontro: ${esc(s.name)}`,
      `${KIND_PT[s.kind] || 'Ponto de encontro'}, a ${plan.walkMin} min a pé do jantar. <a href="${esc(mapsLink(s))}" target="_blank" rel="noopener">Mapa</a>`));
    rows.push(row(plan.dinnerAt, `Jantar: ${esc(r.name)}`, esc(r.address || prettyCuisine(r))));
  } else if (plan.type === 'drinks') {
    rows.push(row(plan.meetAt, `Encontro à porta`, 'Não há bares perto no mapa, encontram-se à porta do restaurante'));
    rows.push(row(plan.dinnerAt, `Jantar: ${esc(r.name)}`, esc(r.address || prettyCuisine(r))));
  } else {
    rows.push(row(plan.meetAt, `Encontro: ${esc(r.name)}`, esc(r.address || 'Direto ao jantar')));
  }
  return `<ol class="board">${rows.join('')}</ol>`;
}

function shareLink(plan) {
  // Um link só ajuda os amigos se a app estiver alojada num sítio que eles consigam abrir.
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

  const notes = [];
  if (plan.reason === 'opens-later') notes.push(`${esc(r.name)} só abre às ${hhmm(plan.dinnerAt)}, por isso encontram-se primeiro para um copo.`);
  if (state.data?.source === 'nominatim') notes.push('O servidor principal do mapa estava ocupado, por isso a lista de opções é mais pequena. Tenta mais tarde para teres mais escolha.');
  if (state.thinMatch) notes.push(`Não há muitos sítios de “${esc(mood.name.toLowerCase())}” por aqui, por isso este é o que mais se aproxima.`);

  state.map?.remove();
  state.map = null;
  box.innerHTML = `
    <div class="ticket-head">
      <p class="kicker">${esc(mood.name)}, a ${km(choice.dist)} km</p>
      <h2 class="place-name" id="place-name">${esc(r.name)}</h2>
      <p class="place-meta">${esc(prettyCuisine(r))}${r.address ? `, ${esc(r.address)}` : ''}</p>
      ${badgeFor(plan)}
    </div>
    ${boardRows(plan)}
    ${notes.map((n) => `<p class="note">${n}</p>`).join('')}
    <div class="map" id="map" role="img" aria-label="Mapa com o restaurante${plan.meetSpot ? ' e o ponto de encontro' : ''}"></div>
    <div class="actions">
      <button type="button" class="btn btn-send" id="send">Enviar para o grupo</button>
      <div class="row">
        <button type="button" class="btn btn-outline" id="another">Escolher outro</button>
        <button type="button" class="btn btn-outline" id="three">Pôr a votos</button>
      </div>
      <div class="row">
        <a class="btn btn-outline" href="${esc(reviewsLink(r))}" target="_blank" rel="noopener">Ver avaliações</a>
        <button type="button" class="btn btn-outline" id="copy">Copiar plano</button>
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
  return `https://www.google.com/search?q=${encodeURIComponent(`${p.name} ${p.address || state.originLabel} avaliações`)}`;
}

function renderShortlist() {
  const box = $('#shortlist');
  const pool = state.ranked.filter((x) => x.place.id !== state.plan.place.id);
  const current = state.ranked.find((x) => x.place.id === state.plan.place.id);
  const options = [current, ...shortlist(pool, Math.random, 2)].filter(Boolean);
  box.innerHTML = `
    <h3>Três opções para o grupo</h3>
    <ol>${options.map((o, i) => `
      <li><button type="button" data-i="${i}"><span class="num">${i + 1}</span>
        <span><strong>${esc(o.place.name)}</strong><small>${esc(prettyCuisine(o.place))}, a ${km(o.dist)} km. Toca para escolher este</small></span>
      </button></li>`).join('')}
    </ol>
    <button type="button" class="btn btn-send btn-block" id="send-three">Enviar as 3 opções</button>`;
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
  if (origin) dot(origin, '#ffffff', 'Tu', 6);
  if (plan.meetSpot) dot(plan.meetSpot, cobalt, plan.meetSpot.name, 8);
  dot(plan.place, '#FFC21A', plan.place.name, 11);
  if (pts.length > 1) map.fitBounds(pts, { padding: [28, 28], maxZoom: 17 });
  else map.setView(pts[0], 16);
  if (id === 'map') state.map = map;
}

// ---------- Partilhar ----------
async function share(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Plano copiado. Cola-o no grupo.');
  } catch {
    window.prompt('Copia isto:', text);
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

// ---------- Plano recebido por link ----------
function renderShared() {
  const m = location.hash.match(/^#p=(.+)$/);
  if (!m) return;
  const decoded = decodePlan(m[1]);
  if (!decoded) return;
  const { plan } = decoded;
  const r = plan.place;
  plan.status = statusAt(r.openingHours, plan.dinnerAt);
  const box = $('#shared');
  const day = plan.dinnerAt.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });
  box.innerHTML = `
    <div class="ticket-head">
      <p class="kicker">O plano para ${esc(day)}</p>
      <h2 class="place-name">${esc(r.name)}</h2>
      <p class="place-meta">${esc(prettyCuisine(r))}${r.address ? `, ${esc(r.address)}` : ''}</p>
      ${badgeFor(plan)}
    </div>
    ${boardRows(plan, { withLeave: false })}
    <div class="map" id="shared-map" role="img" aria-label="Mapa do plano"></div>
    <div class="actions">
      <a class="btn btn-send" href="${esc(mapsLink(plan.meetSpot || r))}" target="_blank" rel="noopener">Como chegar a ${esc((plan.meetSpot || r).name)}</a>
      <button type="button" class="btn btn-outline" id="own-plan">Fazer outro plano</button>
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

// ---------- Arranque ----------
function init() {
  const prefs = loadPrefs();
  if (prefs.mood) state.mood = moodById(prefs.mood).id;
  ['mode', 'radius', 'style'].forEach((k) => prefs[k] && setRadio(k, prefs[k]));
  $('#veggie').checked = !!prefs.veggie;

  renderMoods();
  renderTimeChips();
  updateMoreSummary();

  $('#locate').addEventListener('click', useLocation);
  $('#where-change').addEventListener('click', changeWhere);
  $('#area-go').addEventListener('click', doAreaSearch);
  $('#area').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doAreaSearch(); }
  });
  $('#picker').addEventListener('submit', onSubmit);
  $('#picker').addEventListener('change', (e) => {
    savePrefs();
    updateMoreSummary();
    if (e.target.name === 'radius') prefetch();
  });

  if (prefs.origin?.lat != null) setOrigin(prefs.origin, prefs.originLabel || 'a última zona');

  renderShared();
  window.addEventListener('hashchange', renderShared);
}

init();
