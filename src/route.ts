// Planification de trajet avec arrêts de recharge.
// Règle d'Etienne : sa carte ne marche qu'en Belgique → avant de quitter la Belgique,
// arrêt sur la meilleure borne rapide belge près de la frontière, recharge au maximum.
//
// Services publics gratuits : Nominatim (adresse → coordonnées), OSRM (itinéraire),
// Overpass/OpenStreetMap (bornes le long du trajet).

import { distanceKm, Plug } from './stations';
import { overpass } from './overpass';
import { fetchT } from './net';
import { loadMyStations } from './myStations';

const UA = { 'User-Agent': 'BorneFinder/1.0 (app perso)' };

export interface Car {
  capacityKwh: number;      // batterie utile
  consumption: number;      // kWh/100 km sur autoroute
  maxDcKw: number;          // puissance de charge max de la voiture
}
// Peugeot e-5008 Long Range : 96,9 kWh utiles, 160 kW DC, ~20 kWh/100 km réel (22 sur autoroute en hiver).
export const DEFAULT_CAR: Car = { capacityKwh: 96.9, consumption: 22, maxDcKw: 160 };

export interface Place { lat: number; lng: number; label: string; country: string }

export async function geocode(q: string): Promise<Place[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&accept-language=fr&q=${encodeURIComponent(q)}`;
  const res = await fetchT(url, { headers: UA }, 12000);
  if (!res.ok) throw new Error(`Recherche d'adresse : erreur ${res.status}`);
  const json = await res.json();
  return json.map((r: any) => ({
    lat: parseFloat(r.lat), lng: parseFloat(r.lon),
    label: r.display_name.split(',').slice(0, 3).join(','),
    country: (r.address?.country_code ?? '').toUpperCase(),
  }));
}

export async function countryOf(lat: number, lng: number): Promise<string> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=3&lat=${lat}&lon=${lng}`;
  try {
    const res = await fetchT(url, { headers: UA }, 8000);
    if (res.ok) { const c = ((await res.json()).address?.country_code ?? '').toUpperCase(); if (c) return c; }
  } catch {}
  // Secours approximatif : rectangle autour de la Belgique.
  return lat > 49.5 && lat < 51.5 && lng > 2.55 && lng < 6.4 ? 'BE' : '';
}

export interface RoutePt { lat: number; lng: number; km: number }

async function osrmRoute(from: Place, to: Place): Promise<{ pts: RoutePt[]; km: number; minutes: number }> {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetchT(url, { headers: UA }, 20000);
  if (!res.ok) throw new Error(`Itinéraire : erreur ${res.status}`);
  const json = await res.json();
  const r = json.routes?.[0];
  if (!r) throw new Error('Aucun itinéraire trouvé');
  const coords: [number, number][] = r.geometry.coordinates;
  const pts: RoutePt[] = [];
  let km = 0;
  coords.forEach(([lng, lat], i) => {
    if (i > 0) km += distanceKm(pts[pts.length - 1].lat, pts[pts.length - 1].lng, lat, lng);
    pts.push({ lat, lng, km });
  });
  return { pts, km: r.distance / 1000, minutes: r.duration / 60 };
}

export interface RouteStation {
  id: string; name: string; operator?: string; lat: number; lng: number;
  maxKw: number | null; plugs: Plug[]; inBelgium: boolean; price?: string;
  progressKm: number;   // position le long du trajet
  detourKm: number;     // écart par rapport à la route
}

function parseKw(v?: string): number | null {
  if (!v) return null;
  let best: number | null = null;
  for (const part of v.split(/[;,]/)) {
    const m = part.trim().match(/([\d.]+)/);
    if (!m) continue;
    let n = parseFloat(m[1]); if (n > 2000) n /= 1000;
    if (n > 0 && n <= 1000 && (best == null || n > best)) best = n;
  }
  return best;
}

function encodePolyline(pts: { lat: number; lng: number }[]) {
  let out = '', pLat = 0, pLng = 0;
  const enc = (v: number) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const p of pts) { const la = Math.round(p.lat * 1e5), ln = Math.round(p.lng * 1e5); out += enc(la - pLat) + enc(ln - pLng); pLat = la; pLng = ln; }
  return out;
}

const OCM_PLUG: Record<number, Plug> = { 33: 'CCS', 32: 'CCS', 2: 'CHAdeMO', 25: 'Type 2', 1036: 'Type 2', 27: 'Tesla', 30: 'Tesla' };

function locate(pts: RoutePt[], lat: number, lng: number) {
  let best = Infinity, prog = 0;
  for (let j = 0; j < pts.length; j += 3) {
    const d = distanceKm(lat, lng, pts[j].lat, pts[j].lng);
    if (d < best) { best = d; prog = pts[j].km; }
  }
  return { prog, detour: best };
}

/** Open Charge Map le long du trajet (fiable, nécessite une clé). */
async function stationsAlongOcm(pts: RoutePt[], key: string): Promise<RouteStation[]> {
  const sample: RoutePt[] = []; let next = 0;
  for (const p of pts) if (p.km >= next) { sample.push(p); next = p.km + 5; }
  sample.push(pts[pts.length - 1]);
  const url = `https://api.openchargemap.io/v3/poi/?output=json&compact=false&verbose=false&maxresults=1000` +
    `&distance=2.5&distanceunit=KM&minpowerkw=40&polyline=${encodeURIComponent(encodePolyline(sample))}&key=${encodeURIComponent(key)}`;
  const res = await fetchT(url, { headers: UA }, 25000);
  if (!res.ok) throw new Error(`Open Charge Map : erreur ${res.status}`);
  const json = await res.json();
  return (json ?? []).map((p: any): RouteStation => {
    const a = p.AddressInfo ?? {}; const conns: any[] = p.Connections ?? [];
    const kws = conns.map(c => c.PowerKW).filter((n: any) => typeof n === 'number' && n > 0);
    const { prog, detour } = locate(pts, a.Latitude, a.Longitude);
    return {
      id: `ocm-${p.ID}`, name: a.Title || 'Borne de recharge', operator: p.OperatorInfo?.Title,
      lat: a.Latitude, lng: a.Longitude, maxKw: kws.length ? Math.max(...kws) : null,
      plugs: [...new Set(conns.map(c => OCM_PLUG[c.ConnectionTypeID] ?? 'Autre'))],
      inBelgium: (a.Country?.ISOCode ?? '') === 'BE',
      price: p.UsageCost || undefined, progressKm: prog, detourKm: detour,
    };
  }).filter((s: RouteStation) => s.lat && s.lng);
}

/** Bornes à moins de 2,5 km de la route, avec indication Belgique oui/non. */
async function stationsAlong(pts: RoutePt[]): Promise<RouteStation[]> {
  // Secours OpenStreetMap : la route est découpée en tronçons de ~60 km (une requête géante échoue toujours).
  const sample: RoutePt[] = [];
  let next = 0;
  for (const p of pts) if (p.km >= next) { sample.push(p); next = p.km + 4; }
  sample.push(pts[pts.length - 1]);
  const els: any[] = [];
  const be = new Set<string>(); // « node123 », « way456 » : un point et une zone peuvent avoir le même numéro
  for (let c = 0; c < sample.length; c += 15) {
    const chunk = sample.slice(Math.max(0, c - 1), c + 15);
    const line = chunk.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(',');
    const q = `[out:json][timeout:25];
area["ISO3166-1"="BE"][admin_level=2]->.be;
nwr["amenity"="charging_station"](around:2500,${line})->.all;
nwr.all(area.be)->.inbe;
.inbe out ids; out count;
.all out center;`;
    const part: any = await overpass(q, 20000, 40000);
    const pe: any[] = part.elements ?? [];
    let k = 0;
    for (; k < pe.length && pe[k].type !== 'count'; k++) be.add(pe[k].type + pe[k].id);
    els.push(...pe.slice(k + 1));
  }
  const json = { elements: [{ type: 'count' }, ...els] };
  const all = json.elements.slice(1)
    .map((e: any) => ({ ...e, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon }))
    .filter((e: any) => e.lat && e.lon);

  const seen = new Set<string>();
  const out: RouteStation[] = [];
  for (const e of all) {
    const key = e.type + e.id;
    if (seen.has(key)) continue; seen.add(key);
    const t = e.tags ?? {};
    if (/^(private|no)$/.test(t.access ?? '')) continue;
    const plugs = new Set<Plug>();
    let maxKw = parseKw(t['charging_station:output']) ?? parseKw(t['maxpower']);
    for (const k of Object.keys(t)) {
      const m = k.match(/^socket:([a-z0-9_]+)(:output)?$/); if (!m) continue;
      if (m[2]) { const kw = parseKw(t[k]); if (kw && (maxKw == null || kw > maxKw)) maxKw = kw; }
      else if (t[k] !== 'no' && t[k] !== '0') plugs.add(m[1].includes('combo') || m[1] === 'ccs' ? 'CCS' : m[1] === 'chademo' ? 'CHAdeMO' : m[1].startsWith('type2') ? 'Type 2' : m[1].startsWith('tesla') ? 'Tesla' : 'Autre');
    }
    // Position le long du trajet = point de route le plus proche.
    let best = Infinity, prog = 0;
    for (let j = 0; j < pts.length; j += 3) {
      const d = distanceKm(e.lat, e.lon, pts[j].lat, pts[j].lng);
      if (d < best) { best = d; prog = pts[j].km; }
    }
    out.push({
      id: `osm-${e.type}-${e.id}`, name: t.name || t.brand || t.operator || 'Borne de recharge',
      operator: t.operator || t.brand || t.network, lat: e.lat, lng: e.lon,
      maxKw, plugs: [...plugs], inBelgium: be.has(key), price: t.charge || undefined, progressKm: prog, detourKm: best,
    });
  }
  return out;
}

export interface Stop {
  station: RouteStation;
  arriveSoc: number; leaveSoc: number; chargeMin: number;
  reason: string;
}
export interface Plan {
  from: Place; to: Place; km: number; driveMin: number;
  stops: Stop[]; arrivalSoc: number; warnings: string[];
  border?: { km: number; soc: number };   // passage de frontière estimé
  pts: RoutePt[];                         // tracé (allégé) pour « Recharger maintenant »
  stations: RouteStation[];               // toutes les bornes le long du trajet
}

function isFast(s: RouteStation, minKw: number) {
  if (s.plugs.length && !s.plugs.includes('CCS')) return false;
  return s.maxKw != null && s.maxKw >= minKw;
}

function chargeMinutes(car: Car, s: RouteStation, from: number, to: number) {
  const p = Math.min(car.maxDcKw, s.maxKw ?? 50);
  const a = Math.max(0, Math.min(to, 80) - from) / 100 * car.capacityKwh;
  const b = Math.max(0, to - Math.max(from, 80)) / 100 * car.capacityKwh;
  return Math.round((a / (p * 0.75) + b / (p * 0.3)) * 60);
}

export interface PlanOptions { car: Car; startSoc: number; borderTargetSoc: number; reserveSoc: number; ocmKey?: string }

export async function planTrip(from: Place, to: Place, o: PlanOptions): Promise<Plan> {
  const { car } = o;
  const route = await osrmRoute(from, to);
  let all: RouteStation[];
  if (o.ocmKey) {
    try { all = await stationsAlongOcm(route.pts, o.ocmKey); }
    catch (e: any) {
      try { all = await stationsAlong(route.pts); }
      catch { throw new Error(`Bornes introuvables : ${e?.message ?? e}. Réessaie dans un moment.`); }
    }
  } else all = await stationsAlong(route.pts);
  // Mes stations (ajoutées à la main) proches de la route : elles remplacent la fiche d'une base au même endroit.
  for (const m of await loadMyStations()) {
    const { prog, detour } = locate(route.pts, m.lat, m.lng);
    if (detour > 2.5) continue;
    all = all.filter(s => distanceKm(s.lat, s.lng, m.lat, m.lng) >= 0.15);
    all.push({ id: m.id, name: m.name, lat: m.lat, lng: m.lng, maxKw: m.maxKw, plugs: m.plugs, inBelgium: m.inBelgium, progressKm: prog, detourKm: detour });
  }
  const warnings: string[] = [];
  const kmPerPct = car.capacityKwh / 100 / (car.consumption / 100); // km par % de batterie

  const pool = (minKw: number) => all.filter(s => isFast(s, minKw) && s.detourKm <= 2.5);
  let fast = pool(100);
  if (fast.length < 3) { fast = pool(50); warnings.push('Peu de bornes ≥ 100 kW sur le trajet : bornes ≥ 50 kW incluses.'); }

  const stops: Stop[] = [];
  let pos = 0, soc = o.startSoc;

  /** Ajoute des arrêts pour atteindre `targetKm`, en ne prenant que les bornes passant `filter`. */
  function reach(targetKm: number, filter: (s: RouteStation) => boolean, label: string) {
    let guard = 0;
    while (soc - (targetKm - pos) / kmPerPct < o.reserveSoc && guard++ < 10) {
      const maxKm = pos + (soc - o.reserveSoc) * kmPerPct;
      const cands = fast.filter(s => filter(s) && s.progressKm > pos + 15 && s.progressKm <= maxKm && s.progressKm < targetKm);
      if (!cands.length) { warnings.push(`Pas de borne rapide atteignable ${label}. Vérifie la charge au départ.`); return false; }
      const far = Math.max(...cands.map(s => s.progressKm));
      const best = cands.filter(s => s.progressKm >= far - 30).sort((a, b) => (b.maxKw ?? 0) - (a.maxKw ?? 0) || b.progressKm - a.progressKm)[0];
      const arrive = soc - (best.progressKm - pos) / kmPerPct;
      stops.push({ station: best, arriveSoc: arrive, leaveSoc: 80, chargeMin: chargeMinutes(car, best, arrive, 80), reason: 'Recharge en route' });
      pos = best.progressKm; soc = 80;
    }
    return true;
  }

  const startBE = from.country === 'BE';
  const endBE = to.country === 'BE';

  if (startBE && !endBE) {
    // Dernière borne rapide belge avant la frontière = meilleure parmi les 30 derniers km belges.
    const beFast = fast.filter(s => s.inBelgium);
    if (!beFast.length) {
      warnings.push('Aucune borne rapide belge trouvée près du trajet avant la frontière.');
    } else {
      const borderKm = Math.max(...all.filter(s => s.inBelgium).map(s => s.progressKm));
      const border = beFast.filter(s => s.progressKm >= borderKm - 30)
        .sort((a, b) => (b.maxKw ?? 0) - (a.maxKw ?? 0) || b.progressKm - a.progressKm)[0]
        ?? beFast.sort((a, b) => b.progressKm - a.progressKm)[0];
      reach(border.progressKm, s => s.inBelgium, 'en Belgique avant la frontière');
      const arrive = soc - (border.progressKm - pos) / kmPerPct;
      const target = Math.max(o.borderTargetSoc, Math.round(arrive));
      stops.push({ station: border, arriveSoc: arrive, leaveSoc: target, chargeMin: chargeMinutes(car, border, arrive, target),
        reason: '🇧🇪 Dernière recharge en Belgique (carte entreprise)' });
      pos = border.progressKm; soc = target;
    }
    reach(route.km, () => true, 'après la frontière');
  } else if (!startBE && endBE) {
    // Retour : on préfère recharger en Belgique dès que possible.
    reach(route.km, () => true, 'sur le trajet');
    const firstBE = fast.filter(s => s.inBelgium && s.progressKm > pos).sort((a, b) => a.progressKm - b.progressKm)[0];
    if (firstBE && soc - (route.km - pos) / kmPerPct < 30) {
      const arrive = soc - (firstBE.progressKm - pos) / kmPerPct;
      stops.push({ station: firstBE, arriveSoc: arrive, leaveSoc: 80, chargeMin: chargeMinutes(car, firstBE, arrive, 80),
        reason: '🇧🇪 Première borne rapide en Belgique (carte entreprise)' });
      pos = firstBE.progressKm; soc = 80;
    }
  } else {
    reach(route.km, () => true, 'sur le trajet');
  }

  // % de batterie au passage de la frontière (dernier point du trajet proche d'une borne belge).
  let border: Plan['border'];
  if (startBE !== endBE) {
    const beKm = all.filter(s => s.inBelgium).map(s => s.progressKm);
    if (beKm.length) {
      const km = startBE ? Math.max(...beKm) : Math.min(...beKm);
      // Batterie à ce point, en rejouant les arrêts.
      let p = 0, b = o.startSoc;
      for (const st of stops) { if (st.station.progressKm > km) break; b = st.leaveSoc; p = st.station.progressKm; }
      border = { km, soc: b - (km - p) / kmPerPct };
    }
  }
  const arrivalSoc = soc - (route.km - pos) / kmPerPct;
  if (arrivalSoc < o.reserveSoc) warnings.push(`Arrivée estimée à ${Math.round(arrivalSoc)} % : trop juste.`);
  const pts: RoutePt[] = []; let nx = 0;
  for (const p of route.pts) if (p.km >= nx) { pts.push(p); nx = p.km + 0.5; }
  pts.push(route.pts[route.pts.length - 1]);
  return { from, to, km: route.km, driveMin: route.minutes, stops, arrivalSoc, warnings, border, pts, stations: all };
}

export function mapsLink(plan: Plan) {
  const wp = plan.stops.map(s => `${s.station.lat},${s.station.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${plan.from.lat},${plan.from.lng}` +
    `&destination=${plan.to.lat},${plan.to.lng}${wp ? `&waypoints=${encodeURIComponent(wp)}` : ''}&travelmode=driving`;
}

export interface Nearby { station: RouteStation; aheadKm: number; offRouteKm: number }

/** Bornes rapides devant moi sur le trajet : ≥ 100 kW d'abord, ≥ 50 kW s'il n'y a rien. Belges en premier tant que je suis en Belgique. */
export function chargeNow(plan: Plan, lat: number, lng: number) {
  let best = Infinity, prog = 0;
  for (const p of plan.pts) { const d = distanceKm(lat, lng, p.lat, p.lng); if (d < best) { best = d; prog = p.km; } }
  const beKm = plan.stations.filter(s => s.inBelgium).map(s => s.progressKm);
  const startBE = plan.from.country === 'BE', endBE = plan.to.country === 'BE';
  const inBE = beKm.length ? (startBE && !endBE ? prog < Math.max(...beKm) : !startBE && endBE ? prog > Math.min(...beKm) : startBE) : startBE;
  const ahead = (min: number) => plan.stations
    .filter(s => s.progressKm > prog + 0.5 && s.detourKm <= 3 && isFast(s, min))
    .map(s => ({ station: s, aheadKm: s.progressKm - prog, offRouteKm: s.detourKm }))
    .sort((a, b) => (inBE ? Number(b.station.inBelgium) - Number(a.station.inBelgium) : 0) || a.aheadKm - b.aheadKm);
  let list = ahead(100), fallback = false;
  if (!list.length) { list = ahead(50); fallback = true; }
  return { list: list.slice(0, 3), fallback, offRouteKm: best, inBE };
}

/** Google Maps : ma position → borne → destination. */
export function viaStationLink(plan: Plan, s: RouteStation) {
  return `https://www.google.com/maps/dir/?api=1&destination=${plan.to.lat},${plan.to.lng}` +
    `&waypoints=${s.lat},${s.lng}&travelmode=driving`;
}
