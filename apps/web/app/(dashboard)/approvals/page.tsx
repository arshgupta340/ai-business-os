'use client';

import {Suspense} from 'react';
import {LoadingState} from '@/components/LoadingState';
import {ApprovalsInbox} from './_components/ApprovalsInbox';

// The inbox reads ?id=<approvalId> to open the decision dialog, so it sits
// under Suspense as Next.js requires for useSearchParams.
export default function ApprovalsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading approvals" />}>
      <ApprovalsInbox />
    </Suspense>
  );
}
