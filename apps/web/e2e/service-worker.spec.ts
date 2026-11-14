import {expect, test, type BrowserContext, type Response} from '@playwright/test';
import {pageHeading, ProblemCollector, SLOW} from './helpers';

/**
 * The mock service worker path. Every API request in mock mode must be
 * answered in the browser: by the MSW service worker, or by the in-page mock
 * when no worker can register. None may reach the Next server (it has no API
 * routes and answers 404), and no service worker error may be logged.
 */

/** Signs the demo owner in before any page script runs, so the first load goes straight to a dashboard screen. */
async function seedMockSession(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // Init scripts also run in documents without storage (about:blank, opaque
    // origins). Only the app's own origin needs the session.
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;
    try {
      window.localStorage.setItem('abos.mockSession', JSON.stringify({owner: {email: 'owner@demo.test', displayName: 'Demo owner'}}));
    } catch {
      // No storage in this document.
    }
  });
}

function isApi(response: Response): boolean {
  return new URL(response.url()).pathname.startsWith('/api/');
}

/** Service worker errors that the browser or MSW write to the console. */
const SW_ERROR = /service ?worker|mockServiceWorker|\[MSW\]/i;

test.describe('mock service worker', () => {
  test('first load on a fresh browser context: the first API request is answered by the mock', async ({browser}) => {
    const context = await browser.newContext();
    await seedMockSession(context);
    const problems = new ProblemCollector();
    problems.attach(context);
    const swMessages: string[] = [];
    const page = await context.newPage();
    page.on('console', (m) => {
      if ((m.type() === 'error' || m.type() === 'warning') && SW_ERROR.test(m.text())) swMessages.push(`${m.type()}: ${m.text()}`);
    });

    const firstApi = page.waitForResponse(isApi, {timeout: SLOW * 2});
    await page.goto('/overview');
    const first = await firstApi;
    expect(first.fromServiceWorker(), `first API response ${first.url()} came from the network`).toBe(true);
    expect(first.status()).toBe(200);

    await expect(pageHeading(page, 'Overview')).toBeVisible({timeout: SLOW});
    await expect(page.getByText('Demo Pizza Co.').first()).toBeVisible({timeout: SLOW});
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toMatch(/\/mockServiceWorker\.js$/);

    // A reload with an existing registration takes the update check path.
    await page.reload();
    await expect(pageHeading(page, 'Overview')).toBeVisible({timeout: SLOW});
    await expect(page.getByText('Demo Pizza Co.').first()).toBeVisible({timeout: SLOW});

    expect(swMessages).toEqual([]);
    expect(problems.apiFromNetwork).toEqual([]);
    problems.expectClean('service worker first load');
    await context.close();
  });

  test('hard reload (page not controlled, registration exists): no API request reaches the server', async ({browser, browserName}) => {
    test.skip(browserName !== 'chromium', 'Uses the Chrome DevTools Protocol for a cache-bypassing reload.');
    const context = await browser.newContext();
    await seedMockSession(context);
    const problems = new ProblemCollector();
    problems.attach(context);
    const page = await context.newPage();
    await page.goto('/overview');
    await expect(page.getByText('Demo Pizza Co.').first()).toBeVisible({timeout: SLOW});
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), {timeout: SLOW}).toBe(true);

    // Like Shift+Reload: the new document starts without a controller while
    // the registration exists. msw then reloads the page once more.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.reload', {ignoreCache: true});
    await expect(pageHeading(page, 'Overview')).toBeVisible({timeout: SLOW});
    await expect(page.getByText('Demo Pizza Co.').first()).toBeVisible({timeout: SLOW});
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), {timeout: SLOW}).toBe(true);

    expect(problems.apiFromNetwork).toEqual([]);
    problems.expectClean('hard reload');
    await context.close();
  });

  test('no service worker allowed: the in-page mock answers instead', async ({browser}) => {
    const context = await browser.newContext({serviceWorkers: 'block'});
    await seedMockSession(context);
    const problems = new ProblemCollector();
    problems.attach(context);
    const page = await context.newPage();
    const fallbackNotice = page.waitForEvent('console', {predicate: (m) => /Using the in-page mock instead/.test(m.text()), timeout: SLOW * 2});
    await page.goto('/overview');
    await fallbackNotice;
    await expect(pageHeading(page, 'Overview')).toBeVisible({timeout: SLOW});
    await expect(page.getByText('Demo Pizza Co.').first()).toBeVisible({timeout: SLOW});
    expect(problems.apiFromNetwork).toEqual([]);
    problems.expectClean('in-page mock');
    await context.close();
  });
});
