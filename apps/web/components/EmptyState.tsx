'use client';

import type {ReactNode} from 'react';
import {EmptyState as AstryxEmptyState} from '@astryxdesign/core/EmptyState';

export type EmptyStateProps = {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
};

/** Thin wrapper over the Astryx EmptyState so every screen uses one import. */
export function EmptyState({title, description, icon, actions, headingLevel = 2}: EmptyStateProps) {
  return (
    <AstryxEmptyState
      title={title}
      description={description}
      icon={icon}
      actions={actions}
      headingLevel={headingLevel}
    />
  );
}
