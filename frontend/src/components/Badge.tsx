import React from 'react';
import type { Variant } from '../lib/badges';

export type { Variant };

const variantClasses: Record<Variant, string> = {
  emerald:
    'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800',
  rose: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800',
  slate:
    'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  blue: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800',
  amber:
    'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800',
  violet:
    'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950/60 dark:text-violet-300 dark:border-violet-800',
};

export interface BadgeProps {
  variant?: Variant;
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant = 'slate', children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
