import React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-slate-900 text-white hover:bg-slate-700 border-transparent dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200',
  secondary:
    'bg-white text-slate-800 hover:bg-slate-50 border-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:border-slate-700 dark:hover:bg-slate-800',
  ghost:
    'bg-transparent text-slate-600 hover:bg-slate-100 border-transparent dark:text-slate-300 dark:hover:bg-slate-800',
  danger:
    'bg-rose-600 text-white hover:bg-rose-700 border-transparent dark:bg-rose-700 dark:hover:bg-rose-600',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3.5 py-1.5 text-sm',
  lg: 'px-5 py-2.5 text-sm',
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors
        focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1 dark:focus:ring-offset-slate-900
        disabled:opacity-50 disabled:pointer-events-none cursor-pointer
        ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
