export function getBasePath(loc?: { hostname: string; pathname: string }): string {
  const currentLoc =
    loc || (typeof window !== 'undefined' ? window.location : { hostname: '', pathname: '' });

  // On GitHub Pages (*.github.io):
  if (currentLoc.hostname.endsWith('github.io')) {
    const parts = currentLoc.pathname
      .replace(/^\/|\/$/g, '')
      .split('/')
      .filter(Boolean);
    // If path starts with a repository segment (not an internal SPA route like 'analysis' or 'settings')
    if (parts.length > 0 && parts[0] !== 'analysis' && parts[0] !== 'settings') {
      return `/${parts[0]}`;
    }
  }

  const metaBase = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL : '';
  if (
    metaBase &&
    metaBase !== '.' &&
    metaBase !== './' &&
    !metaBase.startsWith('./') &&
    metaBase !== '/'
  ) {
    return metaBase.replace(/\/+$/, '');
  }

  return '';
}

export function getAnalysisUrl(
  id: string | number,
  loc?: { hostname: string; pathname: string },
): string {
  const base = getBasePath(loc);
  return `${base}/analysis/${encodeURIComponent(id)}`;
}

export function getSettingsUrl(loc?: { hostname: string; pathname: string }): string {
  const base = getBasePath(loc);
  return `${base}/settings`;
}

export function getGamesUrl(loc?: { hostname: string; pathname: string }): string {
  const base = getBasePath(loc);
  return base ? `${base}/` : '/';
}
