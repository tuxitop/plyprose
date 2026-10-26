import { Settings, Sun, Moon } from 'lucide-react';
import type { Theme } from '../hooks/useTheme';

interface TopNavProps {
  theme: Theme;
  onToggleTheme: () => void;
  onSettings: () => void;
}

export function TopNav({ theme, onToggleTheme, onSettings }: TopNavProps) {
  return (
    <header className="h-12 bg-slate-900 dark:bg-slate-950 text-white flex items-center px-5 gap-3 shrink-0 border-b border-slate-800">
      <span className="text-lg leading-none" aria-hidden="true">
        ♟
      </span>
      <span className="font-semibold text-sm tracking-wide">PlyProse</span>
      <div className="flex-1" />

      {/* Theme toggle */}
      <button
        onClick={onToggleTheme}
        className="flex items-center gap-1.5 text-slate-300 hover:text-white text-xs px-2.5 py-1.5 rounded-md hover:bg-white/10 transition-colors"
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        <span className="hidden sm:inline capitalize">{theme}</span>
      </button>

      {/* Settings */}
      <button
        onClick={onSettings}
        className="flex items-center gap-1.5 text-slate-300 hover:text-white text-xs px-2.5 py-1.5 rounded-md hover:bg-white/10 transition-colors"
        aria-label="Settings"
      >
        <Settings size={14} />
        Settings
      </button>
    </header>
  );
}
