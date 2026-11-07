import { useEffect, useState } from 'react';
import { TopNav } from './components/TopNav';
import { GamesPage } from './pages/GamesPage';
import { SettingsPage } from './pages/SettingsPage';
import { AnalysisPage } from './pages/AnalysisPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useTheme } from './hooks/useTheme';

type Route = { page: 'games' } | { page: 'settings' } | { page: 'analysis'; id: number | string };

function parseRoute(path: string): Route {
  if (path.startsWith('/analysis/')) {
    const raw = path.replace('/analysis/', '').trim();
    if (raw) {
      const decoded = decodeURIComponent(raw);
      const num = Number(decoded);
      return {
        page: 'analysis',
        id: !Number.isNaN(num) && String(num) === decoded ? num : decoded,
      };
    }
  }
  if (path === '/settings') return { page: 'settings' };
  return { page: 'games' };
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const { theme, toggle: toggleTheme } = useTheme();

  const navigate = (r: Route) => {
    setRoute(r);
    let target = '/';
    if (r.page === 'settings') target = '/settings';
    else if (r.page === 'analysis') target = `/analysis/${encodeURIComponent(r.id)}`;
    if (window.location.pathname !== target) {
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
          <GamesPage onViewReport={id => navigate({ page: 'analysis', id })} />
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
