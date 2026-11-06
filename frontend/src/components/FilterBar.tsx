import { RotateCcw, X } from 'lucide-react';
import { getTagCapsuleConfig } from '../lib/badges';
import type { CategoryFilter, Platform, ResultFilter, StatusFilter } from '../types';

interface FilterBarProps {
  status: StatusFilter;
  result: ResultFilter;
  platform: Platform;
  category: CategoryFilter;
  tag: string;
  availableTags?: string[];
  onStatus: (v: StatusFilter) => void;
  onResult: (v: ResultFilter) => void;
  onPlatform: (v: Platform) => void;
  onCategory: (v: CategoryFilter) => void;
  onTag: (v: string) => void;
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
  tag,
  availableTags = [],
  onStatus,
  onResult,
  onPlatform,
  onCategory,
  onTag,
}: FilterBarProps) {
  const activeCount = [
    status !== 'all',
    result !== 'all',
    platform !== 'all',
    category !== 'all',
    tag !== 'all',
  ].filter(Boolean).length;

  const isFiltered = activeCount > 0;

  const handleReset = () => {
    onStatus('all');
    onResult('all');
    onPlatform('all');
    onCategory('all');
    onTag('all');
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 sm:p-4 shadow-xs flex flex-col gap-3">
      {/* Symmetrical Filter Grid (No redundant header) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3 pt-0.5">
        {/* Left Column: Lifecycle, Origin & Tags */}
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

          <div className="flex items-center gap-3">
            <span className="w-18 sm:w-20 text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider shrink-0">
              Tag
            </span>
            <div className="flex items-center gap-1.5 max-w-full">
              <select
                value={tag}
                onChange={e => onTag(e.target.value)}
                className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/60 text-slate-700 dark:text-slate-300 shadow-inner focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
              >
                <option value="all">All Tags</option>
                {availableTags.map(t => {
                  const cfg = getTagCapsuleConfig(t);
                  return (
                    <option key={t} value={t}>
                      {cfg.category}: {cfg.name}
                    </option>
                  );
                })}
              </select>
              {tag !== 'all' && (
                <button
                  type="button"
                  onClick={() => onTag('all')}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Clear tag filter"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Game Result, Speed & Reset */}
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

          {isFiltered && (
            <div className="flex items-center gap-3">
              <span className="w-18 sm:w-20 shrink-0" />
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <RotateCcw size={12} />
                Reset all filters ({activeCount})
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
