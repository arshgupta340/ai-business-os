'use client';

import type {ReactNode} from 'react';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';

export type PageHeaderProps = {
  title: string;
  description?: string;
  /** Buttons or other controls, shown at the end of the header row. */
  actions?: ReactNode;
};

/** The page title (the page h1) with optional description and actions. */
export function PageHeader({title, description, actions}: PageHeaderProps) {
  return (
    <HStack gap={4} justify="between" vAlign="start" wrap="wrap">
      <VStack gap={1}>
        <Heading level={1}>{title}</Heading>
        {description ? (
          <Text type="body" color="secondary">
            {description}
          </Text>
        ) : null}
      </VStack>
      {actions ? (
        <HStack gap={2} vAlign="center">
          {actions}
        </HStack>
      ) : null}
    </HStack>
  );
}
