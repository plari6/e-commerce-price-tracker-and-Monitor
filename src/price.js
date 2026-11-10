// Price text -> { amount, currency }. Handles "1.299,99 €", "$1,299.99", "CHF 1'299.–", "1 299 zł", "¥12,800".

const SYMBOLS = [
  ['R$', 'BRL'], ['A$', 'AUD'], ['AU$', 'AUD'], ['C$', 'CAD'], ['CA$', 'CAD'], ['NZ$', 'NZD'], ['HK$', 'HKD'],
  ['US$', 'USD'], ['S$', 'SGD'], ['MX$', 'MXN'], ['zł', 'PLN'], ['Kč', 'CZK'], ['د.إ', 'AED'], ['ر.س', 'SAR'],
  ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['₹', 'INR'], ['₩', 'KRW'], ['₺', 'TRY'], ['₽', 'RUB'], ['₪', 'ILS'],
  ['₫', 'VND'], ['฿', 'THB'], ['₱', 'PHP'], ['$', 'USD'],
];
const CODES = /\b(USD|EUR|GBP|JPY|CNY|INR|AUD|CAD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BRL|MXN|AED|SAR|QAR|KWD|EGP|MAD|TRY|ZAR|SGD|HKD|NZD|KRW|ILS|THB|PHP|VND)\b/i;
const KR = /\bkr\.?(?=\s|$|\d)/i;
// Currencies with no minor unit: "12,800" / "12.800" is always thousands.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'HUF', 'CLP', 'ISK']);

export function detectCurrency(text, hint) {
  if (!text) return hint || null;
  const code = String(text).match(CODES);
  if (code) return code[1].toUpperCase();
  for (const [sym, cur] of SYMBOLS) {
    if (text.includes(sym)) {
      // "$" is shared by many currencies; trust the product/store hint when it is a dollar currency.
      if (sym === '$' && hint && /D$|MXN/.test(hint)) return hint;
      if (sym === '¥' && hint === 'CNY') return 'CNY';
      return cur;
    }
  }
  if (KR.test(text)) return hint && ['SEK', 'NOK', 'DKK'].includes(hint) ? hint : 'SEK';
  return hint || null;
}

/** Number from a price string. `structured` = machine value (JSON-LD/meta), where "." is the decimal mark. */
export function parseAmount(raw, { currency, structured = false } = {}) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  let s = String(raw).replace(/[   ]/g, ' ').trim();
  if (!s) return null;
  if (structured && /^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/\d[\d\s.,'’]*/);
  if (!m) return null;
  // Trailing separator ("1.299,–", "12,-", "99.") means no cents.
  const n = m[0].trim().replace(/[\s'’]/g, '').replace(/[.,]+$/, '');
  const dots = (n.match(/\./g) || []).length;
  const commas = (n.match(/,/g) || []).length;
  let value;
  if (dots && commas) {
    const decimal = n.lastIndexOf('.') > n.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    value = Number(n.split(thousands).join('').replace(decimal, '.'));
  } else if (dots || commas) {
    const sep = dots ? '.' : ',';
    const parts = n.split(sep);
    const last = parts[parts.length - 1];
    if (parts.length > 2) value = Number(parts.join(''));
    else if (last.length === 3 && (ZERO_DECIMAL.has(currency) || !structured)) {
      // "1,299" / "1.299" -> thousands. Only "0,999" style (leading zero) is a decimal.
      value = parts[0] === '0' ? Number(`0.${last}`) : Number(parts.join(''));
    } else value = Number(parts.join('.'));
  } else value = Number(n);
  return Number.isFinite(value) && value >= 0 ? round2(value) : null;
}

export function parsePrice(raw, { currencyHint, structured = false } = {}) {
  if (raw == null || raw === '') return null;
  const text = String(raw);
  const currency = detectCurrency(text, currencyHint);
  const amount = parseAmount(raw, { currency, structured });
  if (amount == null) return null;
  return { amount, currency: currency || currencyHint || null };
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function pctChange(from, to) {
  if (!from || from <= 0 || to == null) return null;
  return round2(((to - from) / from) * 100);
}

export function formatMoney(amount, currency) {
  if (amount == null) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: ZERO_DECIMAL.has(currency) ? 0 : 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || ''}`.trim();
  }
}

/** True when the price appears in the text in some common format (used to reject invented AI answers). */
export function priceAppearsIn(text, amount) {
  if (!text || amount == null) return false;
  const flat = text.replace(/[\s  '’]/g, '');
  const int = Math.trunc(amount);
  const cents = Math.round((amount - int) * 100);
  const intVariants = [String(int), int.toLocaleString('en-US'), int.toLocaleString('de-DE')].map((v) => v.replace(/\s/g, ''));
  for (const iv of intVariants) {
    if (cents === 0 ? flat.includes(iv) : flat.includes(`${iv}.${String(cents).padStart(2, '0')}`) || flat.includes(`${iv},${String(cents).padStart(2, '0')}`)) return true;
  }
  return false;
}
