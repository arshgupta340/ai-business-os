/**
 * The progress steps of the demo run and how long each one shows.
 *
 * The sequence is a fixed, timed animation decided by both leads for the
 * hackathon demo (issue #152). It makes no request: the agent, its facts, its
 * menu and the phone line were set up before the demo, and the page header
 * says so with the Demo badge. Tune the durations here during rehearsal.
 */

export type DemoStepId = 'menu' | 'faq' | 'hours' | 'payments' | 'agent' | 'phone';

export type DemoStepDefinition = {
  id: DemoStepId;
  label: string;
  /** How long the step shows as running before it shows as done. */
  durationMs: number;
};

export const MENU_STEP_MS = 5500;
export const FAQ_STEP_MS = 5000;
export const HOURS_STEP_MS = 4500;
export const PAYMENTS_STEP_MS = 4500;
export const AGENT_STEP_MS = 5500;
export const PHONE_STEP_MS = 5000;

export const DEMO_STEPS: readonly DemoStepDefinition[] = [
  {id: 'menu', label: 'Reading the menu', durationMs: MENU_STEP_MS},
  {id: 'faq', label: 'Reading the questions and answers', durationMs: FAQ_STEP_MS},
  {id: 'hours', label: 'Setting the opening hours', durationMs: HOURS_STEP_MS},
  {id: 'payments', label: 'Connecting payments', durationMs: PAYMENTS_STEP_MS},
  {id: 'agent', label: 'Setting up the voice agent', durationMs: AGENT_STEP_MS},
  {id: 'phone', label: 'Getting a phone number', durationMs: PHONE_STEP_MS},
];

/** The whole sequence, 30 seconds: time for the presenters to talk while it runs. */
export function totalDurationMs(steps: readonly DemoStepDefinition[] = DEMO_STEPS): number {
  return steps.reduce((sum, s) => sum + s.durationMs, 0);
}

/**
 * Runs the steps one after the other on timers. `onStepDone(i)` fires when
 * step i has shown for its duration; the last call means the sequence is
 * over. `scale` shortens every duration (tests pass 0). Returns a cancel function.
 */
export function runSchedule(
  steps: readonly DemoStepDefinition[],
  onStepDone: (index: number) => void,
  scale: number = 1,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const next = (index: number) => {
    if (index >= steps.length) return;
    timer = setTimeout(() => {
      if (cancelled) return;
      onStepDone(index);
      next(index + 1);
    }, Math.max(0, steps[index]!.durationMs * scale));
  };
  next(0);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
