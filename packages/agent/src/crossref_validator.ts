const CROSSREF_API = 'https://api.crossref.org/works';

export async function validateDOI(doi: string): Promise<boolean> {
  try {
    const res = await fetch(`${CROSSREF_API}/${encodeURIComponent(doi)}`, {
      headers: { 'User-Agent': 'HIVE/0.1 (mailto:enrique.gordoncillo@gmail.com)' },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
