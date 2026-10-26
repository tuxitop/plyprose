export interface TimeControlInfo {
  label: string;
  icon: string;
  seconds: number;
  raw: string;
  platform: string;
}

function parseTC(tc: string): [number, number] | null {
  const m = tc.trim().match(/^(\d+)\+(\d+)$/);
  if (m) return [parseInt(m[1]), parseInt(m[2])];
  const m2 = tc.trim().match(/^(\d+)$/);
  if (m2) return [parseInt(m2[1]), 0];
  return null;
}

export function classifyTimeControl(tc: string, platform: string): TimeControlInfo {
  const parsed = parseTC(tc);
  const plat = platform.toLowerCase();

  if (!parsed) return { label: 'Unknown', icon: '❓', seconds: 0, raw: tc, platform };

  const [base, inc] = parsed;

  if (plat === 'chesscom' || plat === 'chess.com') {
    const seconds = base + inc * 1;
    let label: string, icon: string;
    if (seconds < 180) {
      label = 'Bullet';
      icon = '🚀';
    } else if (seconds < 600) {
      label = 'Blitz';
      icon = '⚡';
    } else if (seconds < 3600) {
      label = 'Rapid';
      icon = '⏱️';
    } else {
      label = 'Daily';
      icon = '🏛️';
    }
    return { label, icon, seconds, raw: tc, platform };
  }

  if (plat === 'lichess') {
    const seconds = base + inc * 40;
    let label: string, icon: string;
    if (seconds <= 29) {
      label = 'UltraBullet';
      icon = '🚀';
    } else if (seconds <= 179) {
      label = 'Bullet';
      icon = '🚀';
    } else if (seconds <= 479) {
      label = 'Blitz';
      icon = '⚡';
    } else if (seconds <= 1499) {
      label = 'Rapid';
      icon = '⏱️';
    } else {
      label = 'Classical';
      icon = '🏛️';
    }
    return { label, icon, seconds, raw: tc, platform };
  }

  // Manual / generic — FIDE fallback
  const seconds = base + inc * 40;
  let label: string, icon: string;
  if (seconds <= 179) {
    label = 'Bullet';
    icon = '🚀';
  } else if (seconds <= 479) {
    label = 'Blitz';
    icon = '⚡';
  } else if (seconds <= 1499) {
    label = 'Rapid';
    icon = '⏱️';
  } else {
    label = 'Classical';
    icon = '🏛️';
  }
  return { label, icon, seconds, raw: tc, platform };
}

export function formatTC(tc: string): string {
  const parsed = parseTC(tc);
  if (!parsed) return tc;
  const [base, inc] = parsed;
  const mins = Math.floor(base / 60);
  const secs = base % 60;
  const baseStr = secs === 0 ? `${mins}` : `${mins}:${String(secs).padStart(2, '0')}`;
  return inc > 0 ? `${baseStr}+${inc}` : baseStr;
}

export function formatGameTimeLocal(playedAt?: string, date?: string, createdAt?: string): string {
  const raw = playedAt || date || createdAt;
  if (!raw) return '—';

  const match = raw.match(/^(\d{4})[./-](\d{2})[./-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) {
    const [, y, m, d, hh, mm, ss] = match;
    if (hh !== undefined && mm !== undefined) {
      const sec = ss ? parseInt(ss, 10) : 0;
      const utcDate = new Date(
        Date.UTC(
          parseInt(y, 10),
          parseInt(m, 10) - 1,
          parseInt(d, 10),
          parseInt(hh, 10),
          parseInt(mm, 10),
          sec,
        ),
      );

      if (!isNaN(utcDate.getTime())) {
        const localYear = utcDate.getFullYear();
        const localMonth = String(utcDate.getMonth() + 1).padStart(2, '0');
        const localDay = String(utcDate.getDate()).padStart(2, '0');
        const localHour = String(utcDate.getHours()).padStart(2, '0');
        const localMinute = String(utcDate.getMinutes()).padStart(2, '0');
        const localSecond = String(utcDate.getSeconds()).padStart(2, '0');
        return ss !== undefined
          ? `${localYear}-${localMonth}-${localDay} ${localHour}:${localMinute}:${localSecond}`
          : `${localYear}-${localMonth}-${localDay} ${localHour}:${localMinute}`;
      }
    }
    return `${y}-${m}-${d}`;
  }

  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) {
    const localYear = parsed.getFullYear();
    const localMonth = String(parsed.getMonth() + 1).padStart(2, '0');
    const localDay = String(parsed.getDate()).padStart(2, '0');
    const localHour = String(parsed.getHours()).padStart(2, '0');
    const localMinute = String(parsed.getMinutes()).padStart(2, '0');
    const localSecond = String(parsed.getSeconds()).padStart(2, '0');
    return `${localYear}-${localMonth}-${localDay} ${localHour}:${localMinute}:${localSecond}`;
  }

  return raw;
}

export const formatGameTime = formatGameTimeLocal;
