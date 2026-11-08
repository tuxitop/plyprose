import React, { useState, useRef, useEffect } from 'react';
import { Check, X } from 'lucide-react';

export interface InlineCommentEditorProps {
  initialValue: string;
  onSave: (val: string) => void;
  onCancel: () => void;
  label?: string;
  placeholder?: string;
}

export const InlineCommentEditor: React.FC<InlineCommentEditorProps> = ({
  initialValue,
  onSave,
  onCancel,
  label,
  placeholder = 'Write a note... (Enter to save, Shift+Enter for newline, Esc to cancel)',
}) => {
  const [text, setText] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      // Move cursor to end
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSave(text.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="w-full bg-blue-50/70 dark:bg-blue-950/40 border border-blue-300 dark:border-blue-800 rounded-md p-1.5 shadow-xs my-1 animate-in fade-in duration-100">
      {label && (
        <div className="text-[10px] font-mono text-blue-600 dark:text-blue-400 mb-1 px-0.5 font-medium flex items-center justify-between">
          <span>{label}</span>
          <span className="text-[9px] text-slate-400 dark:text-slate-500 font-sans">
            Enter ↵ to save • Esc to cancel
          </span>
        </div>
      )}
      <textarea
        ref={textareaRef}
        rows={2}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full resize-none rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="mt-1 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          <X size={12} />
          <span>Cancel</span>
        </button>
        <button
          type="button"
          onClick={() => onSave(text.trim())}
          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 shadow-xs transition-colors cursor-pointer"
        >
          <Check size={12} />
          <span>Save</span>
        </button>
      </div>
    </div>
  );
};
