// Plain HTTP fetch with browser-like headers. Cheap and fast: used first, Puppeteer only when needed.

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
];

export const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];

export function browserHeaders(ua = pickUA(), acceptLanguage = 'en-US,en;q=0.9') {
  return {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': acceptLanguage,
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };
}

export class FetchError extends Error {
  constructor(message, { status, kind } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // timeout | network | http | blocked
  }
}

/** GET a URL. Retries network errors and 5xx (not 403/429: those go to the browser engine). */
export async function httpGet(url, { timeoutMs = 25000, retries = 1, headers = {}, accept, fetchImpl = fetch } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetchImpl(url, {
        headers: { ...browserHeaders(), ...(accept ? { Accept: accept } : {}), ...headers },
        redirect: 'follow',
        signal: ctrl.signal,
      });
      const body = await res.text();
      clearTimeout(timer);
      if (res.status >= 500 && res.status !== 503 && attempt < retries) {
        lastErr = new FetchError(`HTTP ${res.status}`, { status: res.status, kind: 'http' });
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return { status: res.status, body, url: res.url || url, ms: Date.now() - t0, headers: res.headers };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === 'AbortError' ? new FetchError(`timeout after ${timeoutMs} ms`, { kind: 'timeout' }) : new FetchError(err.cause?.code || err.message, { kind: 'network' });
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));
