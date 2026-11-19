// Pure logic: moods, opening hours, scoring, picking and evening planning.
// No DOM, no network — so it can be tested with `node --test`.

// ---------- Moods ----------

const has = (p, ...cuisines) => cuisines.some((c) => p.cuisines.includes(c));
const isVeg = (p) =>
  /^(yes|only)$/.test(p.tags['diet:vegetarian'] || '') ||
  /^(yes|only)$/.test(p.tags['diet:vegan'] || '') ||
  has(p, 'vegetarian', 'vegan');

export const MOODS = [
  {
    id: 'surprise', name: 'Surprise us', blurb: 'Anything good nearby',
    match: () => 0.6,
  },
  {
    id: 'cosy', name: 'Cosy & comforting', blurb: 'Tascas, pasta, warm bowls',
    match: (p) => p.kind === 'fast_food' ? 0.2
      : has(p, 'portuguese', 'regional', 'tasca', 'petiscos', 'italian', 'pizza', 'ramen', 'noodle', 'indian', 'french', 'german', 'spanish') ? 1 : 0.3,
  },
  {
    id: 'date', name: 'Date night', blurb: 'Candles, wine, no trays',
    match: (p) => p.kind === 'fast_food' ? 0
      : has(p, 'french', 'italian', 'japanese', 'sushi', 'wine', 'mediterranean', 'seafood', 'fine_dining', 'steak_house', 'tapas', 'fusion', 'greek', 'lebanese') ? 1
      : has(p, 'burger', 'kebab', 'chicken', 'sandwich', 'fast_food') ? 0.1 : 0.4,
  },
  {
    id: 'cheap', name: 'Cheap & cheerful', blurb: 'Full belly, light wallet',
    match: (p) => p.kind === 'fast_food' ? 1
      : has(p, 'kebab', 'pizza', 'burger', 'chinese', 'sandwich', 'chicken', 'noodle', 'nepalese', 'indian', 'portuguese', 'tasca', 'friture', 'bakery') ? 0.8 : 0.25,
  },
  {
    id: 'new', name: 'Something new', blurb: 'A cuisine we never pick',
    // Rarity bonus is added in rankPlaces; this just favours unusual cuisines.
    match: (p) => p.cuisines.length === 0 ? 0.1
      : has(p, 'pizza', 'burger', 'portuguese', 'italian', 'regional', 'chinese', 'sandwich', 'coffee_shop', 'kebab') ? 0.2 : 0.9,
  },
  {
    id: 'veggie', name: 'Green & light', blurb: 'Veggie-friendly, fresh',
    match: (p) => isVeg(p) ? 1
      : has(p, 'salad', 'poke', 'healthy', 'juice', 'middle_eastern', 'lebanese', 'falafel', 'indian', 'vietnamese') ? 0.7 : 0.1,
  },
  {
    id: 'group', name: 'Big table', blurb: 'Sharing plates for the gang',
    match: (p) => (has(p, 'tapas', 'petiscos', 'pizza', 'korean', 'barbecue', 'churrasco', 'brazilian', 'mexican', 'chinese', 'spanish', 'steak_house', 'portuguese') ? 0.8 : 0.3)
      + (p.tags.outdoor_seating === 'yes' ? 0.1 : 0) + (p.tags.reservation === 'yes' ? 0.1 : 0),
  },
  {
    id: 'seafood', name: 'Fish & seafood', blurb: 'Grilled fish, sushi, mariscos',
    match: (p) => has(p, 'seafood', 'fish', 'sushi', 'fish_and_chips', 'marisqueira', 'poke') ? 1
      : has(p, 'portuguese', 'japanese', 'regional') ? 0.4 : 0.05,
  },
];

export const moodById = (id) => MOODS.find((m) => m.id === id) || MOODS[0];

// ---------- Geometry & travel ----------

export function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Rough door-to-door estimates; straight-line distance × detour factor.
export const TRAVEL_MODES = {
  walk: { label: 'Walking', perMin: 80, overhead: 0 },
  transit: { label: 'Public transport', perMin: 300, overhead: 10 },
  car: { label: 'Car / Uber', perMin: 400, overhead: 8 },
};

export function travelMinutes(meters, mode = 'walk') {
  const m = TRAVEL_MODES[mode] || TRAVEL_MODES.walk;
  // Walking short hops never needs a bus.
  if (mode !== 'walk' && meters < 700) return travelMinutes(meters, 'walk');
  return Math.max(1, Math.ceil(m.overhead + (meters * 1.3) / m.perMin));
}

// ---------- Time helpers ----------

export const addMin = (date, min) => new Date(date.getTime() + min * 60000);

export function roundUpToQuarter(date) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  const rem = d.getMinutes() % 15;
  if (rem) d.setMinutes(d.getMinutes() + 15 - rem);
  return d;
}

export const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function todayAt(time, now = new Date()) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d;
}

// ---------- Opening hours (common subset of the OSM opening_hours syntax) ----------
// Returns a 7-element array (index 0 = Sunday) of [startMin, endMin] ranges,
// where endMin may exceed 1440 for places open past midnight.
// Returns null when the string uses syntax we don't understand — callers treat that as "unknown".

const DAY_INDEX = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const DAY_RE = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';

function parseDays(sel) {
  const days = new Set();
  for (const part of sel.split(',')) {
    const m = part.trim().match(new RegExp(`^(${DAY_RE})(?:-(${DAY_RE}))?$`));
    if (!m) return null;
    const a = DAY_INDEX[m[1]];
    const b = m[2] ? DAY_INDEX[m[2]] : a;
    // Ranges wrap around the week (e.g. Sa-Mo) and run in OSM order Mo..Su.
    let i = a;
    for (let n = 0; n < 7; n++) {
      days.add(i);
      if (i === b) break;
      i = (i + 1) % 7;
    }
  }
  return days;
}

function parseTimes(sel) {
  const ranges = [];
  for (const part of sel.split(',')) {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(\+?)$/);
    if (m) {
      const start = +m[1] * 60 + +m[2];
      let end = +m[3] * 60 + +m[4];
      if (end <= start) end += 1440; // past midnight (also "24:00" stays 1440)
      ranges.push([start, end]);
      continue;
    }
    const open = part.trim().match(/^(\d{1,2}):(\d{2})\+$/); // "19:00+" open-ended
    if (open) {
      const start = +open[1] * 60 + +open[2];
      ranges.push([start, start + 180]);
      continue;
    }
    return null;
  }
  return ranges;
}

export function parseOpeningHours(str) {
  try { return parseOH(str); } catch { return null; }
}

function parseOH(str) {
  if (!str || typeof str !== 'string') return null;
  let s = str.replace(/"[^"]*"/g, '').trim();
  if (!s) return null;
  if (/^24\/7$/.test(s)) return Array.from({ length: 7 }, () => [[0, 1440]]);
  // Anything with months, weeks, sunrise, nth weekdays etc. is beyond this parser.
  if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|week|sunrise|sunset|dawn|dusk|easter)\b|\[/.test(s)) return null;

  const schedule = Array.from({ length: 7 }, () => []);
  // ";" (and "||") override; ", " before a day selector adds an extra rule.
  const rules = s.split(/;|\|\|/).map((r) => r.trim()).filter(Boolean);
  for (const ruleGroup of rules) {
    const parts = ruleGroup.split(new RegExp(`,\\s*(?=(?:${DAY_RE}|PH|SH)\\b)`));
    parts.forEach((rule, idx) => {
      rule = rule.trim();
      if (/^(PH|SH)\b/.test(rule)) return; // holidays: can't know, ignore
      rule = rule.replace(/,\s*PH\b/, '');
      const m = rule.match(new RegExp(`^((?:${DAY_RE}(?:-${DAY_RE})?)(?:\\s*,\\s*${DAY_RE}(?:-${DAY_RE})?)*)?\\s*(.*)$`));
      if (!m) throw new Error('bad');
      const days = m[1] ? parseDays(m[1].replace(/\s/g, '')) : new Set([0, 1, 2, 3, 4, 5, 6]);
      if (!days) throw new Error('bad');
      const rest = m[2].trim().replace(/\s+open$/, '');
      const additive = idx > 0;
      let ranges;
      if (/^(off|closed)$/i.test(rest)) ranges = [];
      else if (rest === '24/7' || rest === '00:00-24:00') ranges = [[0, 1440]];
      else ranges = parseTimes(rest);
      if (ranges === null) throw new Error('bad');
      for (const d of days) schedule[d] = additive ? schedule[d].concat(ranges) : ranges.slice();
    });
  }
  return schedule;
}

/**
 * Status of a place at a given moment.
 * open:    { state: 'open', minutesLeft }
 * closed:  { state: 'closed', opensInMin }   (opensInMin null if not today)
 * unknown: { state: 'unknown' }
 */
export function statusAt(openingHours, date) {
  const schedule = typeof openingHours === 'string' ? parseOpeningHours(openingHours) : openingHours;
  if (!schedule) return { state: 'unknown' };
  const day = date.getDay();
  const prev = (day + 6) % 7;
  const m = date.getHours() * 60 + date.getMinutes();
  for (const [s, e] of schedule[day]) {
    if (m >= s && m < e) return { state: 'open', minutesLeft: e - m };
  }
  for (const [, e] of schedule[prev]) {
    if (e > 1440 && m < e - 1440) return { state: 'open', minutesLeft: e - 1440 - m };
  }
  const later = schedule[day].map(([s]) => s).filter((s) => s > m).sort((a, b) => a - b);
  return { state: 'closed', opensInMin: later.length ? later[0] - m : null };
}

// ---------- OSM element → place ----------

export function toPlace(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const cuisines = (t.cuisine || '')
    .toLowerCase().split(/[;,]/).map((c) => c.trim().replace(/\s+/g, '_')).filter(Boolean);
  const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
  return {
    id: `${el.type}/${el.id}`,
    name: t.name || '',
    lat, lon,
    kind: t.amenity || (t.place === 'square' ? 'square' : t.leisure || t.tourism || 'spot'),
    cuisines,
    address: [street, t['addr:city']].filter(Boolean).join(', '),
    website: t.website || t['contact:website'] || '',
    phone: t.phone || t['contact:phone'] || '',
    openingHours: t.opening_hours || '',
    tags: t,
  };
}

export const RESTAURANT_KINDS = new Set(['restaurant', 'fast_food', 'food_court']);
export const MEET_KINDS = new Set(['bar', 'pub', 'cafe', 'biergarten', 'square']);

export function prettyCuisine(p) {
  if (!p.cuisines.length) return p.kind === 'fast_food' ? 'Quick bites' : 'Restaurant';
  return p.cuisines.slice(0, 2)
    .map((c) => c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()))
    .join(' / ');
}

// ---------- Ranking & picking ----------

/**
 * Score every restaurant for this mood and time. Places known to be closed
 * (and not opening within 90 min of arrival) are dropped.
 */
export function rankPlaces(places, { mood = 'surprise', origin, radius, readyAt, mode = 'walk', veggieOnly = false, exclude = new Set() }) {
  const m = moodById(mood);
  const named = places.filter((p) => p.name && RESTAURANT_KINDS.has(p.kind) && !exclude.has(p.id));
  const pool = veggieOnly ? named.filter((p) => isVeg(p) || has(p, 'indian', 'middle_eastern', 'lebanese', 'falafel')) : named;

  // Cuisine frequency for the "something new" rarity bonus.
  const freq = {};
  for (const p of pool) for (const c of p.cuisines) freq[c] = (freq[c] || 0) + 1;

  const out = [];
  for (const p of pool) {
    const dist = distanceM(origin, p);
    if (dist > radius * 1.05) continue;
    const arrive = roundUpToQuarter(addMin(readyAt, travelMinutes(dist, mode)));
    const status = statusAt(p.openingHours, arrive);
    if (status.state === 'closed' && !(status.opensInMin != null && status.opensInMin <= 90)) continue;
    if (status.state === 'open' && status.minutesLeft < 60) continue; // kitchen closing

    const fit = m.match(p);
    let score = fit * 40;
    score += (1 - dist / radius) * 18;
    score += (p.openingHours ? 6 : 0) + (p.website ? 4 : 0) + (p.cuisines.length ? 4 : 0) + (p.phone ? 2 : 0);
    if (status.state === 'open') score += 8;
    if (status.state === 'closed') score -= 4; // opens a bit later: fine, but plan a drink first
    if (mood === 'new' && p.cuisines.length) {
      const rarest = Math.min(...p.cuisines.map((c) => freq[c] || 1));
      score += Math.max(0, 20 - (rarest - 1) * 6);
    }
    out.push({ place: p, score, fit, dist, status, arrive });
  }
  out.sort((a, b) => b.score - a.score);

  // If the mood barely matches anything here, say so rather than return junk.
  const goodFits = out.filter((r) => r.fit >= 0.7).length;
  return { ranked: out, thinMatch: mood !== 'surprise' && goodFits < 3 };
}

/** Weighted random pick from the top of the ranking — the best places are likelier, never certain. */
export function pick(ranked, rng = Math.random, topN = 10) {
  const top = ranked.slice(0, topN);
  if (!top.length) return null;
  const min = Math.min(...top.map((r) => r.score));
  const weights = top.map((r) => (r.score - min + 6) ** 2);
  let x = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < top.length; i++) {
    x -= weights[i];
    if (x <= 0) return top[i];
  }
  return top[top.length - 1];
}

/** Three options for the group, preferring different cuisines. */
export function shortlist(ranked, rng = Math.random, n = 3) {
  const picks = [];
  let pool = ranked.slice(0, 15);
  while (picks.length < n && pool.length) {
    const p = pick(pool, rng, pool.length);
    picks.push(p);
    const cuis = p.place.cuisines[0];
    const rest = pool.filter((r) => r !== p);
    const varied = rest.filter((r) => !cuis || r.place.cuisines[0] !== cuis);
    pool = varied.length ? varied : rest;
  }
  return picks;
}

// ---------- The evening plan ----------

/**
 * style: 'auto' | 'straight' | 'drinks'
 * auto → meet at the restaurant, unless it isn't open yet when you'd arrive,
 *        in which case meet for a drink nearby until it opens.
 */
export function planEvening({ origin, place, readyAt, mode = 'walk', style = 'auto', meetSpots = [] }) {
  const toRestaurant = travelMinutes(distanceM(origin, place), mode);
  const arriveAtRestaurant = roundUpToQuarter(addMin(readyAt, toRestaurant));
  const statusOnArrival = statusAt(place.openingHours, arriveAtRestaurant);

  const notOpenYet = statusOnArrival.state === 'closed' && statusOnArrival.opensInMin != null;
  const drinksFirst = style === 'drinks' || (style === 'auto' && notOpenYet);

  if (!drinksFirst) {
    return {
      type: 'straight', place, meetSpot: null,
      leaveAt: readyAt, travelMin: toRestaurant,
      meetAt: arriveAtRestaurant, dinnerAt: arriveAtRestaurant,
      status: statusOnArrival, reason: null,
    };
  }

  const spot = chooseMeetSpot(place, meetSpots, arriveAtRestaurant);
  const meetLoc = spot || place;
  const travelMin = travelMinutes(distanceM(origin, meetLoc), mode);
  const meetAt = roundUpToQuarter(addMin(readyAt, travelMin));
  const walkMin = spot ? travelMinutes(distanceM(spot, place), 'walk') : 0;

  let dinnerAt = roundUpToQuarter(addMin(meetAt, 45));
  if (notOpenYet) {
    const opens = roundUpToQuarter(addMin(arriveAtRestaurant, statusOnArrival.opensInMin));
    if (style === 'auto' || opens > dinnerAt) dinnerAt = opens;
    if (dinnerAt - meetAt < 30 * 60000) dinnerAt = roundUpToQuarter(addMin(meetAt, 30));
  }

  return {
    type: 'drinks', place, meetSpot: spot,
    leaveAt: readyAt, travelMin,
    meetAt, dinnerAt, walkMin,
    status: statusAt(place.openingHours, dinnerAt),
    reason: notOpenYet ? 'opens-later' : 'chosen',
  };
}

function chooseMeetSpot(place, spots, at) {
  const scored = [];
  for (const s of spots) {
    if (!s.name || s.id === place.id) continue;
    const d = distanceM(s, place);
    if (d > 500) continue;
    const st = statusAt(s.openingHours, at);
    if (st.state === 'closed') continue;
    let score = -d / 10; // closer is better
    if (s.kind === 'bar' || s.kind === 'pub' || s.kind === 'biergarten') score += 30;
    else if (s.kind === 'cafe') score += 12;
    else if (s.kind === 'square') score += 8;
    if (st.state === 'open') score += 10;
    scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.s || null;
}

// ---------- Sharing ----------

export function mapsLink(p) {
  const q = p.address ? `${p.name}, ${p.address}` : `${p.name} ${p.lat},${p.lon}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export function shareText(plan, link) {
  const r = plan.place;
  const lines = [`🍽️ Onde vamos jantar? Sorted.`, ``, `${r.name} (${prettyCuisine(r)})`];
  if (plan.type === 'drinks' && plan.meetSpot) {
    lines.push(`🍷 Meet ${hhmm(plan.meetAt)} at ${plan.meetSpot.name}`);
    lines.push(`   ${mapsLink(plan.meetSpot)}`);
    lines.push(`🍽️ Dinner ${hhmm(plan.dinnerAt)}, ${plan.walkMin} min walk from there`);
  } else {
    lines.push(`🕖 Meet there at ${hhmm(plan.meetAt)}`);
  }
  lines.push(`📍 ${mapsLink(r)}`);
  if (r.phone) lines.push(`📞 ${r.phone}`);
  if (link) lines.push(``, link);
  return lines.join('\n');
}

export function shortlistText(options) {
  const lines = ['🍽️ Onde vamos jantar? Reply 1, 2 or 3:', ''];
  options.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.place.name} (${prettyCuisine(o.place)}), ${Math.round(o.dist / 100) / 10} km`);
    lines.push(`   ${mapsLink(o.place)}`);
  });
  return lines.join('\n');
}

// Compact plan encoded in the URL hash so a shared link re-opens the plan.
export function encodePlan(plan, mood) {
  const pt = (p) => p && { n: p.name, a: p.lat, o: p.lon, c: p.cuisines, d: p.address, k: p.kind, p: p.phone, h: p.openingHours };
  const data = {
    v: 1, m: mood, t: plan.type, r: pt(plan.place), s: pt(plan.meetSpot),
    mt: plan.meetAt.toISOString(), dt: plan.dinnerAt.toISOString(), w: plan.walkMin || 0,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePlan(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const d = JSON.parse(new TextDecoder().decode(bytes));
    if (d.v !== 1 || !d.r) return null;
    const pl = (x) => x && {
      id: '', name: x.n, lat: x.a, lon: x.o, cuisines: x.c || [], address: x.d || '',
      kind: x.k, phone: x.p || '', openingHours: x.h || '', website: '', tags: {},
    };
    return {
      mood: d.m,
      plan: {
        type: d.t, place: pl(d.r), meetSpot: pl(d.s),
        meetAt: new Date(d.mt), dinnerAt: new Date(d.dt), walkMin: d.w,
      },
    };
  } catch {
    return null;
  }
}
