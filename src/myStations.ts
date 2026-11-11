// « Mes stations » : bornes ajoutées à la main (appui long sur la carte).
// Toujours affichées, même si aucune base publique ne les connaît (ex. TotalEnergies Axisparc).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { distanceKm, Plug, Station } from './stations';

export interface MyStation {
  id: string; name: string; lat: number; lng: number;
  maxKw: number | null; plugs: Plug[]; inBelgium: boolean; addedAt: number;
}

const KEY = 'my-stations-v1';
let mem: MyStation[] | null = null;

export async function loadMyStations(): Promise<MyStation[]> {
  if (mem) return mem;
  try { const v = await AsyncStorage.getItem(KEY); mem = v ? JSON.parse(v) : []; } catch { mem = []; }
  return mem!;
}

async function save(list: MyStation[]) {
  mem = list;
  await AsyncStorage.setItem(KEY, JSON.stringify(list)).catch(() => {});
  return list;
}

export async function addMyStation(s: Omit<MyStation, 'id' | 'addedAt'>) {
  const list = await loadMyStations();
  return save([...list, { ...s, id: `moi-${Date.now()}`, addedAt: Date.now() }]);
}

export async function removeMyStation(id: string) {
  return save((await loadMyStations()).filter(s => s.id !== id));
}

/** Ajoute mes stations (dans le rayon) aux bornes trouvées ; si une base connaît déjà le site, on la complète. */
export function withMyStations(list: Station[], mine: MyStation[], lat: number, lng: number, radiusKm: number): Station[] {
  if (!mine.length) return list;
  const out = list.map(s => ({ ...s }));
  for (const m of mine) {
    const d = distanceKm(lat, lng, m.lat, m.lng);
    if (d > radiusKm) continue;
    const twin = out.find(s => distanceKm(s.lat, s.lng, m.lat, m.lng) < 0.15 && !s.sources.includes('Moi'));
    if (twin) {
      twin.sources = [...twin.sources, 'Moi'];
      twin.myId = m.id;
      if (m.maxKw != null && (twin.maxKw == null || m.maxKw > twin.maxKw)) twin.maxKw = m.maxKw;
      twin.plugs = [...new Set([...twin.plugs, ...m.plugs])];
    } else {
      out.push({ id: m.id, myId: m.id, name: m.name, lat: m.lat, lng: m.lng, maxKw: m.maxKw, plugs: m.plugs, sources: ['Moi'], distanceKm: d });
    }
  }
  return out.sort((a, b) => a.distanceKm! - b.distanceKm!);
}
