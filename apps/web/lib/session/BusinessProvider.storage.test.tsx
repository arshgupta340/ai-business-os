// @vitest-environment jsdom
import {cleanup, render, screen, waitFor} from '@testing-library/react';
import {useState, type ReactNode} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, describe, expect, it} from 'vitest';
import {PENDING_APPROVALS_QUERY, useApprovals} from '@/lib/api';
import {createApiQueryClient} from '@/lib/api/provider';
import {requests, useMockServer} from '@/mocks/test-setup';
import {BusinessProvider, useBusiness} from './BusinessProvider';
import {BUSINESS_STORAGE_KEY} from './business-selection';

useMockServer();

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return (
    <QueryClientProvider client={client}>
      <BusinessProvider>{children}</BusinessProvider>
    </QueryClientProvider>
  );
}

// A screen that mounts together with the provider, the way a page does after a reload.
function Screen() {
  const {businessId} = useBusiness();
  const approvals = useApprovals(businessId, PENDING_APPROVALS_QUERY);
  return <output aria-label="loaded">{approvals.data ? businessId : 'no'}</output>;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('BusinessProvider and the stored business', () => {
  it('sends the first business-scoped call with the stored business, never the default', async () => {
    window.localStorage.setItem(BUSINESS_STORAGE_KEY, 'biz_barber_01');
    render(
      <Providers>
        <Screen />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByLabelText('loaded').textContent).toBe('biz_barber_01'));
    const scoped = requests.map((r) => new URL(r.url).searchParams.get('businessId')).filter((id) => id !== null);
    expect(scoped[0]).toBe('biz_barber_01');
    expect(scoped).not.toContain('biz_pizza_01');
  });

  it('reports no business and not ready before storage is read, so server HTML renders', async () => {
    const {renderToString} = await import('react-dom/server');
    function Probe() {
      const {businessId, isReady} = useBusiness();
      return <>{`${businessId ?? 'none'} ${isReady ? 'ready' : 'waiting'}`}</>;
    }
    const html = renderToString(
      <BusinessProvider>
        <Probe />
      </BusinessProvider>,
    );
    expect(html).toContain('none waiting');
  });
});
