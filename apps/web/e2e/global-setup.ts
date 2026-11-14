import type {FullConfig} from '@playwright/test';

/**
 * The dev server compiles each route the first time it is requested, which
 * can take a minute on a busy machine. Request every route of the walk once
 * so the tests measure the app, not the first compile.
 */
const ROUTES = ['/sign-in', '/overview', '/build', '/activity', '/approvals', '/knowledge'];

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  for (const route of ROUTES) {
    const started = Date.now();
    const res = await fetch(new URL(route, baseURL), {signal: AbortSignal.timeout(300_000)});
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`Warm-up of ${route} answered ${res.status}`);
    console.log(`warm-up ${route} ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
}
