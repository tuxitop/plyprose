import React from 'react';
import { getTagCapsuleConfig } from '../lib/badges';

export interface TagCapsuleProps {
  tag: string;
  size?: 'sm' | 'md';
  title?: string;
  className?: string;
}

export const TagCapsule: React.FC<TagCapsuleProps> = ({
  tag,
  size = 'md',
  title,
  className = '',
}) => {
  const cfg = getTagCapsuleConfig(tag);

  const isSmall = size === 'sm';

  const containerClasses = isSmall
    ? 'inline-flex items-stretch rounded-full text-[10px] font-medium border overflow-hidden select-none'
    : 'inline-flex items-stretch rounded-full text-xs font-medium border overflow-hidden select-none';

  const categoryClasses = isSmall
    ? `inline-flex items-center justify-center px-1.5 py-0.5 text-[8px] font-bold tracking-wider uppercase border-r border-slate-300/80 dark:border-slate-700/80 leading-none ${cfg.categoryBg} ${cfg.categoryText}`
    : `inline-flex items-center justify-center px-2 py-0.5 text-[9px] font-bold tracking-wider uppercase border-r border-slate-300/80 dark:border-slate-700/80 leading-none ${cfg.categoryBg} ${cfg.categoryText}`;

  const valueClasses = isSmall
    ? `inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap leading-none ${cfg.valueBg} ${cfg.valueText}`
    : `inline-flex items-center justify-center px-2 py-0.5 text-xs font-semibold whitespace-nowrap leading-none ${cfg.valueBg} ${cfg.valueText}`;

  return (
    <span
      className={`${containerClasses} ${cfg.border} ${className}`}
      title={title || `${cfg.category}: ${cfg.name}`}
    >
      <span className={categoryClasses}>{cfg.category}</span>
      <span className={valueClasses}>{cfg.name}</span>
    </span>
  );
};
