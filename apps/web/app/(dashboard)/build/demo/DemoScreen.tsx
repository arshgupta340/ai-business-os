'use client';

import {lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import type {StageShopKey} from '@abos/contracts/fixtures';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {HStack} from '@astryxdesign/core/HStack';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {PageHeader} from '@/components/PageHeader';
import {PENDING_APPROVALS_QUERY, useActivityFeed, useApprovals} from '@/lib/api';
import {clearDemoAgentBuilt, markDemoAgentBuilt} from '@/lib/demo-stage';
import {useBusiness} from '@/lib/session';
import {
  APPROVE_HOLD_MS,
  DEMO_BADGE_TEXT,
  demoReducer,
  initialDemoState,
  isShowingResult,
  knownBeforeDemo,
  pickIncomingApproval,
  SHOW_DEMO_BADGE,
  WAITING_POLL_MS,
} from './demo-machine';
import {BookingCard} from './BookingCard';
import {DEMO_STEPS, runSchedule, stepsFor} from './demo-steps';
import {DemoChat} from './DemoChat';
import {OrderCard} from './OrderCard';
import {ProgressSteps} from './ProgressSteps';
import {ResultPanel} from './ResultPanel';
import {demoPhoneNumberFor, shopNotFoundText, stageShop} from './stage-shop';

// Mock mode only. The literal read lets Next drop this import from a
// real-mode build, so the button and its text are not shipped there.
const PracticeCallButton = process.env.NEXT_PUBLIC_MOCK === '1' ? lazy(() => import('./PracticeCallButton')) : null;

export const SERVER_UNREACHABLE_TEXT = 'The server could not be reached. Still trying.';

export type DemoScreenProps = {
  /** Multiplies every step duration. Tests pass 0. */
  stepScale?: number;
  /** How often pending approvals and the order are read again. */
  pollMs?: number;
  /** The least time the order card shows "Approving" after the click. Tests pass 0. */
  approveHoldMs?: number;
};

export function DemoScreen({stepScale = 1, pollMs = WAITING_POLL_MS, approveHoldMs = APPROVE_HOLD_MS}: DemoScreenProps) {
  const {businessId, business, businesses, setBusinessId} = useBusiness();
  const timeZone = business?.timezone ?? 'UTC';
  const [state, dispatch] = useReducer(demoReducer, undefined, () => initialDemoState());
  const [sendError, setSendError] = useState<string | null>(null);
  const shop = state.shopKey ? stageShop(state.shopKey) : null;
  // The finale reads only once the selected business is the chosen shop.
  const showing = isShowingResult(state) && !!shop && businessId === shop.businessId;
  const steps = useMemo(() => (shop ? stepsFor(shop.infoTitle) : DEMO_STEPS), [shop]);

  // Each stage shop is its own business. The shop is switched to on send, so
  // the finale and the other screens (Overview, Approvals, Activity) show it.
  const send = (text: string, fileNames: string[], shopKey: StageShopKey) => {
    const chosen = stageShop(shopKey);
    if (!businesses.some((b) => b.id === chosen.businessId)) {
      setSendError(shopNotFoundText(chosen));
      return;
    }
    setSendError(null);
    setBusinessId(chosen.businessId);
    dispatch({type: 'send', text, fileNames, shopKey});
  };

  // Nothing is read before the result panel shows: the build step plays the
  // same with the server slow or down. After that, the live updates refetch
  // the approval and order queries, as on Approvals and Live operations.
  const feed = useActivityFeed(showing ? businessId : null);
  const pending = useApprovals(showing ? businessId : null, PENDING_APPROVALS_QUERY);

  const {phase, run} = state;
  useEffect(() => {
    if (phase !== 'progress') return undefined;
    return runSchedule(steps, (index) => dispatch({type: 'step_done', run, index, now: Date.now()}), stepScale);
  }, [phase, run, stepScale, steps]);

  // Overview and My Agents show the agent of this shop only once this run has reached the number.
  const shopBusinessId = shop?.businessId;
  useEffect(() => {
    if (phase === 'progress') clearDemoAgentBuilt();
    else if (phase !== 'compose' && shopBusinessId) markDemoAgentBuilt(shopBusinessId);
  }, [phase, shopBusinessId]);

  // The newest order that was not already waiting when the number was shown.
  // The first list after that moment says which orders to ignore, for this run only.
  const shownAt = state.numberShownAt;
  const pendingItems = pending.data?.items;
  const pendingReadAt = pending.dataUpdatedAt;
  const known = useRef<{shownAt: number; ids: Set<string>} | null>(null);
  useEffect(() => {
    if (phase !== 'ready' || shownAt === null || !pendingItems) return;
    // A list read before the number was shown (kept from an earlier run) is too old to decide anything.
    if (pendingReadAt < shownAt) return;
    if (known.current?.shownAt !== shownAt) known.current = {shownAt, ids: knownBeforeDemo(pendingItems, shownAt)};
    const incoming = pickIncomingApproval(pendingItems, known.current.ids);
    if (incoming) dispatch({type: 'order_arrived', approvalId: incoming.id, kind: incoming.bundleType === 'booking_bundle' ? 'booking_bundle' : 'order_bundle'});
  }, [phase, shownAt, pendingItems, pendingReadAt]);

  // Besides the live updates, a poll while waiting, so a missed event cannot leave the screen empty.
  const refetchPending = pending.refetch;
  useEffect(() => {
    if (phase !== 'ready' || !showing) return undefined;
    const timer = setInterval(() => void refetchPending({cancelRefetch: false}), pollMs);
    return () => clearInterval(timer);
  }, [phase, showing, pollMs, refetchPending]);

  const header = (
    <PageHeader
      title="Build an Agent"
      description={SHOW_DEMO_BADGE ? DEMO_BADGE_TEXT : undefined}
      actions={
        <>
          {SHOW_DEMO_BADGE ? <Badge label="Demo" variant="info" /> : null}
          {phase !== 'compose' ? (
            <Button
              label="Start over"
              onClick={() => {
                clearDemoAgentBuilt();
                setSendError(null);
                dispatch({type: 'start_over'});
              }}
            />
          ) : null}
        </>
      }
    />
  );

  if (phase === 'compose') {
    return (
      <VStack gap={4}>
        {header}
        <DemoChat message={null} onSend={send} error={sendError} />
      </VStack>
    );
  }

  if (phase === 'progress') {
    return (
      <VStack gap={4}>
        {header}
        <Grid columns={{minWidth: 360, max: 2}} gap={4} align="start">
          <DemoChat message={state.message} onSend={() => undefined} />
          <ProgressSteps steps={state.steps} definitions={steps} />
        </Grid>
      </VStack>
    );
  }

  if (!shop) return null;
  const feedOff = feed.status === 'disconnected' || feed.status === 'unavailable';
  const noun = shop.key === 'pizza' ? 'order' : 'booking';
  const FinaleCard = state.approvalKind === 'booking_bundle' ? BookingCard : OrderCard;
  return (
    <VStack gap={4}>
      {header}
      <ResultPanel shop={shop} phoneNumber={demoPhoneNumberFor(shop.key)} />
      {state.approvalId && businessId ? (
        <FinaleCard
          key={state.approvalId}
          businessId={businessId}
          approvalId={state.approvalId}
          timeZone={timeZone}
          pollMs={pollMs}
          approveHoldMs={approveHoldMs}
          onDecided={(approvalId, decided) => dispatch({type: 'decided', approvalId, state: decided})}
        />
      ) : (
        <Card variant="muted">
          <VStack gap={2}>
            <HStack gap={3} vAlign="center">
              <Spinner size="xl" aria-label="Waiting" />
              <Text type="display-3" weight="semibold">
                Waiting for the call
              </Text>
            </HStack>
            <Text type="large" weight="normal" color="secondary">
              {feedOff
                ? `Live updates are off, so this screen checks for a new ${noun} every few seconds.`
                : `The ${noun} shows here by itself once the caller has placed it.`}
            </Text>
            {pending.error ? <Text type="supporting">{SERVER_UNREACHABLE_TEXT}</Text> : null}
            {PracticeCallButton ? (
              <Suspense fallback={null}>
                <PracticeCallButton kind={noun} />
              </Suspense>
            ) : null}
          </VStack>
        </Card>
      )}
    </VStack>
  );
}
