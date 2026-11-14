'use client';

import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Code} from '@astryxdesign/core/Code';
import {DialogHeader} from '@astryxdesign/core/Dialog';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {List, ListItem} from '@astryxdesign/core/List';
import {MetadataList, MetadataListItem} from '@astryxdesign/core/MetadataList';
import {Text} from '@astryxdesign/core/Text';
import {TextArea} from '@astryxdesign/core/TextArea';
import {VStack} from '@astryxdesign/core/VStack';
import {Card} from '@astryxdesign/core/Card';
import {EmptyState} from '@/components/EmptyState';
import {ErrorState} from '@/components/ErrorState';
import {LoadingState} from '@/components/LoadingState';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {
  isApiError,
  useApproval,
  useBooking,
  useDecideApproval,
  useOrder,
  type ApprovalRequest,
  type ApprovalState,
  type Booking,
  type DecideVariables,
  type Order,
} from '@/lib/api';
import {formatCountdown, formatDate, formatDateTime, formatMoney, formatTime, secondsUntil} from '@/lib/format';
import {useBusiness as useSessionBusiness} from '@/lib/session';
import {statusView} from '@/lib/status';
import {
  actionSteps,
  actorLabel,
  decisionErrorView,
  effectiveState,
  factKeyLabel,
  factKindLabel,
  formatFactValue,
  recipientLabel,
  typedApproval,
  type TypedApproval,
} from '../_lib/approval-view';
import {useNow} from '../_lib/useNow';

export type DecisionOutcome = {
  approvalId: string;
  state: ApprovalState;
  decidedBy?: string;
  decidedAt?: string;
};

export type ApprovalDecisionContentProps = {
  businessId: string;
  approvalId: string;
  /** Close the dialog (or go back to the list). */
  onClose: () => void;
  /** Called once the server confirmed a decision, with the state it returned. */
  onDecided?: (outcome: DecisionOutcome) => void;
  /** Where "Open Live operations" points. */
  liveOperationsHref?: string;
};

const DEFAULT_TIME_ZONE = 'UTC';

export function ApprovalDecisionContent({
  businessId,
  approvalId,
  onClose,
  onDecided,
  liveOperationsHref = '/activity',
}: ApprovalDecisionContentProps) {
  const query = useApproval(businessId, approvalId);
  const {businesses} = useSessionBusiness();
  const timeZone = businesses.find((b) => b.id === businessId)?.timezone ?? DEFAULT_TIME_ZONE;

  if (query.isPending) {
    return <Frame title="Loading the request" onClose={onClose} body={<LoadingState label="Loading the request" />} />;
  }
  if (query.error || !query.data) {
    const err = query.error;
    if (isApiError(err) && err.code === 'NOT_FOUND') {
      return (
        <Frame
          title="Request not found"
          onClose={onClose}
          body={
            <EmptyState
              title="Not found in this business"
              description="This request does not exist in the selected business. It may belong to another business."
              actions={<Button label="Back to the list" onClick={onClose} />}
              headingLevel={3}
            />
          }
        />
      );
    }
    const retryable = !isApiError(err) || err.retryable;
    return (
      <Frame
        title="Could not load the request"
        onClose={onClose}
        body={
          <ErrorState
            message={err?.message ?? 'The request could not be loaded.'}
            onRetry={retryable ? () => void query.refetch() : undefined}
          />
        }
      />
    );
  }
  return (
    <LoadedDecision
      approval={query.data}
      businessId={businessId}
      timeZone={timeZone}
      onClose={onClose}
      onDecided={onDecided}
      refetch={() => query.refetch()}
      liveOperationsHref={liveOperationsHref}
    />
  );
}

function Frame({title, subtitle, onClose, body, footer}: {title: string; subtitle?: ReactNode; onClose: () => void; body: ReactNode; footer?: ReactNode}) {
  return (
    <Layout
      height="fill"
      header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={() => onClose()} />}
      content={<LayoutContent>{body}</LayoutContent>}
      footer={footer ? <LayoutFooter hasDivider>{footer}</LayoutFooter> : undefined}
    />
  );
}

const TITLES: Record<ApprovalRequest['bundleType'], string> = {
  order_bundle: 'Order request',
  booking_bundle: 'Booking request',
  fact_edit: 'Confirm your change',
  price_edit: 'Price change request',
};

type LoadedProps = {
  approval: ApprovalRequest;
  businessId: string;
  timeZone: string;
  onClose: () => void;
  onDecided?: (outcome: DecisionOutcome) => void;
  refetch: () => Promise<{data?: ApprovalRequest}>;
  liveOperationsHref: string;
};

function LoadedDecision({approval, businessId, timeZone, onClose, onDecided, refetch, liveOperationsHref}: LoadedProps) {
  const t = typedApproval(approval);
  const decide = useDecideApproval(businessId);
  const now = useNow(approval.state === 'PENDING');
  const state = effectiveState(approval, now);
  const secondsLeft = secondsUntil(approval.expiresAt, now);

  // The hash the owner has seen. If a refetch brings a new payload, the
  // buttons lock until the owner confirms they have read it.
  const [seenHash, setSeenHash] = useState(approval.payloadHash);
  const payloadChanged = seenHash !== approval.payloadHash;

  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const inFlight = useRef(false);
  const lastVars = useRef<DecideVariables | null>(null);

  const order = useOrder(businessId, t.bundleType === 'order_bundle' ? approval.subjectId : null);
  const booking = useBooking(businessId, t.bundleType === 'booking_bundle' ? approval.subjectId : null);
  const subjectMismatch = subjectDiffers(t, order.data, booking.data);
  const unknownStep = actionSteps(t).some((s) => s.isUnknown);

  const error = decide.error;
  const errorView = error ? decisionErrorView(error) : null;
  const confirmed = decide.data?.approval;
  // Only a retryable failure leaves the buttons on. Every other error needs a reload or ends the request.
  const lockedByError = errorView !== null && errorView.next !== 'retry';

  const canReject = state === 'PENDING' && !confirmed && !decide.isPending && !payloadChanged && !lockedByError;
  const canApprove = canReject && !subjectMismatch && !unknownStep;

  // Close the reject step when the request stops being decidable.
  useEffect(() => {
    if (state !== 'PENDING') setRejecting(false);
  }, [state]);

  const send = (vars: DecideVariables) => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastVars.current = vars;
    decide.mutate(vars, {
      onSuccess: (res) => {
        onDecided?.({
          approvalId: res.approval.id,
          state: res.approval.state,
          decidedBy: res.approval.decidedBy,
          decidedAt: res.approval.decidedAt,
        });
      },
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };

  const submit = (decision: 'approve' | 'reject') => {
    if (decision === 'approve' ? !canApprove : !canReject) return;
    const trimmed = reason.trim();
    send({
      approvalId: approval.id,
      decision,
      // Always the stored hash of the payload shown above, never recomputed.
      payloadHash: approval.payloadHash,
      ...(decision === 'reject' && trimmed ? {reason: trimmed} : {}),
    });
  };

  const retry = () => {
    // Same approval, decision and hash, so the hook reuses the same Idempotency-Key.
    if (lastVars.current) send(lastVars.current);
  };

  const reload = async () => {
    const result = await refetch();
    decide.reset();
    // The owner pressed reload, so the details on screen are now the new version.
    if (result.data) setSeenHash(result.data.payloadHash);
  };

  const view = statusView('approval', state);
  const isFactEdit = t.bundleType === 'fact_edit';
  const approveLabel = isFactEdit ? 'Confirm change' : 'Approve';
  const rejectLabel = isFactEdit ? 'Discard change' : 'Reject';

  const footer = (
    <VStack gap={3}>
      {state === 'PENDING' && !confirmed && rejecting ? (
        <TextArea
          label="Reason (optional)"
          description="Only you see this. It is stored with the decision."
          value={reason}
          onChange={(v) => setReason(v)}
          rows={2}
          maxLength={500}
          isDisabled={decide.isPending}
        />
      ) : null}
      <HStack gap={2} justify="end" wrap="wrap" vAlign="center">
        {state === 'PENDING' && !confirmed ? (
          rejecting ? (
            <>
              <Button label="Back" variant="ghost" onClick={() => setRejecting(false)} isDisabled={decide.isPending} />
              <Button
                label={isFactEdit ? 'Discard change' : 'Reject request'}
                variant="destructive"
                onClick={() => submit('reject')}
                isDisabled={!canReject}
                isLoading={decide.isPending && lastVars.current?.decision === 'reject'}
              />
            </>
          ) : (
            <>
              <Button label={rejectLabel} onClick={() => setRejecting(true)} isDisabled={!canReject} />
              <Button
                label={approveLabel}
                variant="primary"
                onClick={() => submit('approve')}
                isDisabled={!canApprove}
                isLoading={decide.isPending && lastVars.current?.decision === 'approve'}
              />
            </>
          )
        ) : (
          <Button label="Close" onClick={onClose} />
        )}
      </HStack>
    </VStack>
  );

  const body = (
    <VStack gap={5}>
      <HStack gap={2} wrap="wrap" vAlign="center">
        <StatusBadge label={view.label} tone={view.tone} />
        <Text type="supporting">{actorLabel(approval.actorType)}</Text>
        {state === 'PENDING' ? (
          <Text type="label" hasTabularNumbers>
            {`Expires in ${formatCountdown(secondsLeft)}`}
          </Text>
        ) : null}
      </HStack>

      <OutcomeNotice
        approval={approval}
        state={state}
        confirmedState={confirmed?.state}
        timeZone={timeZone}
        liveOperationsHref={liveOperationsHref}
        isFactEdit={isFactEdit}
      />

      {errorView ? (
        <Banner
          status={errorView.status}
          title={errorView.title}
          description={
            errorView.decidedState
              ? `${errorView.message} Recorded decision: ${statusView('approval', errorView.decidedState).label}.`
              : errorView.message
          }
          endContent={
            errorView.next === 'reload' ? (
              <Button label="Reload the request" onClick={() => void reload()} />
            ) : errorView.next === 'retry' ? (
              <Button label="Try again" onClick={retry} isDisabled={decide.isPending} />
            ) : errorView.next === 'close' ? (
              <Button label="Back to the list" onClick={onClose} />
            ) : errorView.next === 'sign_in' ? (
              <Button label="Sign in" href="/sign-in" />
            ) : undefined
          }>
          {errorView.correlationId ? <Text type="supporting">{`Reference: ${errorView.correlationId}`}</Text> : null}
        </Banner>
      ) : null}

      {payloadChanged && !errorView ? (
        <Banner
          status="warning"
          title="This request changed while it was open"
          description="The details below are the new version. Read them again before you decide."
          endContent={<Button label="I have read the new details" onClick={() => setSeenHash(approval.payloadHash)} />}
        />
      ) : null}

      {subjectMismatch ? (
        <Banner
          status="error"
          title="The details do not match this request"
          description="The stored order or booking differs from what this request would approve, so Approve is off. Close and open the request again. If it still does not match, reject it."
        />
      ) : null}

      {unknownStep ? (
        <Banner
          status="error"
          title="This request has a step this screen does not know"
          description="It cannot be approved here until the screen shows every step. You can still reject it."
        />
      ) : null}

      <BundleDetails t={t} timeZone={timeZone} order={order.data} booking={booking.data} subjectLoading={order.isLoading || booking.isLoading} />

      <VStack gap={2}>
        <Heading level={3}>{state === 'PENDING' ? 'What happens if you approve' : 'Steps in this request'}</Heading>
        <StepsList t={t} />
      </VStack>

      <VStack gap={2}>
        <Heading level={3}>Request record</Heading>
        <MetadataList>
          <MetadataListItem label="Bundle ID">
            <Code>{approval.id}</Code>
          </MetadataListItem>
          <MetadataListItem label="Payload hash">
            <Code>{approval.payloadHash}</Code>
          </MetadataListItem>
          <MetadataListItem label="Created">
            <Text>{formatDateTime(approval.createdAt, timeZone)}</Text>
          </MetadataListItem>
          <MetadataListItem label="Expires">
            <Text>{formatDateTime(approval.expiresAt, timeZone)}</Text>
          </MetadataListItem>
        </MetadataList>
      </VStack>
    </VStack>
  );

  const title = t.bundleType === 'fact_edit' && state !== 'PENDING' ? 'Your change to business facts' : TITLES[approval.bundleType];
  return <Frame title={title} onClose={onClose} body={body} footer={footer} />;
}

function OutcomeNotice({
  approval,
  state,
  confirmedState,
  timeZone,
  liveOperationsHref,
  isFactEdit,
}: {
  approval: ApprovalRequest;
  state: ApprovalState;
  confirmedState?: ApprovalState;
  timeZone: string;
  liveOperationsHref: string;
  isFactEdit: boolean;
}) {
  const shown = confirmedState ?? state;
  const decided =
    approval.decidedAt !== undefined
      ? `Decided ${formatDateTime(approval.decidedAt, timeZone)}${approval.decidedBy ? ` by ${approval.decidedBy}` : ''}.`
      : '';
  if (shown === 'APPROVED') {
    const view = statusView('approval', 'APPROVED');
    return (
      <Card variant="muted">
        <VStack gap={2}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StatusBadge label={view.label} tone={view.tone} />
            <Text weight="semibold">
              {isFactEdit ? 'Your change is being saved.' : 'The actions are now running.'}
            </Text>
          </HStack>
          <Text type="supporting">
            {`${decided} Approved does not mean done. ${isFactEdit ? 'The new value applies once the save step finishes.' : 'The verified result (paid or booked) shows in Live operations.'}`.trim()}
          </Text>
          {!isFactEdit ? (
            <HStack>
              <Button label="Open Live operations" href={liveOperationsHref} />
            </HStack>
          ) : null}
        </VStack>
      </Card>
    );
  }
  if (shown === 'REJECTED') {
    const view = statusView('approval', 'REJECTED');
    return (
      <Card variant="muted">
        <VStack gap={2}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StatusBadge label={view.label} tone={view.tone} />
            <Text weight="semibold">{isFactEdit ? 'Your change was discarded.' : 'Nothing was sent or charged.'}</Text>
          </HStack>
          {decided ? <Text type="supporting">{decided}</Text> : null}
        </VStack>
      </Card>
    );
  }
  if (shown === 'EXPIRED') {
    const view = statusView('approval', 'EXPIRED');
    return (
      <Card variant="muted">
        <VStack gap={2}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StatusBadge label={view.label} tone={view.tone} />
            <Text weight="semibold">This request expired. Nothing was sent.</Text>
          </HStack>
          <Text type="supporting">{`It expired at ${formatDateTime(approval.expiresAt, timeZone)} and can no longer be approved.`}</Text>
        </VStack>
      </Card>
    );
  }
  return null;
}

// ------------------------------------------------------- bundle details

function BundleDetails({
  t,
  timeZone,
  order,
  booking,
  subjectLoading,
}: {
  t: TypedApproval;
  timeZone: string;
  order?: Order;
  booking?: Booking;
  subjectLoading: boolean;
}) {
  switch (t.bundleType) {
    case 'order_bundle':
      return <OrderDetails t={t} timeZone={timeZone} order={order} loading={subjectLoading} />;
    case 'booking_bundle':
      return <BookingDetails t={t} booking={booking} loading={subjectLoading} />;
    case 'fact_edit':
      return <FactEditDetails t={t} />;
    case 'price_edit':
      return <PriceEditDetails t={t} />;
  }
}

function OrderDetails({
  t,
  timeZone,
  order,
  loading,
}: {
  t: Extract<TypedApproval, {bundleType: 'order_bundle'}>;
  timeZone: string;
  order?: Order;
  loading: boolean;
}) {
  const p = t.payload;
  return (
    <VStack gap={4}>
      <VStack gap={2}>
        <Heading level={3}>Order</Heading>
        {order ? (
          <List hasDividers density="compact">
            {order.quote.lines.map((line, i) => (
              <ListItem
                key={`${line.variationId}-${i}`}
                label={<Text>{`${line.quantity} x ${line.name}`}</Text>}
                description={<Text type="supporting">{lineDescription(line, order.cart.lines[i])}</Text>}
                endContent={<Text hasTabularNumbers>{formatMoney(line.lineTotalMinor, order.quote.currency)}</Text>}
              />
            ))}
          </List>
        ) : loading ? (
          <LoadingState label="Loading the order lines" />
        ) : (
          <Text type="supporting">The order lines could not be loaded. The hashed total below is what you approve.</Text>
        )}
        <MetadataList>
          {order ? (
            <>
              <MetadataListItem label="Subtotal">
                <HStack gap={2} vAlign="center">
                  <Text hasTabularNumbers>{formatMoney(order.quote.subtotalMinor, order.quote.currency)}</Text>
                  <SandboxBadge />
                </HStack>
              </MetadataListItem>
              <MetadataListItem label="Tax">
                <HStack gap={2} vAlign="center">
                  <Text hasTabularNumbers>{formatMoney(order.quote.taxMinor, order.quote.currency)}</Text>
                  <SandboxBadge />
                </HStack>
              </MetadataListItem>
            </>
          ) : null}
          <MetadataListItem label="Total">
            <HStack gap={2} vAlign="center">
              <Text weight="semibold" hasTabularNumbers>
                {formatMoney(p.totalMinor, p.currency)}
              </Text>
              <SandboxBadge />
            </HStack>
          </MetadataListItem>
        </MetadataList>
      </VStack>
      <VStack gap={2}>
        <Heading level={3}>Pickup and customer</Heading>
        <MetadataList>
          <MetadataListItem label="Pickup">
            <Text>{formatDateTime(p.pickupAt, timeZone)}</Text>
          </MetadataListItem>
          <MetadataListItem label="Customer">
            <Text>{order?.contact.name ?? 'Loading'}</Text>
          </MetadataListItem>
          <MetadataListItem label="Message to">
            <Text>{recipientLabel(p.messageRecipient)}</Text>
          </MetadataListItem>
          <MetadataListItem label="Channel">
            <Text>{p.messageChannel}</Text>
          </MetadataListItem>
        </MetadataList>
      </VStack>
    </VStack>
  );
}

function lineDescription(
  line: Order['quote']['lines'][number],
  cartLine: Order['cart']['lines'][number] | undefined,
): string | undefined {
  const parts: string[] = [];
  parts.push(`${formatMoney(line.unitPriceMinor)} each`);
  if (line.modifiers.length) {
    parts.push(
      line.modifiers.map((m) => (m.priceMinor ? `${m.name} (+${formatMoney(m.priceMinor)})` : m.name)).join(', '),
    );
  }
  if (cartLine && cartLine.variationId === line.variationId && cartLine.note) parts.push(`Note: ${cartLine.note}`);
  return parts.join('. ');
}

function BookingDetails({
  t,
  booking,
  loading,
}: {
  t: Extract<TypedApproval, {bundleType: 'booking_bundle'}>;
  booking?: Booking;
  loading: boolean;
}) {
  const p = t.payload;
  return (
    <VStack gap={2}>
      <Heading level={3}>Booking</Heading>
      <MetadataList>
        <MetadataListItem label="Service">
          <Text>{booking?.serviceName ?? (loading ? 'Loading' : p.serviceId)}</Text>
        </MetadataListItem>
        <MetadataListItem label="Slot">
          <Text>{`${formatDate(p.startUtc, p.timezone)}, ${formatTime(p.startUtc, p.timezone)} to ${formatTime(p.endUtc, p.timezone)} (${p.timezone})`}</Text>
        </MetadataListItem>
        <MetadataListItem label="Customer">
          <Text>{booking?.customer.name ?? (loading ? 'Loading' : 'Not loaded')}</Text>
        </MetadataListItem>
        <MetadataListItem label="Calendar">
          <Code>{p.calendarId}</Code>
        </MetadataListItem>
        <MetadataListItem label="Message to">
          <Text>{recipientLabel(p.messageRecipient)}</Text>
        </MetadataListItem>
        <MetadataListItem label="Channel">
          <Text>{p.messageChannel}</Text>
        </MetadataListItem>
      </MetadataList>
    </VStack>
  );
}

function FactEditDetails({t}: {t: Extract<TypedApproval, {bundleType: 'fact_edit'}>}) {
  const p = t.payload;
  const isOwner = t.approval.actorType === 'owner';
  return (
    <VStack gap={3}>
      <Text>
        {isOwner
          ? 'You asked for this change yourself. It is not a request from a caller or from your phone agent. It changes your business facts only, and nothing is sent to a customer.'
          : 'Your phone agent proposed this change. Check it before you confirm.'}
      </Text>
      <MetadataList>
        <MetadataListItem label="Fact">
          <Text>{factKindLabel(p.kind)}</Text>
        </MetadataListItem>
        <MetadataListItem label="Key">
          <Text>{factKeyLabel(p.kind, p.key)}</Text>
        </MetadataListItem>
        <MetadataListItem label="From version">
          <Text>{String(p.fromVersion)}</Text>
        </MetadataListItem>
      </MetadataList>
      <Grid columns={{minWidth: 200, max: 2}} gap={3}>
        <Card variant="muted">
          <VStack gap={1}>
            <Text type="label" color="secondary">
              Before
            </Text>
            <Text>{formatFactValue(p.kind, p.before)}</Text>
          </VStack>
        </Card>
        <Card>
          <VStack gap={1}>
            <Text type="label" color="secondary">
              After
            </Text>
            <Text weight="semibold">{formatFactValue(p.kind, p.after)}</Text>
          </VStack>
        </Card>
      </Grid>
    </VStack>
  );
}

function PriceEditDetails({t}: {t: Extract<TypedApproval, {bundleType: 'price_edit'}>}) {
  const p = t.payload;
  return (
    <VStack gap={2}>
      <Heading level={3}>Price</Heading>
      <MetadataList>
        <MetadataListItem label="Item">
          <Code>{p.squareItemId}</Code>
        </MetadataListItem>
        <MetadataListItem label="Variation">
          <Code>{p.variationId}</Code>
        </MetadataListItem>
        <MetadataListItem label="Old price">
          <HStack gap={2} vAlign="center">
            <Text hasTabularNumbers>{formatMoney(p.fromPriceMinor, p.currency)}</Text>
            <SandboxBadge />
          </HStack>
        </MetadataListItem>
        <MetadataListItem label="New price">
          <HStack gap={2} vAlign="center">
            <Text weight="semibold" hasTabularNumbers>
              {formatMoney(p.newPriceMinor, p.currency)}
            </Text>
            <SandboxBadge />
          </HStack>
        </MetadataListItem>
      </MetadataList>
    </VStack>
  );
}

function StepsList({t}: {t: TypedApproval}) {
  const steps = actionSteps(t);
  return (
    <List hasDividers density="compact">
      {steps.map((s, i) => (
        <ListItem
          key={`${s.step}-${i}`}
          label={<Text weight="medium">{s.system}</Text>}
          description={
            <VStack gap={1}>
              <Text type="supporting">{s.description}</Text>
              <Text type="supporting">
                <Code color="secondary">{s.step}</Code>
              </Text>
            </VStack>
          }
        />
      ))}
    </List>
  );
}

/**
 * True when the order or booking the screen loaded does not match the hashed
 * payload. Then the itemized view would not be what the owner approves.
 */
/**
 * Payload times are in toISOString() form (CONTRACTS 4); a stored row may
 * write the same instant without milliseconds. Compare instants, not text.
 */
function sameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

export function subjectDiffers(t: TypedApproval, order?: Order, booking?: Booking): boolean {
  if (t.bundleType === 'order_bundle' && order) {
    return (
      order.id !== t.payload.subjectId ||
      order.cartHash !== t.payload.cartHash ||
      order.totalMinor !== t.payload.totalMinor ||
      order.quote.totalMinor !== t.payload.totalMinor
    );
  }
  if (t.bundleType === 'booking_bundle' && booking) {
    return (
      booking.id !== t.payload.subjectId ||
      booking.serviceId !== t.payload.serviceId ||
      booking.calendarId !== t.payload.calendarId ||
      !sameInstant(booking.startUtc, t.payload.startUtc) ||
      !sameInstant(booking.endUtc, t.payload.endUtc)
    );
  }
  return false;
}

