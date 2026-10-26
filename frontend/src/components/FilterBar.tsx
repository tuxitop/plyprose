import { Filter, RotateCcw } from 'lucide-react';
import type { CategoryFilter, Platform, ResultFilter, StatusFilter } from '../types';

interface FilterBarProps {
  status: StatusFilter;
  result: ResultFilter;
  platform: Platform;
  category: CategoryFilter;
  onStatus: (v: StatusFilter) => void;
  onResult: (v: ResultFilter) => void;
  onPlatform: (v: Platform) => void;
  onCategory: (v: CategoryFilter) => void;
}

function SelectButtonGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-18 sm:w-20 text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider shrink-0">
        {label}
      </span>
      <div className="inline-flex p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/60 shadow-inner overflow-x-auto max-w-full">
        {options.map(o => {
          const isSelected = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all duration-150 cursor-pointer whitespace-nowrap ${
                isSelected
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-white/50 dark:hover:bg-slate-700/50'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function FilterBar({
  status,
  result,
  platform,
  category,
  onStatus,
  onResult,
  onPlatform,
  onCategory,
}: FilterBarProps) {
  const activeCount = [
    status !== 'all',
    result !== 'all',
    platform !== 'all',
    category !== 'all',
  ].filter(Boolean).length;

  const isFiltered = activeCount > 0;

  const handleReset = () => {
    onStatus('all');
    onResult('all');
    onPlatform('all');
    onCategory('all');
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 sm:p-4 shadow-xs flex flex-col gap-3">
      {/* Top Header Row with Active Count and Reset */}
      <div className="flex items-center justify-between pb-2.5 border-b border-slate-100 dark:border-slate-800/80">
        <div className="flex items-center gap-2">
          <Filter size={13} className="text-slate-400 dark:text-slate-500" />
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Filters</span>
          {isFiltered && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800">
              {activeCount} active
            </span>
          )}
        </div>

        {isFiltered && (
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 px-2 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <RotateCcw size={11} />
            Reset all
          </button>
        )}
      </div>

      {/* Two-Column Symmetrical Filter Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3.5 pt-0.5">
        {/* Left Column: Lifecycle & Origin */}
        <div className="flex flex-col gap-3">
          <SelectButtonGroup<StatusFilter>
            label="Status"
            value={status}
            onChange={onStatus}
            options={[
              { value: 'all', label: 'All' },
              { value: 'analyzed', label: 'Analyzed' },
              { value: 'unanalyzed', label: 'Pending' },
            ]}
          />

          <SelectButtonGroup<Platform>
            label="Platform"
            value={platform}
            onChange={onPlatform}
            options={[
              { value: 'all', label: 'All' },
              { value: 'chesscom', label: 'Chess.com' },
              { value: 'lichess', label: 'Lichess' },
              { value: 'manual', label: 'Manual' },
            ]}
          />
        </div>

        {/* Right Column: Game Result & Format */}
        <div className="flex flex-col gap-3">
          <SelectButtonGroup<ResultFilter>
            label="Result"
            value={result}
            onChange={onResult}
            options={[
              { value: 'all', label: 'All' },
              { value: 'win', label: 'Win' },
              { value: 'loss', label: 'Loss' },
              { value: 'draw', label: 'Draw' },
            ]}
          />

          <SelectButtonGroup<CategoryFilter>
            label="Speed"
            value={category}
            onChange={onCategory}
            options={[
              { value: 'all', label: 'All' },
              { value: 'Bullet', label: '🚀 Bullet' },
              { value: 'Blitz', label: '⚡ Blitz' },
              { value: 'Rapid', label: '⏱️ Rapid' },
              { value: 'Classical', label: '🏛️ Classical' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
