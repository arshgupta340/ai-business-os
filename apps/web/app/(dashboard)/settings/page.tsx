'use client';

import {LoadingState} from '@/components/LoadingState';
import {useBusiness} from '@/lib/session';
import {SettingsScreen} from './_components/SettingsScreen';

/** Settings (U-09). Everything below switches with the business selector. */
export default function SettingsPage() {
  const {business} = useBusiness();
  if (!business) return <LoadingState label="Loading the business" />;
  return <SettingsScreen key={business.id} businessId={business.id} timezone={business.timezone} />;
}
