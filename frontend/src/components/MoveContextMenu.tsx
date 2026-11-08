import React, { useEffect, useRef } from 'react';
import {
  MessageSquarePlus,
  Sparkles,
  Trash2,
  Scissors,
  XCircle,
  ArrowUpRight,
  Loader2,
} from 'lucide-react';

export interface MoveContextMenuProps {
  x: number;
  y: number;
  isOpen: boolean;
  onClose: () => void;
  ply: number;
  moveLabel: string;
  isVariation?: boolean;
  hasComment?: boolean;
  isAiAnnotating?: boolean;
  onAddOrEditNote: () => void;
  onAnnotateWithAI: () => void;
  onDeleteNote: () => void;
  onDeleteFromHere?: () => void;
  onDeleteVariation?: () => void;
  onPromoteVariation?: () => void;
}

export const MoveContextMenu: React.FC<MoveContextMenuProps> = ({
  x,
  y,
  isOpen,
  onClose,
  moveLabel,
  isVariation = false,
  hasComment = false,
  isAiAnnotating = false,
  onAddOrEditNote,
  onAnnotateWithAI,
  onDeleteNote,
  onDeleteFromHere,
  onDeleteVariation,
  onPromoteVariation,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Position bounding within viewport
  const menuWidth = 190;
  const menuHeight = isVariation ? 220 : 130;
  const safeX = Math.min(Math.max(10, x), Math.max(10, window.innerWidth - menuWidth - 16));
  const safeY = Math.min(Math.max(10, y), Math.max(10, window.innerHeight - menuHeight - 16));

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={menuRef}
      style={{ top: `${safeY}px`, left: `${safeX}px` }}
      className="fixed z-50 min-w-[190px] rounded-lg shadow-xl border border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm py-1.5 text-xs text-slate-800 dark:text-slate-200 animate-in fade-in zoom-in-95 duration-100 select-none"
    >
      {/* Menu Header with move label */}
      <div className="px-3 py-1 text-[10.5px] font-mono font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800/80 mb-1 flex items-center justify-between">
        <span>Move {moveLabel}</span>
        {isVariation && (
          <span className="text-[9.5px] text-amber-600 dark:text-amber-400 font-sans font-medium">
            Variation
          </span>
        )}
      </div>

      {/* Add / Edit Note */}
      <button
        onClick={() => {
          onClose();
          onAddOrEditNote();
        }}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left"
      >
        <MessageSquarePlus size={13} className="shrink-0 text-blue-500" />
        <span>{hasComment ? 'Edit Note' : 'Add Note'}</span>
      </button>

      {/* Annotate with AI */}
      <button
        disabled={isAiAnnotating}
        onClick={() => {
          onClose();
          onAnnotateWithAI();
        }}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-purple-50 dark:hover:bg-purple-950/40 text-slate-700 dark:text-slate-300 hover:text-purple-600 dark:hover:text-purple-400 transition-colors text-left disabled:opacity-50"
      >
        {isAiAnnotating ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-purple-500" />
        ) : (
          <Sparkles size={13} className="shrink-0 text-purple-500" />
        )}
        <span>Annotate with AI</span>
      </button>

      {/* Delete Note (only if comment exists) */}
      {hasComment && (
        <button
          onClick={() => {
            onClose();
            onDeleteNote();
          }}
          className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 transition-colors text-left"
        >
          <Trash2 size={13} className="shrink-0 text-rose-500" />
          <span>Delete Note</span>
        </button>
      )}

      {/* Variation management options */}
      {isVariation && (
        <>
          <div className="h-px bg-slate-100 dark:border-slate-800 my-1" />

          {onDeleteFromHere && (
            <button
              onClick={() => {
                onClose();
                onDeleteFromHere();
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-amber-50 dark:hover:bg-amber-950/40 text-slate-700 dark:text-slate-300 hover:text-amber-600 dark:hover:text-amber-400 transition-colors text-left"
            >
              <Scissors size={13} className="shrink-0 text-amber-500" />
              <span>Delete from here</span>
            </button>
          )}

          {onDeleteVariation && (
            <button
              onClick={() => {
                onClose();
                onDeleteVariation();
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 transition-colors text-left"
            >
              <XCircle size={13} className="shrink-0 text-rose-500" />
              <span>Delete variation</span>
            </button>
          )}

          {onPromoteVariation && (
            <button
              onClick={() => {
                onClose();
                onPromoteVariation();
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-slate-700 dark:text-slate-300 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors text-left"
            >
              <ArrowUpRight size={13} className="shrink-0 text-emerald-500" />
              <span>Promote variation</span>
            </button>
          )}
        </>
      )}
    </div>
  );
};
