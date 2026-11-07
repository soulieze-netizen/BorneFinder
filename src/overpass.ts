// Requête Overpass robuste : GET (plus fiable sur Android), plusieurs serveurs, délai max.
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export async function overpass(query: string, timeoutMs = 30000): Promise<any> {
  const errors: string[] = [];
  for (const base of SERVERS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}?data=${encodeURIComponent(query)}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      clearTimeout(timer);
      return json;
    } catch (e: any) {
      clearTimeout(timer);
      errors.push(`${base.split('/')[2]} : ${e?.name === 'AbortError' ? 'trop lent' : e?.message ?? e}`);
    }
  }
  throw new Error(errors.join(' | '));
}
