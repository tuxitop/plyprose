import { useEffect, useState } from 'react';
import { TopNav } from './components/TopNav';
import { GamesPage } from './pages/GamesPage';
import { SettingsPage } from './pages/SettingsPage';
import { AnalysisPage } from './pages/AnalysisPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useTheme } from './hooks/useTheme';

type Route = { page: 'games' } | { page: 'settings' } | { page: 'analysis'; id: number | string };

function getBasePath(): string {
  const base = import.meta.env.BASE_URL || '/';
  if (base === './' || base === '/') return '';
  return base.replace(/\/+$/, '');
}

function parseRoute(path: string): Route {
  const base = getBasePath();
  let cleanPath = path;
  if (base && cleanPath.startsWith(base)) {
    cleanPath = cleanPath.slice(base.length);
  }
  if (!cleanPath.startsWith('/')) {
    cleanPath = '/' + cleanPath;
  }

  // Handle SPA redirect from 404.html (e.g. ?p=/analysis/game-123)
  if (typeof window !== 'undefined') {
    const searchParams = new URLSearchParams(window.location.search);
    const p = searchParams.get('p');
    if (p) {
      cleanPath = p.startsWith('/') ? p : '/' + p;
    }
  }

  if (cleanPath.startsWith('/analysis/')) {
    const raw = cleanPath.replace('/analysis/', '').trim();
    if (raw) {
      const decoded = decodeURIComponent(raw);
      const num = Number(decoded);
      return {
        page: 'analysis',
        id: !Number.isNaN(num) && String(num) === decoded ? num : decoded,
      };
    }
  }
  if (cleanPath === '/settings') return { page: 'settings' };
  return { page: 'games' };
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    // If arriving from 404.html redirect (?p=...), clean up URL
    const searchParams = new URLSearchParams(window.location.search);
    const p = searchParams.get('p');
    if (p) {
      const base = getBasePath();
      const cleanTarget = `${base}${p.startsWith('/') ? p : '/' + p}`;
      window.history.replaceState({}, '', cleanTarget);
    }

    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const { theme, toggle: toggleTheme } = useTheme();

  const navigate = (r: Route) => {
    setRoute(r);
    const base = getBasePath();
    let sub = '/';
    if (r.page === 'settings') sub = '/settings';
    else if (r.page === 'analysis') sub = `/analysis/${encodeURIComponent(r.id)}`;
    const target = `${base}${sub}`;
    if (window.location.pathname !== target || window.location.search) {
      window.history.pushState({}, '', target);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors">
      {route.page !== 'analysis' && (
        <TopNav
          theme={theme}
          onToggleTheme={toggleTheme}
          onSettings={() => navigate({ page: 'settings' })}
        />
      )}
      <main className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        {route.page === 'games' && (
          <GamesPage
            onViewReport={id => navigate({ page: 'analysis', id })}
            onSettings={() => navigate({ page: 'settings' })}
          />
        )}
        {route.page === 'settings' && <SettingsPage onBack={() => navigate({ page: 'games' })} />}
        {route.page === 'analysis' && (
          <ErrorBoundary fallbackTitle="Could not load game analysis view">
            <AnalysisPage
              analysisId={route.id}
              theme={theme}
              onToggleTheme={toggleTheme}
              onBack={() => navigate({ page: 'games' })}
            />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
