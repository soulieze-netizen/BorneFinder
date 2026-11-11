// Bornes de recharge : croisement de plusieurs bases publiques.
//  - OpenStreetMap (via Overpass) : gratuit, sans clé.
//  - Open Charge Map : gratuit, clé personnelle (à saisir dans Réglages).
// Les doublons (même station dans les deux bases) sont fusionnés.

export type Plug = 'CCS' | 'CHAdeMO' | 'Type 2' | 'Tesla' | 'Autre';

export interface Station {
  id: string;
  name: string;
  operator?: string;
  lat: number;
  lng: number;
  maxKw: number | null;      // puissance max connue (null = inconnue)
  plugs: Plug[];
  points?: number;           // nombre de points de charge
  address?: string;
  price?: string;            // tarif si une base le connaît (non vérifié)
  sources: ('OSM' | 'OCM' | 'Moi')[];
  distanceKm?: number;
  myId?: string;             // présente dans « Mes stations »
}

import { overpass } from './overpass';
import { fetchT } from './net';

function parseKw(v?: string): number | null {
  if (!v) return null;
  let best: number | null = null;
  for (const part of v.split(/[;,]/)) {
    const m = part.trim().match(/([\d.]+)\s*(kw|w)?/i);
    if (!m) continue;
    let n = parseFloat(m[1]);
    if (m[2]?.toLowerCase() === 'w' || n > 2000) n = n / 1000;
    if (n > 0 && n <= 1000 && (best == null || n > best)) best = n;
  }
  return best;
}

const OSM_PLUGS: Record<string, Plug> = {
  type2_combo: 'CCS', ccs: 'CCS', chademo: 'CHAdeMO', type2: 'Type 2', type2_cable: 'Type 2',
  tesla_supercharger: 'Tesla', tesla_supercharger_ccs: 'CCS', nacs: 'Tesla',
};

async function fetchOsm(lat: number, lng: number, radiusKm: number): Promise<Station[]> {
  const r = Math.round(radiusKm * 1000);
  // nwr = points ET zones (beaucoup de grandes stations sont dessinées comme une zone) ; « center » donne leur position.
  const q = `[out:json][timeout:20];nwr["amenity"="charging_station"](around:${r},${lat},${lng});out center;`;
  {
    {
      const json = await overpass(q, 15000, 30000);
      return (json.elements ?? []).map((e: any): Station => {
        const t = e.tags ?? {};
        const plugs = new Set<Plug>();
        let maxKw = parseKw(t['charging_station:output']) ?? parseKw(t['maxpower']);
        for (const k of Object.keys(t)) {
          const m = k.match(/^socket:([a-z0-9_]+)(:output)?$/);
          if (!m) continue;
          if (m[2]) { const kw = parseKw(t[k]); if (kw && (maxKw == null || kw > maxKw)) maxKw = kw; }
          else if (t[k] !== 'no' && t[k] !== '0') plugs.add(OSM_PLUGS[m[1]] ?? 'Autre');
        }
        return {
          id: `osm-${e.type}-${e.id}`,
          name: t.name || t.brand || t.operator || 'Borne de recharge',
          operator: t.operator || t.brand || t.network,
          lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon,
          maxKw, plugs: [...plugs],
          points: parseInt(t.capacity, 10) || undefined,
          price: t.charge || t['charge:conditional'] || undefined,
          address: [t['addr:street'] && `${t['addr:street']} ${t['addr:housenumber'] ?? ''}`.trim(), t['addr:city']].filter(Boolean).join(', ') || undefined,
          sources: ['OSM'],
        };
      }).filter((s: Station, i: number) => s.lat && s.lng &&
        !/^(private|no)$/.test(json.elements[i]?.tags?.access ?? ''));
    }
  }
}

const OCM_PLUGS: Record<number, Plug> = { 33: 'CCS', 32: 'CCS', 2: 'CHAdeMO', 25: 'Type 2', 1036: 'Type 2', 27: 'Tesla', 30: 'Tesla' };

async function fetchOcm(lat: number, lng: number, radiusKm: number, key: string): Promise<Station[]> {
  const url = `https://api.openchargemap.io/v3/poi/?output=json&latitude=${lat}&longitude=${lng}` +
    `&distance=${radiusKm}&distanceunit=KM&maxresults=500&compact=false&verbose=false&key=${encodeURIComponent(key)}`;
  const res = await fetchT(url, { headers: { 'User-Agent': 'BorneFinder/1.0' } }, 15000);
  if (!res.ok) throw new Error(`Open Charge Map ${res.status}`);
  const json = await res.json();
  return (json ?? []).map((p: any): Station => {
    const conns: any[] = p.Connections ?? [];
    const kws = conns.map(c => c.PowerKW).filter((n: any) => typeof n === 'number' && n > 0);
    const a = p.AddressInfo ?? {};
    return {
      id: `ocm-${p.ID}`,
      name: a.Title || 'Borne de recharge',
      operator: p.OperatorInfo?.Title,
      lat: a.Latitude, lng: a.Longitude,
      maxKw: kws.length ? Math.max(...kws) : null,
      plugs: [...new Set(conns.map(c => OCM_PLUGS[c.ConnectionTypeID] ?? 'Autre'))],
      points: p.NumberOfPoints || conns.reduce((n, c) => n + (c.Quantity || 1), 0) || undefined,
      address: [a.AddressLine1, a.Town].filter(Boolean).join(', ') || undefined,
      price: p.UsageCost || undefined,
      sources: ['OCM'],
    };
  }).filter((s: Station) => s.lat && s.lng);
}

export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371, dLat = (bLat - aLat) * Math.PI / 180, dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Fusionne les stations à moins de 80 m l'une de l'autre (même site dans 2 bases). */
function merge(list: Station[]): Station[] {
  const out: Station[] = [];
  for (const s of list) {
    const twin = out.find(o => distanceKm(o.lat, o.lng, s.lat, s.lng) < 0.08 &&
      (o.maxKw == null || s.maxKw == null || Math.abs(o.maxKw - s.maxKw) < 60 || o.sources[0] !== s.sources[0]));
    if (!twin) { out.push({ ...s }); continue; }
    twin.sources = [...new Set([...twin.sources, ...s.sources])];
    twin.plugs = [...new Set([...twin.plugs, ...s.plugs])];
    if (s.maxKw != null && (twin.maxKw == null || s.maxKw > twin.maxKw)) twin.maxKw = s.maxKw;
    twin.operator ??= s.operator; twin.address ??= s.address; twin.price ??= s.price;
    twin.points = Math.max(twin.points ?? 0, s.points ?? 0) || undefined;
    if (twin.name === 'Borne de recharge') twin.name = s.name;
  }
  return out;
}

export interface SearchResult { stations: Station[]; errors: string[] }

/**
 * `onPartial` reçoit tout de suite les bornes d'Open Charge Map ; le résultat final ajoute
 * celles d'OpenStreetMap (qui répond souvent plus lentement) au lieu de les abandonner.
 */
export async function searchStations(
  lat: number, lng: number, radiusKm: number, ocmKey?: string, onPartial?: (stations: Station[]) => void,
): Promise<SearchResult> {
  const errors: string[] = [];
  const osm = fetchOsm(lat, lng, radiusKm).catch(e => { errors.push(`OpenStreetMap : ${e?.message ?? e}`); return [] as Station[]; });
  let all: Station[];
  if (ocmKey) {
    const ocm = await fetchOcm(lat, lng, radiusKm, ocmKey).catch(e => { errors.push(`Open Charge Map : ${e?.message ?? e}`); return null; });
    if (ocm && ocm.length) {
      // Open Charge Map a répondu : on l'affiche déjà, puis on complète avec OpenStreetMap.
      onPartial?.(finalize(ocm, lat, lng));
      all = [...ocm, ...(await osm)];
      for (let i = errors.length - 1; i >= 0; i--) if (errors[i].startsWith('OpenStreetMap')) errors.splice(i, 1);
    } else all = await osm;
  } else all = await osm;
  return { stations: finalize(all, lat, lng), errors };
}

function finalize(all: Station[], lat: number, lng: number) {
  return merge(all)
    .map(s => ({ ...s, distanceKm: distanceKm(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.distanceKm! - b.distanceKm!);
}

/** Lien pour consulter le tarif réel (recherche Seety, qui affiche les prix à jour). */
export function priceLink(name: string, operator?: string, address?: string) {
  const q = ['seety', operator, name, address].filter(Boolean).join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
