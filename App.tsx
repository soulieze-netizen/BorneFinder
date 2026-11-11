import { OCM_KEY } from './src/net';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Linking, Modal, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import MapView, { Marker, PROVIDER_GOOGLE, Region } from 'react-native-maps';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { distanceKm, Plug, searchStations, Station } from './src/stations';
import TripPanel from './src/TripPanel';
import { cachedAround, storeArea } from './src/cache';
import { addMyStation, loadMyStations, MyStation, removeMyStation, withMyStations } from './src/myStations';

const C = { bg: '#0F2A1D', card: '#163A29', text: '#F2F7F4', muted: '#9FB8AA', accent: '#3DDC84', warn: '#FFB74D' };
const POWER_FILTERS = [0, 50, 150, 300];
const RADII = [10, 25, 50];
const PLUG_FILTERS: (Plug | 'Toutes')[] = ['Toutes', 'CCS', 'Type 2', 'CHAdeMO'];

type Prefs = { minKw: number; radius: number; plug: Plug | 'Toutes'; ocmKey: string; showUnknown: boolean };
const DEFAULT_PREFS: Prefs = { minKw: 150, radius: 25, plug: 'CCS', ocmKey: '', showUnknown: true };

function kwColor(kw: number | null) {
  if (kw == null) return C.muted;
  if (kw >= 250) return '#3DDC84';
  if (kw >= 100) return '#8BC34A';
  if (kw >= 43) return '#FFB74D';
  return '#B0BEC5';
}

function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
}

function navigateTo(s: Station) {
  const nav = `google.navigation:q=${s.lat},${s.lng}`;
  const web = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;
  Linking.openURL(nav).catch(() => Linking.openURL(web));
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[st.chip, active && st.chipOn]}>
      <Text style={[st.chipTxt, active && st.chipTxtOn]}>{label}</Text>
    </Pressable>
  );
}

function Main() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Recherche de ta position…');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [tab, setTab] = useState<'near' | 'trip'>('near');
  const [settings, setSettings] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [selected, setSelected] = useState<Station | null>(null);
  const mapRegion = useRef<Region | null>(null);
  const mapRef = useRef<MapView | null>(null);
  // Android : les pastilles personnalisées doivent être « suivies » le temps d'être dessinées, sinon elles restent invisibles.
  const [trackPins, setTrackPins] = useState(true);
  // Mes stations (ajoutées à la main) + formulaire d'ajout (appui long sur la carte)
  const [mine, setMine] = useState<MyStation[]>([]);
  useEffect(() => { loadMyStations().then(setMine); }, []);
  const [adding, setAdding] = useState<{ lat: number; lng: number } | null>(null);
  const [addName, setAddName] = useState('');
  const [addKw, setAddKw] = useState('300');
  const [addPlugs, setAddPlugs] = useState<Plug[]>(['CCS']);
  const [addBe, setAddBe] = useState(true);
  const openAdd = (lat: number, lng: number) => {
    setAddName(''); setAddKw('300'); setAddPlugs(['CCS']); setAddBe(true); setAdding({ lat, lng });
  };
  const saveAdd = async () => {
    if (!adding) return;
    const kw = parseFloat(addKw.replace(',', '.'));
    setMine(await addMyStation({
      name: addName.trim() || 'Ma borne', lat: adding.lat, lng: adding.lng,
      maxKw: kw > 0 ? kw : null, plugs: addPlugs, inBelgium: addBe,
    }));
    setAdding(null);
  };

  useEffect(() => {
    AsyncStorage.getItem('prefs').then(v => { if (v) try { setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(v) }); } catch {} });
  }, []);
  const updatePrefs = (p: Partial<Prefs>) => setPrefs(prev => {
    const next = { ...prev, ...p };
    AsyncStorage.setItem('prefs', JSON.stringify(next)).catch(() => {});
    return next;
  });

  const locate = useCallback(async () => {
    setStatus('Recherche de ta position…');
    const { status: perm } = await Location.requestForegroundPermissionsAsync();
    if (perm !== 'granted') { setStatus('Localisation refusée : autorise-la dans les réglages Android.'); return; }
    const last = await Location.getLastKnownPositionAsync().catch(() => null);
    if (last) { const p = { lat: last.coords.latitude, lng: last.coords.longitude }; setPos(p); setCenter(p); }
    const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
    if (cur) { const p = { lat: cur.coords.latitude, lng: cur.coords.longitude }; setPos(p); setCenter(p); }
    else if (!last) setStatus('Position introuvable. Réessaie à découvert.');
  }, []);
  useEffect(() => { locate(); }, [locate]);

  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const reqId = useRef(0);
  const search = useCallback(async () => {
    if (!center) return;
    const id = ++reqId.current; // une recherche plus récente annule l'affichage de celle-ci
    // 1. Affichage immédiat de ce qui est en mémoire.
    const cached = await cachedAround(center.lat, center.lng, prefs.radius);
    if (id !== reqId.current) return;
    if (cached.stations.length) { setStations(cached.stations); setUpdatedAt(cached.updatedAt); setStatus(''); }
    else setStatus('Recherche des bornes…');
    // 2. Mise à jour en arrière-plan.
    setLoading(true);
    const r = await searchStations(center.lat, center.lng, prefs.radius, prefs.ocmKey.trim() || OCM_KEY, partial => {
      // Open Charge Map a répondu : affichage tout de suite, OpenStreetMap complétera
      if (id !== reqId.current || !partial.length) return;
      setStations(partial); setUpdatedAt(Date.now()); setStatus('');
    });
    if (id !== reqId.current) return;
    setLoading(false); setErrors(r.errors);
    if (r.stations.length) {
      setStations(r.stations); setUpdatedAt(Date.now());
      storeArea(center.lat, center.lng, prefs.radius, r.stations);
      setStatus('');
    } else if (!cached.stations.length) {
      setStatus(r.errors.length ? 'Recherche impossible pour le moment.' : 'Aucune borne trouvée dans ce rayon.');
    }
  }, [center, prefs.radius, prefs.ocmKey]);
  useEffect(() => { search(); }, [search]);

  const all = useMemo(
    () => (center ? withMyStations(stations, mine, center.lat, center.lng, prefs.radius) : stations),
    [stations, mine, center, prefs.radius],
  );
  const shown = useMemo(() => all.filter(s => {
    if (s.maxKw == null) { if (!prefs.showUnknown) return false; }
    else if (s.maxKw < prefs.minKw) return false;
    if (prefs.plug !== 'Toutes' && s.plugs.length && !s.plugs.includes(prefs.plug)) return false;
    return true;
  }).sort((a, b) => {
    // Puissance connue d'abord, puis distance.
    const ka = a.maxKw == null ? 1 : 0, kb = b.maxKw == null ? 1 : 0;
    return ka - kb || a.distanceKm! - b.distanceKm!;
  }), [all, prefs]);

  useEffect(() => {
    if (view !== 'map') return;
    setTrackPins(true);
    const t = setTimeout(() => setTrackPins(false), 1500);
    return () => clearTimeout(t);
  }, [shown, view]);

  // Recadre la carte sur ma position + les bornes les plus proches.
  useEffect(() => {
    if (view !== 'map' || !mapRef.current || !shown.length) return;
    const pts = shown.slice(0, 15).map(s => ({ latitude: s.lat, longitude: s.lng }));
    if (pos && center && distanceKm(pos.lat, pos.lng, center.lat, center.lng) <= prefs.radius) pts.push({ latitude: pos.lat, longitude: pos.lng });
    const t = setTimeout(() => mapRef.current?.fitToCoordinates(pts, { edgePadding: { top: 80, right: 60, bottom: 140, left: 60 }, animated: true }), 300);
    return () => clearTimeout(t);
  }, [view, stations]);

  const renderItem = ({ item: s }: { item: Station }) => (
    <Pressable style={st.card} onPress={() => setSelected(s)}>
      <View style={[st.kwBox, { borderColor: kwColor(s.maxKw) }]}>
        <Text style={[st.kw, { color: kwColor(s.maxKw) }]}>{s.maxKw != null ? Math.round(s.maxKw) : '?'}</Text>
        <Text style={st.kwUnit}>kW</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={st.name} numberOfLines={1}>{s.name}</Text>
        <Text style={st.sub} numberOfLines={1}>
          {[s.operator, s.plugs.join(' · '), s.points ? `${s.points} pts` : null].filter(Boolean).join('  ·  ')}
        </Text>
        {s.price ? <Text style={[st.sub, { color: C.warn }]} numberOfLines={1}>💶 {s.price} (non vérifié)</Text> : null}
        <Text style={st.src}>{s.sources.join(' + ')}{s.maxKw == null ? '  ·  puissance non renseignée' : ''}</Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        <Text style={st.dist}>{s.distanceKm! < 1 ? `${Math.round(s.distanceKm! * 1000)} m` : `${s.distanceKm!.toFixed(1)} km`}</Text>
        <Pressable style={st.go} onPress={() => navigateTo(s)}><Text style={st.goTxt}>Y aller</Text></Pressable>
      </View>
    </Pressable>
  );

  return (
    <SafeAreaView style={st.root} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <View style={st.header}>
        <Text style={st.title}>🚗⚡ BorneFinder</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {tab === 'near' && <Chip label={view === 'list' ? '🗺 Carte' : '☰ Liste'} active={false} onPress={() => setView(view === 'list' ? 'map' : 'list')} />}
          <Chip label="⚙︎" active={false} onPress={() => { setKeyDraft(prefs.ocmKey); setSettings(true); }} />
        </View>
      </View>

      <View style={[st.row, { paddingHorizontal: 12, paddingBottom: 8 }]}>
        <Chip label="📍 Autour de moi" active={tab === 'near'} onPress={() => setTab('near')} />
        <Chip label="🧭 Trajet" active={tab === 'trip'} onPress={() => setTab('trip')} />
      </View>

      {tab === 'trip' ? <TripPanel position={pos} ocmKey={prefs.ocmKey} /> : <>
      <View style={st.filters}>
        <View style={st.row}>
          {POWER_FILTERS.map(k => <Chip key={k} label={k === 0 ? 'Toutes' : `≥ ${k} kW`} active={prefs.minKw === k} onPress={() => updatePrefs({ minKw: k })} />)}
        </View>
        <View style={st.row}>
          {PLUG_FILTERS.map(p => <Chip key={p} label={p} active={prefs.plug === p} onPress={() => updatePrefs({ plug: p })} />)}
          {RADII.map(r => <Chip key={r} label={`${r} km`} active={prefs.radius === r} onPress={() => updatePrefs({ radius: r })} />)}
        </View>
      </View>

      {!!errors.length && <Text style={st.err}>⚠️ {errors.join(' · ')}</Text>}

      {view === 'list' ? (
        <FlatList
          data={shown}
          keyExtractor={s => s.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          refreshing={loading && !stations.length}
          onRefresh={() => { if (pos) setCenter({ ...pos }); else locate(); }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', padding: 30, gap: 10 }}>
              {loading ? <ActivityIndicator color={C.accent} /> : null}
              <Text style={st.sub}>{status || 'Aucune borne ne correspond aux filtres.'}</Text>
            </View>
          }
          ListHeaderComponent={shown.length ? (
            <Text style={st.count}>
              {shown.length} borne{shown.length > 1 ? 's' : ''} · {all.length} au total dans {prefs.radius} km
              {loading ? '  ·  🔄 mise à jour…' : updatedAt ? `  ·  à jour ${ago(updatedAt)}` : ''}
            </Text>
          ) : null}
        />
      ) : (
        <View style={{ flex: 1 }}>
          {center && (
            <MapView
              ref={mapRef}
              provider={PROVIDER_GOOGLE}
              style={{ flex: 1 }}
              showsMyLocationButton
              initialRegion={{ latitude: center.lat, longitude: center.lng, latitudeDelta: 0.25, longitudeDelta: 0.25 }}
              showsUserLocation
              onRegionChangeComplete={r => { mapRegion.current = r; }}
              onLongPress={e => openAdd(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
            >
              {shown.map(s => (
                <Marker key={s.id} coordinate={{ latitude: s.lat, longitude: s.lng }} onPress={() => setSelected(s)} tracksViewChanges={trackPins}>
                  <View style={[st.pin, { backgroundColor: kwColor(s.maxKw) }]}>
                    <Text style={st.pinTxt}>{s.maxKw != null ? Math.round(s.maxKw) : '?'}</Text>
                  </View>
                </Marker>
              ))}
            </MapView>
          )}
          <Pressable style={st.searchHere} onPress={() => {
            const r = mapRegion.current; if (r) setCenter({ lat: r.latitude, lng: r.longitude });
          }}>
            <Text style={st.goTxt}>{loading ? 'Recherche…' : '🔍 Chercher dans cette zone'}</Text>
          </Pressable>
          <Text style={st.mapHint}>Borne manquante ? Appui long sur la carte pour l'ajouter</Text>
        </View>
      )}

      </>}

      {/* Détail d'une station */}
      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <Pressable style={st.backdrop} onPress={() => setSelected(null)}>
          {selected && (
            <Pressable style={st.sheet}>
              <Text style={st.sheetTitle}>{selected.name}</Text>
              {selected.operator && <Text style={st.sub}>Opérateur : {selected.operator}</Text>}
              {selected.address && <Text style={st.sub}>{selected.address}</Text>}
              <Text style={[st.sheetKw, { color: kwColor(selected.maxKw) }]}>
                {selected.maxKw != null ? `${Math.round(selected.maxKw)} kW max` : 'Puissance non renseignée'}
              </Text>
              <Text style={st.sub}>Prises : {selected.plugs.join(', ') || 'non renseignées'}{selected.points ? ` · ${selected.points} points de charge` : ''}</Text>
              <Text style={st.src}>Source : {selected.sources.join(' + ')} · à {selected.distanceKm!.toFixed(1)} km</Text>
              <Text style={[st.sub, { color: selected.price ? C.warn : C.muted, marginTop: 8 }]}>
                💶 {selected.price ? `${selected.price} (non vérifié)` : 'Prix non renseigné'}
              </Text>
              <Pressable style={[st.go, { alignSelf: 'stretch', paddingVertical: 14, marginTop: 14 }]} onPress={() => navigateTo(selected)}>
                <Text style={[st.goTxt, { fontSize: 17, textAlign: 'center' }]}>🧭 Y aller (Google Maps)</Text>
              </Pressable>
              {selected.myId ? (
                <Pressable style={{ paddingVertical: 12 }} onPress={async () => {
                  setMine(await removeMyStation(selected.myId!)); setSelected(null);
                }}>
                  <Text style={[st.sub, { color: C.warn, textAlign: 'center' }]}>🗑 Retirer de mes stations</Text>
                </Pressable>
              ) : null}
            </Pressable>
          )}
        </Pressable>
      </Modal>

      {/* Réglages */}
      <Modal visible={settings} transparent animationType="slide" onRequestClose={() => setSettings(false)}>
        <View style={st.backdrop}>
          <View style={st.sheet}>
            <Text style={st.sheetTitle}>Réglages</Text>
            <Text style={st.sub}>Clé Open Charge Map (gratuite, sur openchargemap.org → My Profile → My Apps). Laisse vide pour utiliser la clé intégrée.</Text>
            <TextInput value={keyDraft} onChangeText={setKeyDraft} placeholder="Colle ta clé ici" placeholderTextColor={C.muted}
              autoCapitalize="none" autoCorrect={false} style={st.input} />
            <Pressable onPress={() => updatePrefs({ showUnknown: !prefs.showUnknown })} style={{ paddingVertical: 10 }}>
              <Text style={st.name}>{prefs.showUnknown ? '☑' : '☐'} Afficher les bornes dont la puissance n'est pas renseignée</Text>
            </Pressable>
            <Text style={[st.sub, { marginVertical: 8 }]}>
              📌 Mes stations : {mine.length ? mine.map(m => m.name).join(', ') : 'aucune'}.
              {'\n'}Pour en ajouter une : Carte → appui long à l'endroit de la borne.
            </Text>
            <Pressable style={[st.go, { alignSelf: 'stretch', paddingVertical: 12 }]} onPress={() => { updatePrefs({ ocmKey: keyDraft.trim() }); setSettings(false); }}>
              <Text style={[st.goTxt, { textAlign: 'center' }]}>Enregistrer</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      {/* Ajout d'une station à la main */}
      <Modal visible={!!adding} transparent animationType="slide" onRequestClose={() => setAdding(null)}>
        <View style={st.backdrop}>
          <View style={st.sheet}>
            <Text style={st.sheetTitle}>📌 Ajouter une station ici</Text>
            <TextInput value={addName} onChangeText={setAddName} placeholder="Nom (ex. TotalEnergies Axisparc)"
              placeholderTextColor={C.muted} style={st.input} />
            <Text style={[st.sub, { marginTop: 10 }]}>Puissance max (kW)</Text>
            <View style={[st.row, { marginTop: 4 }]}>
              {['50', '150', '300', '350'].map(k => <Chip key={k} label={`${k} kW`} active={addKw === k} onPress={() => setAddKw(k)} />)}
            </View>
            <TextInput value={addKw} onChangeText={setAddKw} keyboardType="numeric" placeholder="kW" placeholderTextColor={C.muted} style={st.input} />
            <Text style={[st.sub, { marginTop: 10 }]}>Prises</Text>
            <View style={[st.row, { marginTop: 4 }]}>
              {(['CCS', 'Type 2', 'CHAdeMO'] as Plug[]).map(p => (
                <Chip key={p} label={p} active={addPlugs.includes(p)}
                  onPress={() => setAddPlugs(addPlugs.includes(p) ? addPlugs.filter(x => x !== p) : [...addPlugs, p])} />
              ))}
            </View>
            <Pressable onPress={() => setAddBe(!addBe)} style={{ paddingVertical: 10 }}>
              <Text style={st.name}>{addBe ? '☑' : '☐'} En Belgique (ta carte de recharge y fonctionne)</Text>
            </Pressable>
            <View style={[st.row, { justifyContent: 'flex-end', gap: 10, marginTop: 6 }]}>
              <Pressable style={{ paddingVertical: 12, paddingHorizontal: 10 }} onPress={() => setAdding(null)}>
                <Text style={st.sub}>Annuler</Text>
              </Pressable>
              <Pressable style={[st.go, { paddingVertical: 12, paddingHorizontal: 18 }]} onPress={saveAdd}>
                <Text style={st.goTxt}>Enregistrer</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>;
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 },
  title: { color: C.text, fontSize: 22, fontWeight: '800' },
  filters: { paddingHorizontal: 12, gap: 8, paddingBottom: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: C.card },
  chipOn: { backgroundColor: C.accent },
  chipTxt: { color: C.text, fontWeight: '600', fontSize: 13 },
  chipTxtOn: { color: '#0F2A1D' },
  err: { color: C.warn, paddingHorizontal: 14, fontSize: 12 },
  count: { color: C.muted, marginBottom: 2 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderRadius: 14, padding: 12 },
  kwBox: { width: 58, height: 58, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  kw: { fontSize: 20, fontWeight: '900' },
  kwUnit: { color: C.muted, fontSize: 11, marginTop: -2 },
  name: { color: C.text, fontWeight: '700', fontSize: 15 },
  sub: { color: C.muted, fontSize: 13, marginTop: 2 },
  src: { color: '#6F8F7E', fontSize: 11, marginTop: 3 },
  dist: { color: C.text, fontWeight: '700' },
  go: { backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  goTxt: { color: '#0F2A1D', fontWeight: '800' },
  pin: { minWidth: 34, paddingHorizontal: 5, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  pinTxt: { color: '#0F2A1D', fontWeight: '900', fontSize: 12 },
  mapHint: { position: 'absolute', bottom: 12, alignSelf: 'center', backgroundColor: 'rgba(15,42,29,0.85)', color: C.text, fontSize: 12, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  searchHere: { position: 'absolute', top: 12, alignSelf: 'center', backgroundColor: C.accent, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, elevation: 5 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 4 },
  sheetTitle: { color: C.text, fontSize: 20, fontWeight: '800', marginBottom: 4 },
  sheetKw: { fontSize: 26, fontWeight: '900', marginVertical: 8 },
  input: { backgroundColor: C.card, color: C.text, borderRadius: 10, padding: 12, marginTop: 10 },
});
