import {Suspense} from 'react';
import {LoadingState} from '@/components/LoadingState';
import {LiveOperations} from './_components/LiveOperations';

// Live operations (U-05). The selected call is linkable: /activity?call=<callId>.
export default function ActivityPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading calls" />}>
      <LiveOperations />
    </Suspense>
  );
}
