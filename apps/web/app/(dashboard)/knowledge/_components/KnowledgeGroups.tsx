'use client';

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Table, pixel, proportional} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import type {ApprovalRequest, Business, BusinessFact} from '@/lib/api';
import {statusView, type StatusView} from '@/lib/status';
import {
  KIND_LABELS,
  WEEKDAY_NAMES,
  describeValue,
  factKeyLabel,
  groupKnowledge,
  sourceTypeLabel,
  type KnowledgeKind,
  type KnowledgeRow,
} from './knowledge-model';

type PendingChange = {factId: string; text: string; approvalId?: string};

interface Row extends Record<string, unknown> {
  id: string;
  label: string;
  value: string;
  hasMoney: boolean;
  source: string;
  version: string;
  status?: StatusView;
  pending: PendingChange[];
}

type Props = {
  facts: readonly BusinessFact[];
  timezone: string;
  profile?: Business;
  /** Pending fact_edit approvals, to link a waiting change to its confirmation. */
  pendingApprovals: readonly ApprovalRequest[];
};

/** The knowledge the agent uses, grouped by kind. Only verified facts are knowledge. */
export function KnowledgeGroups({facts, timezone, profile, pendingApprovals}: Props) {
  const groups = groupKnowledge(facts);
  const approvalFor = (factId: string) => pendingApprovals.find((a) => a.subjectId === factId)?.id;
  const pendingOf = (kind: KnowledgeKind, pending: BusinessFact[]): PendingChange[] =>
    pending.map((f) => ({factId: f.id, text: describeValue(kind, f.value).text, approvalId: approvalFor(f.id)}));

  const toRow = (kind: KnowledgeKind, row: KnowledgeRow, label?: string): Row => {
    const fact = row.verified;
    const value = fact ? describeValue(kind, fact.value) : {text: 'Not set', hasMoney: false};
    return {
      id: `${kind}:${row.key}`,
      label: label ?? factKeyLabel(kind, row.key, fact?.value ?? row.pending[0]?.value),
      value: value.text,
      hasMoney: value.hasMoney,
      source: fact ? `${sourceTypeLabel(fact.sourceType)}${fact.sourceRef ? `, reference ${fact.sourceRef}` : ''}` : 'None',
      version: fact ? `Version ${fact.version}` : 'No version',
      status: fact ? statusView('fact', fact.status) : undefined,
      pending: pendingOf(kind, row.pending),
    };
  };

  const hoursRows = groups.hours.map((h) => toRow('hours', {key: h.day, verified: h.verified, pending: h.pending}, WEEKDAY_NAMES[h.day]));
  const contactRows = groups.contact.map((r) => toRow('contact', r));
  if (profile?.contact?.address) {
    contactRows.unshift({
      id: 'profile:address',
      label: 'Location',
      value: profile.contact.address,
      hasMoney: false,
      source: 'Business profile',
      version: 'Not versioned',
      pending: [],
    });
  }

  return (
    <VStack gap={4}>
      <Group
        title={KIND_LABELS.hours}
        note={`Times are in the business time zone, ${timezone}.`}
        rows={hoursRows}
        empty="No opening hours yet."
      />
      <Group title={KIND_LABELS.policy} rows={groups.policy.map((r) => toRow('policy', r))} empty="No policies yet." />
      {groups.service.length ? (
        <Group
          title={KIND_LABELS.service}
          rows={groups.service.map((r) => toRow('service', r))}
          empty="No services yet."
          note="Service prices are sandbox payment data."
        />
      ) : null}
      <Group title={KIND_LABELS.contact} rows={contactRows} empty="No contact details yet." />
      <Group title={KIND_LABELS.faq} rows={groups.faq.map((r) => toRow('faq', r))} empty="No questions and answers yet." />
    </VStack>
  );
}

function Group({title, rows, empty, note}: {title: string; rows: Row[]; empty: string; note?: string}) {
  return (
    <Card>
      <VStack gap={2}>
        <Heading level={3}>{title}</Heading>
        {note ? <Text type="supporting">{note}</Text> : null}
        {rows.length === 0 ? (
          <Text type="supporting">{empty}</Text>
        ) : (
          <Table<Row>
            data={rows}
            idKey="id"
            density="compact"
            verticalAlign="top"
            columns={[
              {
                key: 'label',
                header: 'Item',
                width: proportional(1, {minWidth: 110}),
                renderCell: (r) => <Text weight="medium">{r.label}</Text>,
              },
              {
                key: 'value',
                header: 'Value',
                width: proportional(2, {minWidth: 160}),
                renderCell: (r) => (
                  <VStack gap={1}>
                    <HStack gap={1} vAlign="center" wrap="wrap">
                      <Text>{r.value}</Text>
                      {r.hasMoney ? <SandboxBadge /> : null}
                    </HStack>
                    {r.pending.map((p) => (
                      <VStack key={p.factId} gap={1}>
                        <Text type="supporting">Change waiting for your confirmation: {p.text}</Text>
                        {p.approvalId ? (
                          <Button
                            label="Open the confirmation"
                            size="sm"
                            href={`/approvals?id=${encodeURIComponent(p.approvalId)}`}
                          />
                        ) : null}
                      </VStack>
                    ))}
                  </VStack>
                ),
              },
              {
                key: 'source',
                header: 'Source and version',
                width: proportional(1, {minWidth: 130}),
                renderCell: (r) => (
                  <VStack gap={0.5}>
                    <Text type="supporting">{r.source}</Text>
                    <Text type="supporting">{r.version}</Text>
                  </VStack>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                width: pixel(120),
                renderCell: (r) => (r.status ? <StatusBadge label={r.status.label} tone={r.status.tone} /> : null),
              },
            ]}
          />
        )}
      </VStack>
    </Card>
  );
}
