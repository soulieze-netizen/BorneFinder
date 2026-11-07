// Clé Open Charge Map intégrée (utilisée si aucune clé n'est saisie dans les réglages).
export const OCM_KEY = 'a8c413a6-340d-4cad-87bf-a241efba19e8';

/** fetch avec délai max : évite le sablier infini quand un serveur ne répond pas. */
export async function fetchT(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  catch (e: any) { throw new Error(e?.name === 'AbortError' ? 'le serveur ne répond pas (délai dépassé)' : (e?.message ?? String(e))); }
  finally { clearTimeout(timer); }
}
