'use client';

import {useBusiness} from '@/lib/session';
import {LoadingState} from '@/components/LoadingState';
import {KnowledgeScreen} from './_components/KnowledgeScreen';

/** Business Knowledge (U-08). Everything below switches with the business selector. */
export default function KnowledgePage() {
  const {business} = useBusiness();
  if (!business) return <LoadingState label="Loading the business" />;
  return (
    <KnowledgeScreen
      key={business.id}
      businessId={business.id}
      businessName={business.name}
      category={business.category}
      timezone={business.timezone}
    />
  );
}
