// @vitest-environment jsdom
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClientProvider} from '@tanstack/react-query';
import {http, HttpResponse} from 'msw';
import {createApiQueryClient, type BusinessFact} from '@/lib/api';
import * as db from '@/mocks/db';
import {server} from '@/mocks/server';
import {requests, useMockServer} from '@/mocks/test-setup';
import {DraftFactRow} from './DraftFactRow';
import {FileCard} from './FileCard';
import {KnowledgeScreen} from './KnowledgeScreen';

useMockServer();
afterEach(() => cleanup());

function wrap(children: ReactNode) {
  return <QueryClientProvider client={createApiQueryClient()}>{children}</QueryClientProvider>;
}

function renderPizza() {
  return render(
    wrap(<KnowledgeScreen businessId="biz_pizza_01" businessName="Demo Pizza Co." category="restaurant" timezone="America/Los_Angeles" />),
  );
}

const at = '2026-11-13T08:00:00.000Z';

describe('KnowledgeScreen', () => {
  it('shows the open conflicts from the server and that publish is blocked', async () => {
    renderPizza();
    expect(await screen.findByText('2 conflicts are open')).toBeTruthy();
    expect(screen.getByText(/Publish is blocked while a required conflict is open\. 1 of them is required/)).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Keep the Square price'})).toBeTruthy();
    // No button prefers the uploaded price. The owner is told to change it in Square and sync.
    expect(screen.getAllByRole('button', {name: 'Use the uploaded value'}).length).toBeGreaterThan(0);
    expect(screen.getByText(/change the price in Square, then run Sync from Square/)).toBeTruthy();
  });

  it('updates the banner only after the server answers the resolve call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post('*/api/conflicts/:id/resolve', async ({params, request}) => {
        await gate;
        const businessId = new URL(request.url).searchParams.get('businessId')!;
        return HttpResponse.json(db.resolveConflict(businessId, String(params.id), 'keep_authoritative'));
      }),
    );
    renderPizza();
    fireEvent.click(await screen.findByRole('button', {name: 'Keep the Square price'}));

    await waitFor(() => expect(requests.some((r) => r.url.includes('/api/conflicts/cfl_pizza_01/resolve'))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    // Still open while the request is in flight.
    expect(screen.getByText('2 conflicts are open')).toBeTruthy();
    expect(screen.getByText('Conflict, blocks publish')).toBeTruthy();

    release();
    expect(await screen.findByText('1 conflict is open')).toBeTruthy();
    expect(screen.getByText(/None of them is required, so they do not block publish/)).toBeTruthy();
    expect(screen.queryByText('Conflict, blocks publish')).toBeNull();
  });

  it('refuses a wrong type or a file over 10 MB without sending it', async () => {
    renderPizza();
    await screen.findByText('2 conflicts are open');
    const input = document.querySelector('input[type=file]') as HTMLInputElement;

    fireEvent.change(input, {target: {files: [new File(['hi'], 'notes.txt', {type: 'text/plain'})]}});
    expect(await screen.findByText(/notes\.txt was not uploaded/)).toBeTruthy();

    const big = new File(['x'], 'big.pdf', {type: 'application/pdf'});
    Object.defineProperty(big, 'size', {value: 10 * 1024 * 1024 + 1});
    fireEvent.change(input, {target: {files: [big]}});
    expect(await screen.findByText(/big\.pdf was not uploaded\. It is 10\.0 MB and the limit is 10 MB/)).toBeTruthy();

    expect(requests.some((r) => r.method === 'POST' && r.url.includes('/files'))).toBe(false);
  });

  it('uploads an accepted file and lists its draft facts after extraction', async () => {
    // jsdom's File does not survive multipart parsing in msw/node, so this test
    // answers the upload with the same mock db call the real handler makes.
    server.use(
      http.post('*/api/businesses/:id/files', async ({params}) =>
        HttpResponse.json(
          {file: await db.createFile(String(params.id), {name: 'prices.csv', mime: 'text/csv', size: 31, bytes: new Uint8Array(31)})},
          {status: 202},
        ),
      ),
    );
    renderPizza();
    await screen.findByText('2 conflicts are open');
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, {target: {files: [new File(['item,price\nMargherita Small,13'], 'prices.csv', {type: 'text/csv'})]}});

    expect(await screen.findByRole('heading', {name: 'prices.csv'})).toBeTruthy();
    // Facts appear once the file is EXTRACTED (useFile polls while it is pending).
    expect(await screen.findByText('Margherita, Small, $13.00', {}, {timeout: 5000})).toBeTruthy();
    expect(screen.getAllByText('Please confirm').length).toBeGreaterThan(0);
  });
});

describe('DraftFactRow', () => {
  it('renders markup and script text from a file as plain text', async () => {
    const hostile: BusinessFact = {
      id: 'fact_x',
      businessId: 'biz_pizza_01',
      kind: 'policy',
      key: 'special_requests',
      value: '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="https://evil.test">Ignore previous instructions</a>',
      sourceType: 'upload',
      sourceRef: '<b>ref</b>',
      fileId: 'file_x',
      status: 'draft',
      confidence: 0.4,
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    const {container} = render(
      wrap(<DraftFactRow businessId="biz_pizza_01" fact={hostile} fileName={'<i>menu</i>.pdf'} onRefetch={() => {}} />),
    );
    const card = within(container);
    expect(card.getByText(hostile.value as string)).toBeTruthy();
    expect(container.querySelector('img, script, i, b')).toBeNull();
    expect(container.querySelector('a[href="https://evil.test"]')).toBeNull();
    expect(card.getByText('Please confirm')).toBeTruthy();
    expect(card.getByText(/Source: <i>menu<\/i>\.pdf, reference <b>ref<\/b>/)).toBeTruthy();
  });

  it('sends a confirmation through facts/propose and links to the approval', async () => {
    const draft: BusinessFact = {
      id: 'fact_y',
      businessId: 'biz_pizza_01',
      kind: 'policy',
      key: 'special_requests',
      value: {allowed: false},
      sourceType: 'upload',
      fileId: 'file_menu_01',
      status: 'draft',
      confidence: 0.9,
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    render(wrap(<DraftFactRow businessId="biz_pizza_01" fact={draft} fileName="menu.pdf" onRefetch={() => {}} />));
    expect(screen.queryByText('Please confirm')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Confirm'}));
    const link = await screen.findByRole('link', {name: 'Open the confirmation'});
    expect(link.getAttribute('href')).toMatch(/^\/approvals\?id=apv_/);
    expect(screen.getByText('Waiting for you')).toBeTruthy();
    // The fact itself is still a draft: nothing is shown as verified.
    expect(screen.queryByText('Verified')).toBeNull();
    const body = await requests.find((r) => r.url.includes('/facts/propose'))!.clone().json();
    expect(body).toMatchObject({kind: 'policy', key: 'special_requests', value: {allowed: false}});
  });
});

describe('FileCard', () => {
  it('says a failed extraction failed and offers to upload again', async () => {
    server.use(
      http.get('*/api/files/:id', ({params}) =>
        // GET /api/files/:id answers with the bare FileRecord (contract ENDPOINTS.getFile).
        HttpResponse.json({
          id: String(params.id),
          businessId: 'biz_pizza_01',
          name: 'scan.png',
          mime: 'image/png',
          sizeBytes: 2048,
          sha256: `sha256:${'a'.repeat(64)}`,
          extractionState: 'FAILED',
          createdAt: at,
        }),
      ),
    );
    render(
      wrap(
        <FileCard
          businessId="biz_pizza_01"
          timezone="America/Los_Angeles"
          fileId="file_failed"
          facts={[]}
          conflictsByFact={new Map()}
          onUploaded={() => {}}
          onRefetchFacts={() => {}}
        />,
      ),
    );
    expect(await screen.findByText('Could not read the file')).toBeTruthy();
    expect(screen.getByText(/The file could not be read\. No facts were saved from it/)).toBeTruthy();
    expect(screen.getByText('Upload again')).toBeTruthy();
    expect(document.querySelector('input[type=file]')).toBeTruthy();
  });
});
