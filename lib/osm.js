// Free, keyless OpenStreetMap services: Overpass (places) and Nominatim (area search).
import { toPlace, RESTAURANT_KINDS, MEET_KINDS } from './planner.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Small cache so re-rolls and mood changes don't hit the servers again.
const cache = new Map();

/**
 * Restaurants within `radius` metres, plus bars/cafés/squares a little further
 * out (meeting points). Uses the public Overpass servers; if they're all busy,
 * falls back to Nominatim (fewer results, same OpenStreetMap data).
 */
export function fetchPlaces({ lat, lon }, radius, onProgress = () => {}) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${radius}`;
  // Cache the promise, so a background prefetch and a button press share one request.
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    try {
      return await fromOverpass(lat, lon, radius);
    } catch (overpassErr) {
      onProgress('O servidor principal do mapa está ocupado, a tentar o de reserva…');
      try {
        return await fromNominatim(lat, lon, radius);
      } catch {
        throw new Error(`Não foi possível contactar os servidores do OpenStreetMap (${overpassErr.message}). Espera um minuto e tenta outra vez.`);
      }
    }
  })();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

function split(elements, source) {
  const all = elements.map(toPlace).filter(Boolean);
  return {
    source,
    restaurants: all.filter((p) => RESTAURANT_KINDS.has(p.kind)),
    meetSpots: all.filter((p) => MEET_KINDS.has(p.kind)),
  };
}

async function fromOverpass(lat, lon, radius) {
  const a = `around:${Math.round(radius)},${lat},${lon}`;
  const b = `around:${Math.round(radius + 500)},${lat},${lon}`;
  // Exact tag matches are much cheaper for the server than regexes.
  const query = `[out:json][timeout:20];
(
  nwr["amenity"="restaurant"]["name"](${a});
  nwr["amenity"="fast_food"]["name"](${a});
  nwr["amenity"="bar"]["name"](${b});
  nwr["amenity"="pub"]["name"](${b});
  nwr["amenity"="cafe"]["name"](${b});
  nwr["place"="square"]["name"](${b});
);
out center tags;`;

  const deadline = Date.now() + 22000; // then give up and use the backup
  let lastErr = new Error('nenhum servidor respondeu');
  for (const url of OVERPASS) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      }, Math.min(left, 15000));
      if (!res.ok) throw new Error(res.status === 429 ? 'demasiados pedidos' : `servidor ocupado (HTTP ${res.status})`);
      const text = await res.text();
      if (!text.trim().startsWith('{')) throw new Error('servidor ocupado');
      return split(JSON.parse(text).elements, 'overpass');
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error('servidor demasiado lento') : err;
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nominatim allows ~1 request/second and returns at most 40 results per call.
async function fromNominatim(lat, lon, radius) {
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const viewbox = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map((n) => n.toFixed(5)).join(',');
  const base = `https://nominatim.openstreetmap.org/search?format=jsonv2&bounded=1&limit=40&extratags=1&addressdetails=1&viewbox=${viewbox}`;
  const elements = [];
  const seen = new Set();
  const run = async (amenity, pages) => {
    const exclude = [];
    for (let i = 0; i < pages; i++) {
      const url = `${base}&amenity=${amenity}${exclude.length ? `&exclude_place_ids=${exclude.join(',')}` : ''}`;
      const res = await fetchWithTimeout(url, {}, 12000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      for (const r of rows) {
        exclude.push(r.place_id);
        const key = `${r.osm_type}/${r.osm_id}`;
        if (seen.has(key) || !r.name) continue;
        seen.add(key);
        const ad = r.address || {};
        elements.push({
          type: r.osm_type, id: r.osm_id, lat: +r.lat, lon: +r.lon,
          tags: {
            ...(r.extratags || {}),
            name: r.name,
            amenity: r.type,
            'addr:street': ad.road, 'addr:housenumber': ad.house_number,
            'addr:city': ad.city || ad.town || ad.village,
          },
        });
      }
      await sleep(1100);
      if (rows.length < 40) break;
    }
  };
  await run('restaurant', 3);
  if (!elements.length) throw new Error('no results');
  for (const kind of ['fast_food', 'bar', 'cafe']) {
    try { await run(kind, 1); } catch { /* meeting spots are optional */ }
  }
  return split(elements, 'nominatim');
}

/** Look up a neighbourhood, street or city by name. */
export async function searchArea(text) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(text)}`;
  const res = await fetchWithTimeout(url, { headers: { 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.5' } }, 15000);
  if (!res.ok) throw new Error(`A pesquisa falhou (HTTP ${res.status}).`);
  const json = await res.json();
  return json.map((r) => ({
    lat: +r.lat,
    lon: +r.lon,
    label: r.display_name.split(',').slice(0, 3).join(',').trim(),
  }));
}

/** Short name for coordinates, e.g. "Chiado, Lisboa". Best-effort. */
export async function reverseName({ lat, lon }) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${lat}&lon=${lon}`;
    const res = await fetchWithTimeout(url, { headers: { 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.5' } }, 10000);
    const j = await res.json();
    const a = j.address || {};
    return [a.suburb || a.neighbourhood || a.quarter || a.road, a.city || a.town || a.village].filter(Boolean).join(', ') || 'a tua localização';
  } catch {
    return 'a tua localização';
  }
}

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Este browser não partilha a localização. Escreve uma zona.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.code === 1
        ? 'O acesso à localização está bloqueado. Autoriza nas definições do browser ou escreve uma zona.'
        : 'Não foi possível obter a localização. Escreve uma zona.')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
    );
  });
}
