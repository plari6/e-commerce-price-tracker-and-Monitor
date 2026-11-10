// Minimal robots.txt check (User-agent: * group, Allow/Disallow with * and $). Cached per origin.
import { httpGet } from './http.js';

const cache = new Map();

export function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.replace(/#.*$/, '').trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  const group = groups.find((g) => g.agents.some((a) => a.includes('pricetracker'))) || groups.find((g) => g.agents.includes('*'));
  return group ? group.rules.filter((r) => r.path) : [];
}

export function isAllowed(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    // Escape regex chars except "*" (wildcard) and a trailing "$" (end anchor).
    const body = r.path.endsWith('$') ? r.path.slice(0, -1) : r.path;
    const re = new RegExp('^' + body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (r.path.endsWith('$') ? '$' : ''));
    if (re.test(pathAndQuery) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

export async function robotsAllows(url, { timeoutMs = 8000, fetchImpl } = {}) {
  const u = new URL(url);
  if (!cache.has(u.origin)) {
    cache.set(u.origin, (async () => {
      try {
        const res = await httpGet(`${u.origin}/robots.txt`, { timeoutMs, retries: 0, accept: 'text/plain', fetchImpl });
        return res.status >= 200 && res.status < 300 ? parseRobots(res.body) : [];
      } catch {
        return [];
      }
    })());
  }
  return isAllowed(await cache.get(u.origin), u.pathname + u.search);
}

export const clearRobotsCache = () => cache.clear();
