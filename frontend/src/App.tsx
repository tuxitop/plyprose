import { useState } from 'react';
import { TopNav } from './components/TopNav';
import { GamesPage } from './pages/GamesPage';
import { SettingsPage } from './pages/SettingsPage';
import { AnalysisPage } from './pages/AnalysisPage';
import { useTheme } from './hooks/useTheme';

type Route = { page: 'games' } | { page: 'settings' } | { page: 'analysis'; id: number };

export default function App() {
  const [route, setRoute] = useState<Route>(() => {
    const path = window.location.pathname;
    if (path.startsWith('/analysis/')) {
      const id = parseInt(path.replace('/analysis/', ''), 10);
      if (!isNaN(id)) return { page: 'analysis', id };
    }
    if (path === '/settings') return { page: 'settings' };
    return { page: 'games' };
  });

  const { theme, toggle: toggleTheme } = useTheme();

  const navigate = (r: Route) => {
    setRoute(r);
    if (r.page === 'games') window.history.pushState({}, '', '/');
    else if (r.page === 'settings') window.history.pushState({}, '', '/settings');
    else if (r.page === 'analysis') window.history.pushState({}, '', `/analysis/${r.id}`);
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
          <AnalysisPage
            analysisId={route.id}
            theme={theme}
            onToggleTheme={toggleTheme}
            onBack={() => navigate({ page: 'games' })}
          />
        )}
      </main>
    </div>
  );
}
