import React from 'react';
import type { ClassificationType } from '../lib/badges';

interface MoveBadgeGlyphProps {
  type: ClassificationType;
  className?: string;
  style?: React.CSSProperties;
}

export function MoveBadgeGlyph({ type, className = 'w-4 h-4', style }: MoveBadgeGlyphProps) {
  switch (type) {
    case 'blunder':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          <path d="M4.5 7a3 3 0 0 1 5.8.9c0 2-2.9 2.7-2.9 4.3" />
          <path d="M7.4 17.5h.01" />
          <path d="M13.7 7a3 3 0 0 1 5.8.9c0 2-2.9 2.7-2.9 4.3" />
          <path d="M16.6 17.5h.01" />
        </svg>
      );
    case 'mistake':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          <path d="M8 7.5a4 4 0 0 1 7.8 1.4c0 2.8-4 3.7-4 5.6" />
          <path d="M11.8 18.8h.01" />
        </svg>
      );
    case 'inaccuracy':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.0"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          <path d="M4.2 7a3 3 0 0 1 5.8.9c0 2-2.9 2.7-2.9 4.3" />
          <path d="M7.1 17.5h.01" />
          <path d="M16.8 4.5v9" />
          <path d="M16.8 17.5h.01" />
        </svg>
      );
    case 'miss':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          <path d="M5.5 5.5l13 13M18.5 5.5l-13 13" />
        </svg>
      );
    case 'brilliant':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          <path d="M8 3.5v10" />
          <path d="M8 18.5h.01" />
          <path d="M16 3.5v10" />
          <path d="M16 18.5h.01" />
        </svg>
      );
    case 'great':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          <path d="M12 3.5v10" />
          <path d="M12 18.5h.01" />
        </svg>
      );
    case 'best':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    case 'checkmate':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          <path d="M9 3l-2 18M17 3l-2 18M3.5 8.5h17M3.5 15.5h17" />
        </svg>
      );
  }
}
