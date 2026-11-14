import {expect, type BrowserContext, type ConsoleMessage, type Page, type Request, type Response} from '@playwright/test';

const RESOURCE_404 = /Failed to load resource: the server responded with a status of 404 \(Not Found\)/;

/**
 * Console messages that are known noise. Every entry says why it is allowed
 * and what removes it. Do not add anything about the service worker or about
 * an API request that got a 404: those are real failures in mock mode.
 */
export const CONSOLE_ALLOW_LIST: readonly {pattern: RegExp; why: string}[] = [];

export type Problem = {kind: 'console' | 'pageerror' | 'api'; text: string; url?: string};

function isAllowed(message: ConsoleMessage, allowPreview404: boolean): boolean {
  const location = message.location().url ?? '';
  // The preview route is not on main yet, so Continue lands on a 404 for
  // /agents/<id>/preview. Only allowed while PREVIEW_PAGE_MERGED is false in
  // demo-walk.spec.ts. Remove it when the preview page merges.
  if (allowPreview404 && RESOURCE_404.test(message.text()) && /\/agents\/agt_[^/]+\/preview(\?|$)/.test(location)) return true;
  return CONSOLE_ALLOW_LIST.some((entry) => {
    return entry.pattern.test(message.text());
  });
}

function isApiPath(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * Collects every console error, uncaught page error and API request that the
 * mock did not answer, across every page of the context. Call `expectClean`
 * at the end of a test (and at checkpoints) to fail on any of them.
 */
export class ProblemCollector {
  readonly problems: Problem[] = [];
  /** API responses that came from the network instead of the mock. */
  readonly apiFromNetwork: {url: string; status: number}[] = [];
  private readonly allowPreview404: boolean;

  constructor(options: {allowPreview404?: boolean} = {}) {
    this.allowPreview404 = options.allowPreview404 ?? false;
  }

  attach(context: BrowserContext): void {
    for (const page of context.pages()) this.watchPage(page);
    context.on('page', (page) => this.watchPage(page));
    context.on('response', (response) => this.onResponse(response));
    context.on('requestfailed', (request) => this.onRequestFailed(request));
  }

  private watchPage(page: Page): void {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (isAllowed(message, this.allowPreview404)) return;
      this.problems.push({kind: 'console', text: message.text(), url: message.location().url});
    });
    page.on('pageerror', (error) => {
      this.problems.push({kind: 'pageerror', text: `${error.name}: ${error.message}`});
    });
  }

  private onResponse(response: Response): void {
    const url = response.url();
    if (!isApiPath(url)) return;
    // In mock mode every API call is answered by MSW in the browser. A
    // response that did not come from the service worker reached the Next
    // server, which has no API routes.
    if (!response.fromServiceWorker() && !response.request().serviceWorker()) {
      this.apiFromNetwork.push({url, status: response.status()});
      this.problems.push({kind: 'api', text: `API request reached the network (${response.status()})`, url});
    }
  }

  private onRequestFailed(request: Request): void {
    if (!isApiPath(request.url())) return;
    const reason = request.failure()?.errorText ?? 'unknown';
    // A request cancelled by a navigation or an unmounting query is not a failure.
    if (/ERR_ABORTED|cancelled/i.test(reason)) return;
    this.problems.push({kind: 'api', text: `API request failed: ${reason}`, url: request.url()});
  }

  expectClean(where: string): void {
    expect(this.problems, `console errors, page errors or unmocked API calls (${where})`).toEqual([]);
  }
}

/** Seconds of patience for steps that wait on a first compile or the scripted mock timeline. */
export const SLOW = 60_000;

/** Goes to a dashboard route with the sidebar, the way an owner would. */
export async function openSection(page: Page, label: string, path: string): Promise<void> {
  await page.getByRole('navigation', {name: 'Sections'}).getByRole('link', {name: label, exact: true}).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[/]/g, '\\/')}(\\?|$)`), {timeout: SLOW * 2});
}

/** The page h1 of a dashboard screen. */
export function pageHeading(page: Page, name: string) {
  return page.getByRole('heading', {level: 1, name, exact: true});
}
