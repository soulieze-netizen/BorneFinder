// Planification de trajet avec arrêts de recharge.
// Règle d'Etienne : sa carte ne marche qu'en Belgique → avant de quitter la Belgique,
// arrêt sur la meilleure borne rapide belge près de la frontière, recharge au maximum.
//
// Services publics gratuits : Nominatim (adresse → coordonnées), OSRM (itinéraire),
// Overpass/OpenStreetMap (bornes le long du trajet).

import { distanceKm, Plug } from './stations';

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
  const res = await fetch(url, { headers: UA });
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
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return '';
  const json = await res.json();
  return (json.address?.country_code ?? '').toUpperCase();
}

interface RoutePt { lat: number; lng: number; km: number }

async function osrmRoute(from: Place, to: Place): Promise<{ pts: RoutePt[]; km: number; minutes: number }> {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url, { headers: UA });
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
  maxKw: number | null; plugs: Plug[]; inBelgium: boolean;
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

/** Bornes à moins de 2,5 km de la route, avec indication Belgique oui/non. */
async function stationsAlong(pts: RoutePt[]): Promise<RouteStation[]> {
  // Échantillonne la route tous les ~4 km pour la requête.
  const sample: RoutePt[] = [];
  let next = 0;
  for (const p of pts) if (p.km >= next) { sample.push(p); next = p.km + 4; }
  sample.push(pts[pts.length - 1]);
  const line = sample.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(',');
  const q = `[out:json][timeout:60];
area["ISO3166-1"="BE"][admin_level=2]->.be;
node["amenity"="charging_station"](around:2500,${line})->.all;
node.all(area.be)->.inbe;
.inbe out tags; out count;
.all out tags;`;
  const servers = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let json: any = null, lastErr: unknown;
  for (const s of servers) {
    try {
      const res = await fetch(s, { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
      if (!res.ok) throw new Error(`Bornes : erreur ${res.status}`);
      json = await res.json(); break;
    } catch (e) { lastErr = e; }
  }
  if (!json) throw lastErr ?? new Error('Bornes indisponibles');

  // Le 1er bloc (avant l'élément "count") = bornes en Belgique.
  const be = new Set<number>();
  const els: any[] = json.elements ?? [];
  let i = 0;
  for (; i < els.length && els[i].type !== 'count'; i++) be.add(els[i].id);
  const all = els.slice(i + 1).filter(e => e.type === 'node');

  const seen = new Set<number>();
  const out: RouteStation[] = [];
  for (const e of all) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    const t = e.tags ?? {};
    if (/^(private|no)$/.test(t.access ?? '')) continue;
    const plugs = new Set<Plug>();
    let maxKw = parseKw(t['charging_station:output']);
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
      id: `osm-${e.id}`, name: t.name || t.brand || t.operator || 'Borne de recharge',
      operator: t.operator || t.brand || t.network, lat: e.lat, lng: e.lon,
      maxKw, plugs: [...plugs], inBelgium: be.has(e.id), progressKm: prog, detourKm: best,
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

export interface PlanOptions { car: Car; startSoc: number; borderTargetSoc: number; reserveSoc: number }

export async function planTrip(from: Place, to: Place, o: PlanOptions): Promise<Plan> {
  const { car } = o;
  const route = await osrmRoute(from, to);
  const all = await stationsAlong(route.pts);
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
      const maxKm = pos + (soc - o.reserveSoc) / kmPerPct;
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

  const arrivalSoc = soc - (route.km - pos) / kmPerPct;
  if (arrivalSoc < o.reserveSoc) warnings.push(`Arrivée estimée à ${Math.round(arrivalSoc)} % : trop juste.`);
  return { from, to, km: route.km, driveMin: route.minutes, stops, arrivalSoc, warnings };
}

export function mapsLink(plan: Plan) {
  const wp = plan.stops.map(s => `${s.station.lat},${s.station.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${plan.from.lat},${plan.from.lng}` +
    `&destination=${plan.to.lat},${plan.to.lng}${wp ? `&waypoints=${encodeURIComponent(wp)}` : ''}&travelmode=driving`;
}
