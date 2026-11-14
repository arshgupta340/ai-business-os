'use client';

import {useState, type ReactNode} from 'react';
import {Divider} from '@astryxdesign/core/Divider';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {useActivityFeed, useApprovals, useBusiness as useBusinessProfile, useFacts} from '@/lib/api';
import {ApprovalDecisionDialog} from '../../approvals/_components/ApprovalDecisionDialog';
import {ChangeLog} from './ChangeLog';
import {HoursSection} from './HoursSection';
import {OtherFactsSection} from './OtherFactsSection';
import {ProfileSection} from './ProfileSection';
import {RequestError} from './RequestError';

export type SettingsScreenProps = {businessId: string; timezone: string};

/**
 * Settings (U-09). Mount it with key={businessId} so local state resets when
 * the business changes. Facts change only through facts/propose and the
 * owner's confirm dialog. Nothing here writes a fact directly.
 */
export function SettingsScreen({businessId, timezone: sessionTimezone}: SettingsScreenProps) {
  // Stay subscribed: each live event refetches the facts, approvals and activity it touches.
  const feed = useActivityFeed(businessId);
  const profile = useBusinessProfile(businessId);
  const facts = useFacts(businessId);
  const approvals = useApprovals(businessId, {bundleType: 'fact_edit', state: 'PENDING'});
  const [dialogId, setDialogId] = useState<string | null>(null);

  const timezone = profile.data?.timezone ?? sessionTimezone;
  const items = facts.data?.items ?? [];
  const pending = approvals.data?.items ?? [];
  const refetchFacts = () => void facts.refetch();
  const factProps = {businessId, facts: items, pendingApprovals: pending, openDialog: setDialogId, refetchFacts};

  const factsBody = (render: () => ReactNode, label: string) =>
    facts.isPending ? (
      <LoadingState label={`Loading ${label}`} />
    ) : facts.error ? (
      <RequestError title={`Could not load ${label}`} error={facts.error} onRetry={refetchFacts} />
    ) : (
      render()
    );

  return (
    <VStack gap={6}>
      <PageHeader title="Settings" description="Your business profile, opening hours and the facts your agents answer from." />
      {feed.status === 'disconnected' ? (
        <Text type="supporting">Live updates are paused. Reload the page to see the latest state.</Text>
      ) : null}
      {approvals.error ? (
        <RequestError
          title="Could not check for changes waiting for your confirmation"
          error={approvals.error}
          onRetry={() => void approvals.refetch()}
        />
      ) : null}

      <SettingsBlock title="Business profile" description="The name and contact details of your business." layout="side">
        {profile.isPending ? (
          <LoadingState label="Loading the business profile" />
        ) : profile.error ? (
          <RequestError title="Could not load the business profile" error={profile.error} onRetry={() => void profile.refetch()} />
        ) : (
          <ProfileSection key={profile.data.id} businessId={businessId} business={profile.data} />
        )}
      </SettingsBlock>

      <Divider />

      <SettingsBlock
        title="Opening hours"
        description="Edit a day, then confirm the change. The hours here change only after you confirm and the change is saved.">
        {factsBody(() => <HoursSection {...factProps} timezone={timezone} />, 'the opening hours')}
      </SettingsBlock>

      <Divider />

      <SettingsBlock title="Other business facts" description="Policies, services and answers your agents use. Source and version for each.">
        {factsBody(() => <OtherFactsSection {...factProps} />, 'the business facts')}
      </SettingsBlock>

      <Divider />

      <SettingsBlock title="Change log" description="Recent changes to business facts, newest first.">
        <ChangeLog businessId={businessId} timezone={timezone} facts={items} />
      </SettingsBlock>

      <ApprovalDecisionDialog
        isOpen={dialogId !== null}
        businessId={businessId}
        approvalId={dialogId ?? ''}
        onClose={() => setDialogId(null)}
        onDecided={() => {
          void approvals.refetch();
          refetchFacts();
        }}
      />
    </VStack>
  );
}

/**
 * One settings section. The profile form keeps the Astryx settings template
 * layout (title and description beside the fields). Lists of rows are stacked
 * under their title so each row has the full width.
 */
function SettingsBlock({
  title,
  description,
  layout = 'stacked',
  children,
}: {
  title: string;
  description: string;
  layout?: 'side' | 'stacked';
  children: ReactNode;
}) {
  const heading = (
    <VStack gap={1}>
      <Heading level={2}>{title}</Heading>
      <Text type="supporting" color="secondary">
        {description}
      </Text>
    </VStack>
  );
  if (layout === 'side') {
    return (
      <Grid columns={{minWidth: 300, max: 2}} gap={6} align="start">
        {heading}
        <VStack gap={4}>{children}</VStack>
      </Grid>
    );
  }
  return (
    <VStack gap={4} maxWidth={880}>
      {heading}
      {children}
    </VStack>
  );
}
