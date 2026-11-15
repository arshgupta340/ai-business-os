'use client';

import {useEffect} from 'react';
import {stageShopForBusiness} from '@abos/contracts/fixtures';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {useApproval, useBooking, type Booking} from '@/lib/api';
import {formatCountdown, formatDate, formatMoney, formatTime, secondsUntil} from '@/lib/format';
import {statusView} from '@/lib/status';
import {actionSteps, typedApproval} from '../../approvals/_lib/approval-view';
import {subjectDiffers} from '../../approvals/_components/ApprovalDecisionContent';
import {BOOKING_WORDING, Decision, decisionNotice, useApproveFlow} from './approve-flow';
import {APPROVE_HOLD_MS, WAITING_POLL_MS} from './demo-machine';
import type {FinaleCardProps} from './OrderCard';

/** Booking states after which nothing else happens on its own. */
const SETTLED_BOOKING_STATES: readonly Booking['status'][] = ['BOOKED_VERIFIED', 'SLOT_CONFLICT', 'REJECTED', 'EXPIRED', 'RETRY_REQUIRED'];

/** Whole minutes from start to end. */
export function durationMinutes(startUtc: string, endUtc: string): number {
  return Math.round((Date.parse(endUtc) - Date.parse(startUtc)) / 60_000);
}

/**
 * The price of the booked service. A booking carries no price, so it comes
 * from the stage shop's services (the same file the panel and the seed use),
 * by service id. Undefined for a service the shop does not list.
 */
export function bookingPrice(businessId: string, serviceId: string): {priceMinor: number; currency: string} | undefined {
  const service = stageShopForBusiness(businessId)?.services.find((s) => s.id === serviceId);
  return service ? {priceMinor: service.priceMinor, currency: service.currency} : undefined;
}

/**
 * The finale card for a booking (barbershop, salon): the service, the date and
 * time in the business time zone, the customer, the duration and the price,
 * and the same Approve flow as an order.
 */
export function BookingCard({businessId, approvalId, onDecided, pollMs = WAITING_POLL_MS, approveHoldMs = APPROVE_HOLD_MS}: FinaleCardProps) {
  const query = useApproval(businessId, approvalId);
  const approval = query.data;
  const t = approval ? typedApproval(approval) : null;
  const bookingId = t?.bundleType === 'booking_bundle' ? approval!.subjectId : null;
  const booking = useBooking(businessId, bookingId);

  const mismatch = !!t && (subjectDiffers(t, undefined, booking.data) || actionSteps(t).some((s) => s.isUnknown));
  const flow = useApproveFlow({businessId, approval, approveHoldMs, onDecided, subjectReady: !!booking.data && !mismatch});

  const {decidedOrDone} = flow;
  const bookingStatus = booking.data?.status;
  const bookingSettled = !!bookingStatus && SETTLED_BOOKING_STATES.includes(bookingStatus);
  const refetchApproval = query.refetch;
  const refetchBooking = booking.refetch;
  useEffect(() => {
    if (decidedOrDone && bookingSettled) return undefined;
    const timer = setInterval(() => {
      if (!decidedOrDone) void refetchApproval({cancelRefetch: false});
      if (bookingId) void refetchBooking({cancelRefetch: false});
    }, pollMs);
    return () => clearInterval(timer);
  }, [decidedOrDone, bookingSettled, bookingId, pollMs, refetchApproval, refetchBooking]);

  const unreachable = !!query.error || !!booking.error;

  if (!approval || !t) {
    return (
      <Card variant="muted">
        <VStack gap={2}>
          <LoadingState label="Loading the new booking" />
          {query.error ? <Text type="supporting">The server could not be reached. Still trying.</Text> : null}
        </VStack>
      </Card>
    );
  }
  if (t.bundleType !== 'booking_bundle') return null;

  const p = t.payload;
  const price = bookingPrice(businessId, p.serviceId);
  const approvalView = statusView('approval', flow.working ? 'PENDING' : (flow.shownState ?? 'PENDING'));
  const bookingView = booking.data ? statusView('booking', booking.data.status) : null;

  return (
    <Card elevation="low">
      <Grid columns={{minWidth: 320, max: 2}} gap={5}>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>New booking</Heading>
            <StatusBadge label={approvalView.label} tone={approvalView.tone} />
            {flow.state === 'PENDING' && !flow.confirmed && !flow.working ? (
              <Text type="large" hasTabularNumbers color="secondary">
                {`Expires in ${formatCountdown(secondsUntil(approval.expiresAt, flow.now))}`}
              </Text>
            ) : null}
          </HStack>
          {booking.data ? (
            <VStack gap={1}>
              <Text type="display-3" weight="semibold">
                {booking.data.serviceName}
              </Text>
              <Text type="display-3">{`${formatDate(p.startUtc, p.timezone)}, ${formatTime(p.startUtc, p.timezone)}`}</Text>
              <Text type="display-3">{booking.data.customer.name}</Text>
              <Text type="large" weight="normal" color="secondary">
                {`${durationMinutes(p.startUtc, p.endUtc)} minutes`}
              </Text>
            </VStack>
          ) : (
            <LoadingState label="Loading the booking" />
          )}
          {unreachable ? <Text type="supporting">The server could not be reached. Still trying.</Text> : null}
        </VStack>

        <VStack gap={4} vAlign="center">
          {price ? (
            <VStack gap={1}>
              <HStack gap={2} vAlign="center">
                <Text type="label" color="secondary">
                  Price
                </Text>
                <SandboxBadge />
              </HStack>
              <Text type="display-1" weight="semibold" hasTabularNumbers>
                {formatMoney(price.priceMinor, price.currency)}
              </Text>
            </VStack>
          ) : null}

          <Decision flow={flow} wording={BOOKING_WORDING} notice={decisionNotice(flow, BOOKING_WORDING, approval.id, mismatch)} />

          {flow.confirmed && bookingView && !flow.working ? (
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="large">Now:</Text>
              <StatusBadge label={bookingView.label} tone={bookingView.tone} />
            </HStack>
          ) : null}
        </VStack>
      </Grid>
    </Card>
  );
}
