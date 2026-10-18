/**
 * Human-readable formatting helpers shared by all VYRO UI.
 * Pure functions; safe for server and client components.
 */

/** "now", "5m", "3h", "2d", "4w", "6mo", "1y" style time-ago from an ISO timestamp. */
export function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** 1.2K / 3.4M style compact counts. Negative or NaN values clamp to 0. */
export function compactCount(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : trim1(k)}K`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : trim1(m)}M`;
}

function trim1(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/** "0:42", "3:07", "1:12:05" duration formatting for seconds. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (!totalSeconds || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "";
  }
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? `${m}`.padStart(2, "0") : `${m}`;
  const ss = `${sec}`.padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Pluralize a count label: 1 like / 2 likes. */
export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
