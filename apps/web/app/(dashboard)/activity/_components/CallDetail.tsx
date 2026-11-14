'use client';

import {useMemo} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Divider} from '@astryxdesign/core/Divider';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {
  BUNDLE_ACTIONS,
  useApproval,
  useIntegrationsHealth,
  useOrderCheckout,
  type Agent,
  type OrderApprovalPayload,
} from '@/lib/api';
import {formatCountdown, formatDateTime, formatMoney, formatTime, lastFour, secondsUntil} from '@/lib/format';
import {statusView} from '@/lib/status';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {CheckoutPanel} from './CheckoutPanel';
import {describeEvent} from './describe';
import {actionLabel, deriveJourney, isHalted, syncStatusView, type Journey, type JourneyInput} from './journey';
import {JourneyStepper, NoticeView, Panel, useNow} from './ui';

export function callTitle(journey: Journey, agents: Agent[] | undefined): string {
  const agent = agents?.find((a) => a.id === journey.call?.agentId);
  const simulated = journey.call?.channel === 'test_console' || journey.events.some((e) => e.type === 'call.started' && e.payload.channel === 'test_console');
  const who = agent ? `, ${agent.name}` : '';
  return simulated ? `Simulated call${who}` : `Incoming call${who}`;
}

function durationText(journey: Journey): string | null {
  const call = journey.call;
  if (!call?.endedAt) return null;
  const sec = Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
}

function ApprovalCallout({journey}: {journey: Journey}) {
  const now = useNow();
  const approval = journey.approval;
  if (!approval || approval.state !== 'PENDING') return null;
  const left = approval.expiresAt ? secondsUntil(approval.expiresAt, now) : null;
  return (
    <Banner
      status="warning"
      title="Waiting for your approval"
      description={
        left === null
          ? 'Nothing is sent to Square or the customer until you approve.'
          : `Nothing is sent to Square or the customer until you approve. Expires in ${formatCountdown(left)}.`
      }
      collapsible={false}
      endContent={<Button label="Review and approve" variant="primary" size="lg" href={`/approvals?id=${encodeURIComponent(approval.id)}`} />}
    />
  );
}

function OrderProposal({journey, timeZone}: {journey: Journey; timeZone: string}) {
  const order = journey.order!;
  const q = order.quote;
  return (
    <Panel title="Proposal">
      <HStack gap={2} wrap="wrap" vAlign="center">
        <Text type="body">
          For {order.contact.name}, pickup at {formatTime(order.fulfillment.pickupAt, timeZone)}. Link goes to the number ending in{' '}
          {journey.approval?.recipientLast4 ?? lastFour(order.contact.messageRecipient)}.
        </Text>
      </HStack>
      <List hasDividers density="balanced">
        {q.lines.map((line, i) => (
          <ListItem
            key={`${line.variationId}_${i}`}
            label={<Text type="large">{`${line.quantity} x ${line.name}`}</Text>}
            description={line.modifiers.length ? line.modifiers.map((m) => `${m.name} ${formatMoney(m.priceMinor, q.currency)}`).join(', ') : undefined}
            endContent={<Text type="large">{formatMoney(line.lineTotalMinor, q.currency)}</Text>}
          />
        ))}
      </List>
      <VStack gap={1}>
        <HStack justify="between">
          <Text type="body">Subtotal</Text>
          <Text type="body">{formatMoney(q.subtotalMinor, q.currency)}</Text>
        </HStack>
        <HStack justify="between">
          <Text type="body">Tax</Text>
          <Text type="body">{formatMoney(q.taxMinor, q.currency)}</Text>
        </HStack>
        <Divider />
        <HStack justify="between" vAlign="center">
          <HStack gap={2} vAlign="center">
            <Text type="large">Total from Square</Text>
            <SandboxBadge />
          </HStack>
          <Text type="display-3" weight="semibold">
            {formatMoney(order.totalMinor, order.currency)}
          </Text>
        </HStack>
      </VStack>
    </Panel>
  );
}

function BookingProposal({journey}: {journey: Journey}) {
  const booking = journey.booking!;
  return (
    <Panel title="Proposal">
      <VStack gap={1}>
        <Text type="display-3" weight="semibold">
          {booking.serviceName}
        </Text>
        <Text type="large">
          {formatDateTime(booking.startUtc, booking.timezone)} to {formatTime(booking.endUtc, booking.timezone)} ({booking.timezone})
        </Text>
        <Text type="body">
          For {booking.customer.name}. Confirmation goes to the number ending in{' '}
          {journey.approval?.recipientLast4 ?? lastFour(booking.customer.messageRecipient)}.
        </Text>
        {journey.bookedVerified && booking.googleEventId ? (
          <Text type="supporting">Google Calendar event {booking.googleEventId}</Text>
        ) : null}
      </VStack>
      {journey.slotConflict?.alternatives.length ? (
        <VStack gap={1}>
          <Text type="label">Free times the agent can offer instead</Text>
          <List hasDividers>
            {journey.slotConflict.alternatives.map((alt) => (
              <ListItem key={alt.startUtc} label={`${formatDateTime(alt.startUtc, booking.timezone)} to ${formatTime(alt.endUtc, booking.timezone)}`} />
            ))}
          </List>
          <Text type="supporting">A new time needs a new proposal and your approval.</Text>
        </VStack>
      ) : null}
    </Panel>
  );
}

/** The approved bundle, step by step. Step progress comes from execution events (no REST read exists). */
function BundleSteps({journey}: {journey: Journey}) {
  const approval = journey.approval;
  const bundle =
    approval?.actionBundle.length ? approval.actionBundle : BUNDLE_ACTIONS[journey.kind === 'booking' ? 'booking_bundle' : 'order_bundle'];
  const approved = approval?.state === 'APPROVED';
  const halted = isHalted(journey);
  const notRun = {...statusView('execution', 'SKIPPED'), label: 'Not run'};
  return (
    <Panel title="Approved steps">
      {!approved ? (
        <Text type="body" color="secondary">
          {approval?.state === 'PENDING' ? 'Nothing runs until you approve.' : 'None of these steps ran.'}
        </Text>
      ) : null}
      <List hasDividers>
        {bundle.map((actionType, i) => {
          let badge = null;
          if (approved) {
            if (actionType.startsWith('sheets.')) {
              const view = !journey.sync && halted ? notRun : journey.sync
                ? syncStatusView(journey.sync)
                : {...statusView('syncJob', 'PENDING'), label: journey.kind === 'booking' ? 'Runs after the booking is verified' : 'Runs after the payment is verified'};
              badge = <StatusBadge label={view.label} tone={view.tone} />;
            } else {
              const exe = journey.executions.find((e) => e.actionType === actionType);
              const isMessage = actionType.startsWith('message.');
              if (exe) {
                const view = statusView('execution', exe.status);
                badge = <StatusBadge label={exe.errorCode ? `${view.label}, ${exe.errorCode}` : view.label} tone={view.tone} />;
              } else if (isMessage && journey.message?.status === 'SKIPPED') {
                const view = statusView('execution', 'SKIPPED');
                badge = <StatusBadge label={view.label} tone={view.tone} />;
              } else if (halted) {
                badge = <StatusBadge label={notRun.label} tone={notRun.tone} />;
              } else {
                const view = statusView('execution', 'QUEUED');
                badge = <StatusBadge label={view.label} tone={view.tone} />;
              }
            }
          }
          return <ListItem key={actionType} label={actionLabel(actionType)} description={`Step ${i + 1} of ${bundle.length}`} endContent={badge} />;
        })}
      </List>
    </Panel>
  );
}

function EventLog({journey, timeZone}: {journey: Journey; timeZone: string}) {
  const lines = journey.events
    .map((event) => ({event, line: describeEvent(event, timeZone)}))
    .filter((x) => x.line !== null);
  return (
    <Card>
      <Collapsible trigger={<Heading level={3}>{`Event log (${lines.length})`}</Heading>} defaultIsOpen={false}>
        <List hasDividers density="compact">
          {lines.map(({event, line}) => (
            <ListItem
              key={event.id}
              label={line!.title}
              description={formatTime(event.occurredAt, timeZone)}
              endContent={line!.sandbox ? <SandboxBadge /> : undefined}
            />
          ))}
        </List>
      </Collapsible>
    </Card>
  );
}

/** The selected call, with everything that happened on it. */
export function CallDetail({
  businessId,
  input,
  agents,
  timeZone,
}: {
  businessId: string;
  input: JourneyInput;
  agents: Agent[] | undefined;
  timeZone: string;
}) {
  const order = input.order;
  const hasLink = !!order && (!!order.checkoutUrl || input.events.some((e) => e.type === 'checkout.created'));
  const checkout = useOrderCheckout(businessId, hasLink ? order!.id : null);
  const approvalId = order?.approvalId ?? input.booking?.approvalId;
  const approval = useApproval(businessId, approvalId);
  const health = useIntegrationsHealth(businessId);
  const approvalChannel = (approval.data?.payload as Partial<OrderApprovalPayload> | undefined)?.messageChannel;
  const qrOnly = approvalChannel === 'qr_only' || health.data?.message_channel.channel === 'qr_only';

  const journey = useMemo(
    () => deriveJourney({...input, checkout: checkout.data, qrOnly}),
    [input, checkout.data, qrOnly],
  );
  if (journey.approval && !journey.approval.expiresAt && approval.data) journey.approval.expiresAt = approval.data.expiresAt;

  const duration = durationText(journey);
  const callView = journey.call ? statusView('call', journey.call.status) : null;

  return (
    <VStack gap={4}>
      <Card elevation="low" padding={6}>
        <VStack gap={4}>
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Heading level={2}>{callTitle(journey, agents)}</Heading>
              {callView ? <StatusBadge label={callView.label} tone={callView.tone} /> : null}
            </HStack>
            <Text type="supporting">
              {journey.startedAt ? `Started ${formatTime(journey.startedAt, timeZone)}` : ''}
              {journey.call?.callerLast4 ? `, caller ending in ${journey.call.callerLast4}` : ''}
              {duration ? `, lasted ${duration}` : ''}
            </Text>
          </VStack>
          <VStack gap={2}>
            <Text type="label" color="secondary">
              Now
            </Text>
            <HStack gap={4} vAlign="center" wrap="wrap" justify="between">
              <HStack gap={3} vAlign="center" wrap="wrap">
                <Heading level={3} type="display-2">
                  {journey.headline.label}
                </Heading>
              </HStack>
              {journey.order ? (
                <HStack gap={2} vAlign="center">
                  <Text type="display-2" weight="semibold">
                    {formatMoney(journey.order.totalMinor, journey.order.currency)}
                  </Text>
                  <SandboxBadge />
                </HStack>
              ) : null}
            </HStack>
            <HStack>
              <StatusBadge label={journey.headline.label} tone={journey.headline.tone} />
            </HStack>
            {journey.payment?.state === 'verified' ? (
              <Text type="large">
                Paid (sandbox), verified with Square. Payment {journey.payment.squarePaymentId}.
              </Text>
            ) : null}
          </VStack>
          <JourneyStepper journey={journey} density="spacious" />
        </VStack>
      </Card>

      <ApprovalCallout journey={journey} />
      {journey.notices.map((notice) => (
        <NoticeView key={notice.key} notice={notice} />
      ))}

      {journey.order && journey.approval?.state === 'APPROVED' ? (
        <CheckoutPanel order={journey.order} checkout={checkout.data} message={journey.message} qrOnly={qrOnly} paid={journey.paidVerified} timeZone={timeZone} />
      ) : null}
      {journey.booking && journey.approval?.state === 'APPROVED' && journey.message ? (
        <Panel title="Confirmation message">
          <HStack>
            {journey.message.status === 'NOT_STARTED' ? (
              <Text type="body" color="secondary">
                {isHalted(journey) ? 'Not sent. The booking did not go ahead.' : 'Not sent yet. It goes out after the calendar event exists.'}
              </Text>
            ) : journey.message.status === 'SKIPPED' ? (
              <StatusBadge {...statusView('execution', 'SKIPPED')} />
            ) : (
              <StatusBadge {...statusView('messageDispatch', journey.message.status)} />
            )}
          </HStack>
        </Panel>
      ) : null}

      {journey.order ? <OrderProposal journey={journey} timeZone={timeZone} /> : null}
      {journey.booking ? <BookingProposal journey={journey} /> : null}
      {journey.kind !== 'call_only' ? <BundleSteps journey={journey} /> : null}
      <EventLog journey={journey} timeZone={timeZone} />
    </VStack>
  );
}
