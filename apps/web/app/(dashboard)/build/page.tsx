import {Suspense} from 'react';
import {LoadingState} from '@/components/LoadingState';
import {isDemoScript} from '@/lib/env';
import {BuildScreen} from './_components/BuildScreen';
import {DemoScreen} from './demo/DemoScreen';

// useSearchParams (the ?session= ID) needs a Suspense boundary in the App Router.
// NEXT_PUBLIC_DEMO_SCRIPT=1 shows the scripted demo path (issue #152) instead of the builder.
export default function BuildPage() {
  if (isDemoScript()) return <DemoScreen />;
  return (
    <Suspense fallback={<LoadingState label="Loading the builder" />}>
      <BuildScreen />
    </Suspense>
  );
}
