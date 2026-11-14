// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {useState, type ReactNode} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as api from '@/lib/api/client';
import {createApiQueryClient} from '@/lib/api/provider';
import {server} from '@/mocks/server';
import {TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {PublishPanel} from './PublishPanel';

// jsdom has no CSS.escape and no modal dialog methods, which the Astryx Dialog uses.
const g = globalThis as unknown as {CSS?: {escape?: (s: string) => string}};
g.CSS ??= {};
g.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

useMockServer();
afterEach(() => cleanup());

const PIZZA = 'biz_pizza_01';
const A = `${TEST_BASE_URL}/api`;

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function renderPanel() {
  const agent = await api.createAgent(PIZZA, {
    spec: {
      id: 'agt_publish_panel',
      businessId: PIZZA,
      version: 1,
      status: 'draft',
      guardrailVersion: 'v1',
      template: 'restaurant_order_taker',
      name: 'Panel Agent',
      channel: 'phone',
      goal: 'Take pickup orders by phone.',
      knowledgeScopes: ['catalog', 'hours'],
      capabilities: ['catalog.read', 'order.quote', 'order.propose', 'message.checkout.send'],
      writePolicy: 'owner_approval_each_action_bundle',
      escalation: 'explain_unsupported_or_offer_callback',
    },
  });
  const onPublished = vi.fn();
  render(
    <Providers>
      <PublishPanel
        businessId={PIZZA}
        agent={agent}
        route={{answeredBy: 'nobody', phoneNumber: '+15550100'}}
        blockingConflictCount={0}
        builderHref="/build?session=bld_1"
        timeZone="America/Los_Angeles"
        onPublished={onPublished}
        published={null}
      />
    </Providers>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', {name: 'Publish'}));
  });
  const dialog = await screen.findByRole('dialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', {name: 'Publish now'}));
  });
  return {dialog, onPublished};
}

describe('PublishPanel with the real builder answers', () => {
  it('lists each stop condition as a sentence with a link, and shows nothing as published', async () => {
    // apps/server/src/builder/publish/service.ts assertStopConditions on origin/arsh/integration.
    server.use(
      http.post(`${A}/agents/:id/publish`, () =>
        HttpResponse.json(
          {
            code: 'VALIDATION_FAILED',
            message: 'The agent cannot be published until these are fixed.',
            correlationId: 'cor_pub_1',
            retryable: false,
            details: {
              issues: [
                {path: 'missing_timezone', code: 'missing_timezone', message: 'The business has no time zone.'},
                {path: 'missing_message_consent_policy', code: 'missing_message_consent_policy', message: 'The message consent policy is missing.'},
              ],
            },
          },
          {status: 400},
        ),
      ),
    );
    const {dialog, onPublished} = await renderPanel();
    expect(await within(dialog).findByText('Publish was refused: some details are missing')).toBeTruthy();
    expect(within(dialog).getByText(/The business has no time zone\./)).toBeTruthy();
    expect(within(dialog).getByText(/there is no message consent policy/)).toBeTruthy();
    expect(within(dialog).getByRole('link', {name: 'Open Settings'}).getAttribute('href')).toBe('/settings');
    expect(within(dialog).getByRole('link', {name: 'Answer it in the builder chat'}).getAttribute('href')).toBe('/build?session=bld_1');
    expect(within(dialog).queryByText(/missing_timezone/)).toBeNull();
    expect(onPublished).not.toHaveBeenCalled();
  });

  it('names every provider that is not connected', async () => {
    server.use(
      http.post(`${A}/agents/:id/publish`, () =>
        HttpResponse.json(
          {
            code: 'INTEGRATION_UNAVAILABLE',
            message: 'A provider this agent needs is not reachable right now. Try again.',
            correlationId: 'cor_pub_2',
            retryable: true,
            details: {provider: 'twilio', providers: ['twilio', 'square']},
          },
          {status: 503},
        ),
      ),
    );
    const {dialog} = await renderPanel();
    expect(await within(dialog).findByText(/Twilio and Square are not connected\./)).toBeTruthy();
    expect(within(dialog).getByRole('button', {name: 'Try again'})).toBeTruthy();
  });
});
