import {Suspense} from 'react';
import {LoadingState} from '@/components/LoadingState';
import {BuildScreen} from './_components/BuildScreen';

// useSearchParams (the ?session= ID) needs a Suspense boundary in the App Router.
export default function BuildPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading the builder" />}>
      <BuildScreen />
    </Suspense>
  );
}
