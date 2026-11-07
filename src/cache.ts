// Mémoire locale des bornes déjà trouvées : affichage immédiat, mise à jour en arrière-plan.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { distanceKm, Station } from './stations';

const KEY = 'stations-cache-v1';
const MAX = 3000; // Android refuse de relire une valeur AsyncStorage > ~2 Mo

interface Store { stations: Record<string, Station>; areas: { lat: number; lng: number; r: number; at: number }[] }
let mem: Store | null = null;

async function load(): Promise<Store> {
  if (mem) return mem;
  try { const v = await AsyncStorage.getItem(KEY); mem = v ? JSON.parse(v) : null; } catch { mem = null; }
  mem ??= { stations: {}, areas: [] };
  return mem;
}

function save() {
  if (!mem) return;
  const all = Object.values(mem.stations);
  if (all.length > MAX) for (const s of all.slice(0, all.length - MAX)) delete mem.stations[s.id];
  mem.areas = mem.areas.slice(-50);
  AsyncStorage.setItem(KEY, JSON.stringify(mem)).catch(() => {});
}

/** Bornes en mémoire autour d'un point + date de la dernière mise à jour de la zone. */
export async function cachedAround(lat: number, lng: number, radiusKm: number) {
  const st = await load();
  const stations = Object.values(st.stations)
    .map(s => ({ ...s, distanceKm: distanceKm(lat, lng, s.lat, s.lng) }))
    .filter(s => s.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const area = st.areas.filter(a => distanceKm(lat, lng, a.lat, a.lng) + radiusKm <= a.r + 2).sort((a, b) => b.at - a.at)[0];
  return { stations, updatedAt: area?.at ?? null };
}

/** Enregistre un résultat frais : remplace les bornes de la zone (supprime celles disparues). */
export async function storeArea(lat: number, lng: number, radiusKm: number, fresh: Station[]) {
  const st = await load();
  for (const s of Object.values(st.stations)) {
    if (distanceKm(lat, lng, s.lat, s.lng) <= radiusKm * 0.98) delete st.stations[s.id];
  }
  for (const s of fresh) { const { distanceKm: _d, ...rest } = s; st.stations[s.id] = rest; }
  st.areas.push({ lat, lng, r: radiusKm, at: Date.now() });
  save();
}
