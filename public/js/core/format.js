// core/format.js — number, currency, date and relative-time formatting.
// Indian numbering (lakh/crore) is used throughout since this is an India-equities dashboard.

const INR_GROUPER = new Intl.NumberFormat('en-IN');

// 12,34,567 style grouping for a plain number.
export function formatNumber(value, { decimals = 0 } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

// ₹ amount already expressed in crore, e.g. 255000 -> "₹2,55,000 Cr".
export function formatCrore(value, { decimals = 0 } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `₹${formatNumber(value, { decimals })} Cr`;
}

// Plain rupee price, e.g. 1652.4 -> "₹1,652.40".
export function formatRupee(value, { decimals = 2 } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `₹${formatNumber(value, { decimals })}`;
}

// Large rupee-crore figures collapsed to lakh crore once they cross 4 digits, e.g. 1912450 -> "₹19.12 L Cr".
export function formatCroreCompact(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (Math.abs(value) >= 100000) return `₹${(value / 100000).toFixed(2)} L Cr`;
  return formatCrore(value);
}

// Signed percentage with a fixed decimal count, e.g. 3.4 -> "+3.4%", -1.2 -> "-1.2%".
export function formatPct(value, { decimals = 1, signed = true } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

// "Beat / Miss / positive-negative" style tone classifier shared by stat cards, pills, table cells.
export function toneForValue(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'neutral';
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const TIME_FORMATTER = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

// "10 Aug 2026"
export function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_FORMATTER.format(date);
}

// "9:12 AM"
export function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return TIME_FORMATTER.format(date);
}

const RELATIVE_UNITS = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
  ['second', 1000],
];
const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });

// "2m ago", "just now", "3d ago" — driven off Date.now() so it stays correct as time passes.
export function formatRelativeTime(value, now = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = date.getTime() - now;
  const abs = Math.abs(diffMs);
  if (abs < 10 * 1000) return 'just now';
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (abs >= unitMs || unit === 'second') {
      const amount = Math.round(diffMs / unitMs);
      return RELATIVE_FORMATTER.format(amount, unit);
    }
  }
  return 'just now';
}

// Compact large counts for badges, e.g. 12450 -> "12.5k".
export function formatCompact(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
