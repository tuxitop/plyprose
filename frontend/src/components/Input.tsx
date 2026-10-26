import React, { useId } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  rightElement?: React.ReactNode;
}

export function Input({
  label,
  hint,
  error,
  rightElement,
  className = '',
  id,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          className={`w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900
            placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-transparent
            disabled:bg-slate-50 disabled:text-slate-500
            dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500
            dark:focus:ring-slate-500 dark:disabled:bg-slate-800
            ${error ? 'border-rose-400 focus:ring-rose-300 dark:border-rose-600' : ''}
            ${rightElement ? 'pr-10' : ''}
            ${className}`}
          {...rest}
        />
        {rightElement && (
          <div className="absolute inset-y-0 right-0 flex items-center pr-2">{rightElement}</div>
        )}
      </div>
      {hint && !error && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Textarea({ label, hint, error, className = '', id, ...rest }: TextareaProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
      )}
      <textarea
        id={inputId}
        className={`w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono text-slate-900
          placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-transparent
          disabled:bg-slate-50 resize-y
          dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500
          dark:focus:ring-slate-500 dark:disabled:bg-slate-800
          ${error ? 'border-rose-400 focus:ring-rose-300 dark:border-rose-600' : ''}
          ${className}`}
        {...rest}
      />
      {hint && !error && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}
