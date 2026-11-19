import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOpeningHours, statusAt, roundUpToQuarter, hhmm, travelMinutes, toPlace,
  rankPlaces, pick, shortlist, planEvening, encodePlan, decodePlan, shareText, todayAt,
} from '../lib/planner.js';

// 2026-11-19 is a Thursday.
const thu = (t) => todayAt(t, new Date(2026, 10, 19));
const sat = (t) => todayAt(t, new Date(2026, 10, 21));

test('opening hours: simple weekday range', () => {
  assert.equal(statusAt('Tu-Sa 12:00-22:30', thu('19:00')).state, 'open');
  assert.equal(statusAt('Tu-Sa 12:00-22:30', thu('19:00')).minutesLeft, 210);
  assert.equal(statusAt('Mo-We 12:00-22:30', thu('19:00')).state, 'closed');
});

test('opening hours: split shifts and later opening', () => {
  const oh = 'Mo-Fr 12:00-15:00,19:30-23:00; Sa 19:00-23:30; Su off';
  const s = statusAt(oh, thu('19:00'));
  assert.deepEqual(s, { state: 'closed', opensInMin: 30 });
  assert.equal(statusAt(oh, thu('20:00')).state, 'open');
  assert.equal(statusAt(oh, sat('19:15')).state, 'open');
  assert.equal(statusAt(oh, todayAt('20:00', new Date(2026, 10, 22))).state, 'closed');
});

test('opening hours: past midnight carries into next day', () => {
  const oh = 'Th-Sa 18:00-02:00';
  assert.equal(statusAt(oh, thu('23:30')).state, 'open');
  assert.equal(statusAt(oh, todayAt('01:00', new Date(2026, 10, 20))).state, 'open');
  assert.equal(statusAt(oh, todayAt('01:00', new Date(2026, 10, 19))).state, 'closed'); // Wed night not open
});

test('opening hours: 24/7, additive comma rules, wrap-around days, PH ignored', () => {
  assert.equal(statusAt('24/7', thu('03:00')).state, 'open');
  assert.equal(statusAt('Mo-Fr 12:00-15:00, Sa 19:00-23:00', sat('20:00')).state, 'open');
  assert.equal(statusAt('Sa-Mo 19:00-23:00', todayAt('20:00', new Date(2026, 10, 22))).state, 'open');
  assert.equal(statusAt('Mo-Su 12:00-23:00; PH off', thu('20:00')).state, 'open');
  assert.equal(statusAt('12:00-23:00', thu('20:00')).state, 'open');
});

test('opening hours: unknown syntax is "unknown", never a crash', () => {
  for (const s of ['', 'Jan-Mar Mo-Fr 10:00-12:00', 'sunset-sunrise', 'by appointment', 'Mo[1] 10:00-12:00', null]) {
    assert.equal(statusAt(s, thu('20:00')).state, 'unknown', String(s));
  }
  assert.equal(parseOpeningHours('garbage;;;'), null);
});

test('time rounding and travel', () => {
  assert.equal(hhmm(roundUpToQuarter(thu('19:01'))), '19:15');
  assert.equal(hhmm(roundUpToQuarter(thu('19:15'))), '19:15');
  assert.equal(hhmm(roundUpToQuarter(thu('19:46'))), '20:00');
  assert.equal(travelMinutes(800, 'walk'), 13);
  assert.equal(travelMinutes(500, 'car'), travelMinutes(500, 'walk')); // short hop: walk
  assert.ok(travelMinutes(5000, 'transit') < travelMinutes(5000, 'walk'));
});

// --- Fixtures ---
const origin = { lat: 38.7104, lon: -9.1427 };
const el = (id, tags, dLat = 0.002, dLon = 0) => ({ type: 'node', id, lat: origin.lat + dLat, lon: origin.lon + dLon, tags });
const places = [
  el(1, { amenity: 'restaurant', name: 'Peixe', cuisine: 'seafood', opening_hours: 'Mo-Su 12:00-23:00', website: 'x' }),
  el(2, { amenity: 'restaurant', name: 'Tasca', cuisine: 'portuguese', opening_hours: 'Mo-Su 19:30-23:00' }, 0.003),
  el(3, { amenity: 'fast_food', name: 'Burger', cuisine: 'burger' }, 0.001),
  el(4, { amenity: 'restaurant', name: 'Closed Mon-Wed', cuisine: 'french', opening_hours: 'Mo-We 19:00-23:00' }),
  el(5, { amenity: 'restaurant', cuisine: 'italian' }), // no name
  el(6, { amenity: 'restaurant', name: 'Far Away', cuisine: 'sushi' }, 0.2),
  el(7, { amenity: 'restaurant', name: 'Ethiopian Spot', cuisine: 'ethiopian', opening_hours: 'Mo-Su 18:00-23:00' }, -0.002),
  el(8, { amenity: 'restaurant', name: 'Veg Heaven', cuisine: 'vegetarian', 'diet:vegan': 'yes' }, 0, 0.002),
  el(10, { amenity: 'restaurant', name: 'Marisqueira', cuisine: 'seafood' }, -0.001, 0.001),
  el(9, { amenity: 'restaurant', name: 'Closing Soon', cuisine: 'pizza', opening_hours: 'Mo-Su 12:00-19:30' }, 0, -0.002),
].map(toPlace);
const spots = [
  el(20, { amenity: 'bar', name: 'Bar Next Door', opening_hours: 'Mo-Su 17:00-02:00' }, 0.0032),
  el(21, { place: 'square', name: 'Praça' }, 0.0025),
  el(22, { amenity: 'cafe', name: 'Café Shut', opening_hours: 'Mo-Su 08:00-18:00' }, 0.003),
].map(toPlace);

test('ranking filters out unnamed, too far, closed and closing-soon places', () => {
  const { ranked } = rankPlaces(places, { mood: 'surprise', origin, radius: 1500, readyAt: thu('19:00') });
  const names = ranked.map((r) => r.place.name);
  assert.ok(names.includes('Peixe'));
  assert.ok(names.includes('Tasca'), 'opens 19:30, within 90 min: kept');
  assert.ok(!names.includes('Far Away'));
  assert.ok(!names.includes('Closed Mon-Wed'));
  assert.ok(!names.includes('Closing Soon'));
  assert.ok(!names.some((n) => !n));
});

test('mood shapes the ranking', () => {
  const opts = { origin, radius: 1500, readyAt: thu('19:00') };
  assert.equal(rankPlaces(places, { ...opts, mood: 'seafood' }).ranked[0].place.name, 'Peixe');
  assert.equal(rankPlaces(places, { ...opts, mood: 'veggie' }).ranked[0].place.name, 'Veg Heaven');
  assert.equal(rankPlaces(places, { ...opts, mood: 'new' }).ranked[0].place.name, 'Ethiopian Spot');
  const date = rankPlaces(places, { ...opts, mood: 'date' }).ranked;
  assert.ok(date.findIndex((r) => r.place.name === 'Burger') > 2);
  const veg = rankPlaces(places, { ...opts, veggieOnly: true }).ranked.map((r) => r.place.name);
  assert.deepEqual(veg, ['Veg Heaven']);
});

test('pick is weighted but respects exclusions (veto)', () => {
  const opts = { origin, radius: 1500, readyAt: thu('19:00'), mood: 'surprise' };
  const { ranked } = rankPlaces(places, opts);
  const seen = new Set();
  let i = 0;
  const rng = () => ((i++ * 0.137) % 1);
  for (let n = 0; n < 50; n++) seen.add(pick(ranked, rng).place.name);
  assert.ok(seen.size > 1, 'not always the same place');
  const vetoed = rankPlaces(places, { ...opts, exclude: new Set(['node/1']) }).ranked;
  assert.ok(!vetoed.some((r) => r.place.name === 'Peixe'));
  assert.equal(pick([], rng), null);
});

test('shortlist gives 3 distinct places', () => {
  const { ranked } = rankPlaces(places, { origin, radius: 1500, readyAt: thu('19:00') });
  const s = shortlist(ranked, () => 0.5);
  assert.equal(s.length, 3);
  assert.equal(new Set(s.map((x) => x.place.id)).size, 3);
});

test('plan: open restaurant → meet straight there', () => {
  const peixe = places[0];
  const plan = planEvening({ origin, place: peixe, readyAt: thu('19:00'), mode: 'walk', style: 'auto', meetSpots: spots });
  assert.equal(plan.type, 'straight');
  assert.equal(hhmm(plan.meetAt), '19:15'); // ~222 m walk → 4 min → round to 19:15
  assert.equal(plan.meetAt.getTime(), plan.dinnerAt.getTime());
});

test('plan: restaurant opens later → drink nearby first, dinner at opening', () => {
  const tasca = places[1]; // opens 19:30
  const plan = planEvening({ origin, place: tasca, readyAt: thu('18:50'), mode: 'walk', style: 'auto', meetSpots: spots });
  assert.equal(plan.type, 'drinks');
  assert.equal(plan.meetSpot.name, 'Bar Next Door'); // bar beats square; closed café skipped
  assert.equal(hhmm(plan.meetAt), '19:00');
  assert.equal(hhmm(plan.dinnerAt), '19:30');
  assert.equal(plan.reason, 'opens-later');
});

test('plan: forced drinks first adds ~45 min; no spots → meet outside restaurant', () => {
  const peixe = places[0];
  const plan = planEvening({ origin, place: peixe, readyAt: thu('19:00'), style: 'drinks', meetSpots: spots });
  assert.equal(hhmm(plan.meetAt), '19:15');
  assert.equal(hhmm(plan.dinnerAt), '20:00');
  const bare = planEvening({ origin, place: peixe, readyAt: thu('19:00'), style: 'drinks', meetSpots: [] });
  assert.equal(bare.meetSpot, null);
  const straight = planEvening({ origin, place: places[1], readyAt: thu('18:50'), style: 'straight', meetSpots: spots });
  assert.equal(straight.type, 'straight');
});

test('shared plan link round-trips, including accents', () => {
  const plan = planEvening({ origin, place: { ...places[1], name: 'Tasca do Zé – Açores' }, readyAt: thu('18:50'), meetSpots: spots });
  const back = decodePlan(encodePlan(plan, 'cosy'));
  assert.equal(back.mood, 'cosy');
  assert.equal(back.plan.place.name, 'Tasca do Zé – Açores');
  assert.equal(back.plan.meetSpot.name, 'Bar Next Door');
  assert.equal(hhmm(back.plan.dinnerAt), '19:30');
  assert.equal(decodePlan('not-a-plan'), null);
  const txt = shareText(back.plan, 'https://example.test/#p=x');
  assert.match(txt, /Meet 19:00 at Bar Next Door/);
  assert.match(txt, /Dinner 19:30/);
});
