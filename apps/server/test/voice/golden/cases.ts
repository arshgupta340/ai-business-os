// The qr_only default-path cases whose output is pinned in qr-only-origin-main.json. That file was
// generated on 2026-11-14 by running origin/main's (5b1c821) voice prompt and session builder on these
// exact inputs, so the comparison is with main's output, not with this branch's code.
// Fixtures are passed in so the same cases run against main's copy and this branch.
type Fx = {
  barberFacts: { kind: string; key: string; value: unknown; version: number; status: string }[];
  barberSpecV1: never;
  pizzaCatalog: unknown[];
  pizzaSpecV2: never;
  pizzaVerifiedFacts: { kind: string; key: string; value: unknown; version: number; status: string }[];
};

const NOW_MS = Date.parse('2026-11-14T19:00:00Z');

function snapshotOf(facts: Fx['pizzaVerifiedFacts']) {
  return { facts: facts.flatMap((f) => (f.kind === 'menu_item' || f.status !== 'verified' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])), timezone: 'America/Los_Angeles' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function GOLDEN_CASES(fx: any): { name: string; spec: any; facts: any }[] {
  const pizzaFacts = snapshotOf(fx.pizzaVerifiedFacts);
  const barber = snapshotOf(fx.barberFacts);
  return [
    { name: 'pizza_full', spec: fx.pizzaSpecV2, facts: { businessName: 'Demo Pizza Co.', messageChannel: 'qr_only', facts: pizzaFacts, menu: fx.pizzaCatalog, nowMs: NOW_MS } },
    { name: 'pizza_no_menu', spec: fx.pizzaSpecV2, facts: { businessName: 'Demo Pizza Co.', messageChannel: 'qr_only', facts: pizzaFacts, nowMs: NOW_MS } },
    { name: 'pizza_bare', spec: fx.pizzaSpecV2, facts: { businessName: 'Demo Pizza Co.', messageChannel: 'qr_only' } },
    { name: 'barber_full', spec: fx.barberSpecV1, facts: { businessName: 'Demo Barbershop', messageChannel: 'qr_only', facts: barber, nowMs: NOW_MS } },
  ];
}
