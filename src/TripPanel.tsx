import { OCM_KEY } from './net';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Car, countryOf, DEFAULT_CAR, geocode, mapsLink, Place, Plan, planTrip } from './route';

const C = { bg: '#0F2A1D', card: '#163A29', text: '#F2F7F4', muted: '#9FB8AA', accent: '#3DDC84', warn: '#FFB74D' };

interface Props { position: { lat: number; lng: number } | null; ocmKey?: string }

export default function TripPanel({ position, ocmKey }: Props) {
  const [dest, setDest] = useState('');
  const [soc, setSoc] = useState('80');
  const [borderTarget, setBorderTarget] = useState('95');
  const [car, setCar] = useState<Car>(DEFAULT_CAR);
  const [matches, setMatches] = useState<Place[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showCar, setShowCar] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('trip').then(v => {
      if (!v) return;
      try { const t = JSON.parse(v); if (t.dest) setDest(t.dest); if (t.car) setCar({ ...DEFAULT_CAR, ...t.car }); if (t.borderTarget) setBorderTarget(t.borderTarget); } catch {}
    });
  }, []);
  const save = (patch: object) => AsyncStorage.getItem('trip').then(v => {
    const cur = v ? JSON.parse(v) : {};
    AsyncStorage.setItem('trip', JSON.stringify({ ...cur, ...patch }));
  }).catch(() => {});

  async function findDest() {
    setError(''); setPlan(null); setMatches([]);
    if (!dest.trim()) return;
    setBusy('Recherche de l\'adresse…');
    try {
      const r = await geocode(dest.trim());
      if (!r.length) setError('Adresse introuvable. Essaie « ville, pays ».');
      else if (r.length === 1) await compute(r[0]);
      else setMatches(r);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    setBusy('');
  }

  async function compute(to: Place) {
    setMatches([]); setError('');
    if (!position) { setError('Position inconnue : active la localisation.'); return; }
    const s = Math.max(1, Math.min(100, parseInt(soc, 10) || 0));
    save({ dest, car, borderTarget });
    try {
      setBusy('Calcul de l\'itinéraire et des bornes…');
      const country = await countryOf(position.lat, position.lng);
      const from: Place = { lat: position.lat, lng: position.lng, label: 'Ma position', country };
      const p = await planTrip(from, to, {
        car, startSoc: s, reserveSoc: 12, ocmKey: ocmKey?.trim() || OCM_KEY,
        borderTargetSoc: Math.max(50, Math.min(100, parseInt(borderTarget, 10) || 95)),
      });
      setPlan(p);
      // Ouvre directement le trajet complet (avec les arrêts recharge) dans Google Maps.
      Linking.openURL(mapsLink(p)).catch(() => {});
    } catch (e: any) { setError(e?.message ?? String(e)); }
    setBusy('');
  }

  const totalCharge = plan?.stops.reduce((n, s) => n + s.chargeMin, 0) ?? 0;
  const hm = (m: number) => `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}`;

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Text style={st.label}>Destination</Text>
      <TextInput value={dest} onChangeText={setDest} placeholder="ex. Saint-Omer, France" placeholderTextColor={C.muted}
        style={st.input} onSubmitEditing={findDest} returnKeyType="search" />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={st.label}>Batterie au départ (%)</Text>
          <TextInput value={soc} onChangeText={setSoc} keyboardType="number-pad" style={st.input} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={st.label}>Charge avant frontière (%)</Text>
          <TextInput value={borderTarget} onChangeText={setBorderTarget} keyboardType="number-pad" style={st.input} />
        </View>
      </View>

      <Pressable onPress={() => setShowCar(!showCar)}>
        <Text style={st.muted}>🚗 Voiture : {car.capacityKwh} kWh · {car.consumption} kWh/100 km · {car.maxDcKw} kW {showCar ? '▲' : '▼ modifier'}</Text>
      </Pressable>
      {showCar && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {([['capacityKwh', 'Batterie kWh'], ['consumption', 'Conso /100'], ['maxDcKw', 'Charge max kW']] as const).map(([k, l]) => (
            <View key={k} style={{ flex: 1 }}>
              <Text style={st.label}>{l}</Text>
              <TextInput defaultValue={String(car[k])} keyboardType="decimal-pad" style={st.input}
                onEndEditing={e => { const v = parseFloat(e.nativeEvent.text.replace(',', '.')); if (v > 0) { const c = { ...car, [k]: v }; setCar(c); save({ car: c }); } }} />
            </View>
          ))}
        </View>
      )}

      <Pressable style={st.btn} onPress={findDest} disabled={!!busy}>
        <Text style={st.btnTxt}>{busy ? 'Calcul…' : '🧭 Calculer le trajet'}</Text>
      </Pressable>

      {!!busy && <View style={{ alignItems: 'center', gap: 6 }}><ActivityIndicator color={C.accent} /><Text style={st.muted}>{busy}</Text></View>}
      {!!error && <Text style={{ color: C.warn }}>⚠️ {error}</Text>}

      {matches.map(m => (
        <Pressable key={`${m.lat},${m.lng}`} style={st.card} onPress={() => compute(m)}>
          <Text style={st.text}>{m.label}</Text><Text style={st.muted}>{m.country}</Text>
        </Pressable>
      ))}

      {plan && (
        <View style={{ gap: 10 }}>
          <View style={st.card}>
            <Text style={st.title}>{plan.to.label}</Text>
            <Text style={st.text}>{Math.round(plan.km)} km · conduite {hm(plan.driveMin)} · recharge {hm(totalCharge)}</Text>
            {plan.border && (
              <Text style={[st.big, { fontSize: 20, color: C.text }]}>🇧🇪→ Frontière (km {Math.round(plan.border.km)}) ≈ {Math.round(plan.border.soc)} %</Text>
            )}
            <Text style={[st.big, { color: plan.arrivalSoc >= 20 ? C.accent : C.warn }]}>Arrivée ≈ {Math.round(plan.arrivalSoc)} %</Text>
          </View>
          {plan.warnings.map((w, i) => <Text key={i} style={{ color: C.warn }}>⚠️ {w}</Text>)}
          {plan.stops.length === 0 && <Text style={st.text}>✅ Pas d'arrêt nécessaire.</Text>}
          {plan.stops.map((s, i) => (
            <View key={s.station.id + i} style={st.card}>
              <Text style={st.reason}>{s.reason}</Text>
              <Text style={st.title}>{i + 1}. {s.station.name}</Text>
              {s.station.operator && <Text style={st.muted}>{s.station.operator}</Text>}
              <Text style={st.text}>
                {s.station.maxKw ? `${Math.round(s.station.maxKw)} kW` : '? kW'} · km {Math.round(s.station.progressKm)} · {s.station.detourKm.toFixed(1)} km de la route
              </Text>
              <Text style={st.text}>Arrivée {Math.round(s.arriveSoc)} % → charger à {Math.round(s.leaveSoc)} % · ~{s.chargeMin} min</Text>
              {s.station.inBelgium
                ? <Text style={st.muted}>💳 Carte entreprise</Text>
                : s.station.price ? <Text style={[st.muted, { color: C.warn }]}>💶 {s.station.price} (non vérifié)</Text> : null}
              <Pressable style={[st.btn, { paddingVertical: 8, marginTop: 6 }]}
                onPress={() => Linking.openURL(`google.navigation:q=${s.station.lat},${s.station.lng}`).catch(() =>
                  Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${s.station.lat},${s.station.lng}`))}>
                <Text style={st.btnTxt}>Y aller</Text>
              </Pressable>
            </View>
          ))}
          <Pressable style={st.btn} onPress={() => Linking.openURL(mapsLink(plan))}>
            <Text style={st.btnTxt}>🗺 Trajet complet dans Google Maps (avec arrêts)</Text>
          </Pressable>
          <Text style={st.muted}>Estimation : le froid, le vent et la vitesse changent la consommation. Marge de 12 % gardée à chaque arrêt.</Text>
        </View>
      )}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  label: { color: C.muted, fontSize: 12, marginBottom: 4 },
  input: { backgroundColor: C.card, color: C.text, borderRadius: 10, padding: 12, fontSize: 16 },
  muted: { color: C.muted, fontSize: 13 },
  text: { color: C.text, fontSize: 14, marginTop: 2 },
  title: { color: C.text, fontSize: 17, fontWeight: '800' },
  big: { fontSize: 24, fontWeight: '900', marginTop: 6 },
  reason: { color: C.accent, fontWeight: '800', marginBottom: 4 },
  card: { backgroundColor: C.card, borderRadius: 14, padding: 14 },
  btn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  btnTxt: { color: '#0F2A1D', fontWeight: '800', fontSize: 15 },
});
