import React, { useEffect, useRef } from 'react';

export interface SeamlessNoteProps {
  text: string;
  onSave: (newText: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  className?: string;
  isTargeted?: boolean;
  inline?: boolean;
}

export const SeamlessNote: React.FC<SeamlessNoteProps> = ({
  text,
  onSave,
  onCancel,
  placeholder = 'Write a note...',
  className = '',
  isTargeted = false,
  inline = false,
}) => {
  const elRef = useRef<HTMLDivElement | HTMLSpanElement>(null);
  const textRef = useRef(text);
  const isFocusedRef = useRef(false);

  // Sync external text changes when the user is not actively typing
  useEffect(() => {
    textRef.current = text;
    if (!isFocusedRef.current && elRef.current) {
      if (elRef.current.textContent !== text) {
        elRef.current.textContent = text;
      }
    }
  }, [text]);

  // When targeted from context menu (Add Note / Edit Note), auto-focus and place caret at end
  useEffect(() => {
    if (isTargeted && elRef.current) {
      elRef.current.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(elRef.current);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, [isTargeted]);

  const handleBlur = (e: React.FocusEvent<HTMLElement>) => {
    isFocusedRef.current = false;
    const currentText = (e.currentTarget.textContent || '').trim();
    if (currentText !== textRef.current) {
      textRef.current = currentText;
      onSave(currentText);
    } else if (!currentText && isTargeted) {
      onCancel?.();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (elRef.current) {
        elRef.current.textContent = textRef.current;
      }
      onCancel?.();
      elRef.current?.blur();
    }
  };

  const handleInput = (e: React.FormEvent<HTMLElement>) => {
    const raw = e.currentTarget.textContent || '';
    if (!raw.trim()) {
      // Clear leftover <br> nodes so :empty pseudo-class matches for placeholder
      e.currentTarget.innerHTML = '';
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const plain = e.clipboardData.getData('text/plain');
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    sel.deleteFromDocument();
    sel.getRangeAt(0).insertNode(document.createTextNode(plain));
    sel.collapseToEnd();
  };

  const commonProps = {
    contentEditable: true,
    suppressContentEditableWarning: true,
    onFocus: () => {
      isFocusedRef.current = true;
    },
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    onInput: handleInput,
    onPaste: handlePaste,
    'data-placeholder': placeholder,
    title: 'Click anywhere to edit note (Enter to save)',
    className: `outline-none focus:outline-none cursor-text select-text transition-colors hover:bg-amber-100/30 dark:hover:bg-amber-950/20 focus:bg-amber-100/50 dark:focus:bg-amber-950/40 focus:ring-1 focus:ring-amber-500/40 rounded empty:before:content-[attr(data-placeholder)] empty:before:text-amber-800/40 dark:empty:before:text-amber-300/40 empty:before:pointer-events-none empty:before:font-normal ${className}`,
  };

  if (inline) {
    return (
      <span
        {...(commonProps as React.HTMLAttributes<HTMLSpanElement>)}
        ref={elRef as React.Ref<HTMLSpanElement>}
      />
    );
  }

  return (
    <div
      {...(commonProps as React.HTMLAttributes<HTMLDivElement>)}
      ref={elRef as React.Ref<HTMLDivElement>}
    />
  );
};
