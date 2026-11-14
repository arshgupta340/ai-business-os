'use client';

import {LoadingState} from '@/components/LoadingState';
import {useBusiness} from '@/lib/session';
import {PricesScreen} from './_components/PricesScreen';

/** Price edit (U-13, SHOULD). Follows the business selector. */
export default function PricesPage() {
  const {business} = useBusiness();
  if (!business) return <LoadingState label="Loading the business" />;
  return <PricesScreen key={business.id} businessId={business.id} businessName={business.name} timezone={business.timezone} />;
}
