// Requête Overpass robuste : GET (plus fiable sur Android), plusieurs serveurs, délai max.
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export async function overpass(query: string, timeoutMs = 12000, budgetMs = 30000): Promise<any> {
  const errors: string[] = [];
  const start = Date.now();
  for (const base of SERVERS) {
    if (Date.now() - start > budgetMs) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // overpass-api.de refuse (HTTP 406) les requêtes sans identification d'appli.
      const res = await fetch(base, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'BorneFinder/1.0 (+https://github.com/soulieze-netizen/BorneFinder)',
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: 'data=' + encodeURIComponent(query),
      });
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
