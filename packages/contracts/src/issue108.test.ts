// Issue #108: additive fields. Each one is optional, an older value without it still parses, and no
// approval payload or hash changes.
import { describe, expect, it } from 'vitest';
import {
  AgentVersionSchema,
  ApprovalRequestSchema,
  BuilderTurnResponseSchema,
  DecisionResponseSchema,
  MATERIAL_FIELDS,
  PriceEditApprovalPayloadSchema,
  ProposePriceBodySchema,
  ProposePriceResponseSchema,
  StopConditionSchema,
  approvalPayloadHash,
} from './index';
import * as F from '../fixtures/index';
import { GENERATED_HASHES } from '../fixtures/hashes.generated';

describe('StopCondition: path and conflictIds', () => {
  it('still accepts a stop condition that has only a code', () => {
    expect(StopConditionSchema.parse({ code: 'missing_timezone' })).toEqual({ code: 'missing_timezone' });
  });

  it('keeps path and conflictIds instead of dropping them', () => {
    const missing = { code: 'missing_required_fact', path: 'hours.mon' };
    const conflict = { code: 'open_conflict', conflictIds: ['cfl_pizza_01', 'cfl_pizza_02'] };
    expect(StopConditionSchema.parse(missing)).toEqual(missing);
    expect(StopConditionSchema.parse(conflict)).toEqual(conflict);
  });

  it('refuses an empty path and an ID that is not a conflict ID', () => {
    expect(StopConditionSchema.safeParse({ code: 'missing_required_fact', path: '' }).success).toBe(false);
    expect(StopConditionSchema.safeParse({ code: 'open_conflict', conflictIds: ['fact_01'] }).success).toBe(false);
    expect(StopConditionSchema.safeParse({ code: 'open_conflict', conflictIds: 'cfl_pizza_01' }).success).toBe(false);
  });

  it('a builder turn keeps both fields on every entry', () => {
    const turn = BuilderTurnResponseSchema.parse(F.builderTurn);
    expect(turn.stopConditions).toEqual(F.builderTurn.stopConditions);
    expect(turn.stopConditions.find((s) => s.conflictIds)?.conflictIds).toEqual([F.menuPriceConflict.id]);
    const withPath = turn.stopConditions.find((s) => s.path);
    expect(F.builderTurn.missingFields).toContain(withPath?.path);
  });
});

describe('price proposal body: resolvesConflictId', () => {
  const body = { variationId: 'SQ_VAR_PEP_LG', newPriceMinor: 1900, currency: 'USD' };

  it('is optional, and takes a conflict ID only', () => {
    expect(ProposePriceBodySchema.parse(body)).toEqual(body);
    expect(ProposePriceBodySchema.parse({ ...body, resolvesConflictId: 'cfl_pizza_01' })).toEqual({ ...body, resolvesConflictId: 'cfl_pizza_01' });
    expect(ProposePriceBodySchema.safeParse({ ...body, resolvesConflictId: 'fact_01' }).success).toBe(false);
  });

  it('the body still refuses a field the contract does not name', () => {
    expect(ProposePriceBodySchema.safeParse({ ...body, itemName: 'Pepperoni' }).success).toBe(false);
  });

  it('the price_edit payload did not change: it refuses resolvesConflictId and the display names', () => {
    const payload = F.approvalPriceEditPending.payload;
    expect(PriceEditApprovalPayloadSchema.safeParse(payload).success).toBe(true);
    for (const extra of [{ resolvesConflictId: 'cfl_pizza_01' }, { itemName: 'Pepperoni' }, { variationName: 'Large' }]) {
      expect(PriceEditApprovalPayloadSchema.safeParse({ ...payload, ...extra }).success).toBe(false);
    }
    expect([...MATERIAL_FIELDS.price_edit]).toEqual(['businessId', 'subjectId', 'squareItemId', 'variationId', 'fromPriceMinor', 'newPriceMinor', 'currency', 'squareVersion', 'actionBundle', 'expiresAt']);
  });
});

describe('display names on approvals and agent versions', () => {
  it('an approval parses with and without decidedByName, and keeps it', () => {
    const { decidedByName, ...without } = F.approvalOrderFulfilled;
    expect(decidedByName).toBe(F.ownerUser.displayName);
    expect(ApprovalRequestSchema.parse(without)).toEqual(without);
    expect(ApprovalRequestSchema.parse(F.approvalOrderFulfilled).decidedByName).toBe(F.ownerUser.displayName);
    expect(ApprovalRequestSchema.safeParse({ ...F.approvalOrderFulfilled, decidedByName: '' }).success).toBe(false);
  });

  it('fixture approvals name the decider exactly when one decided', () => {
    for (const a of F.approvals) {
      expect(a.decidedByName, a.id).toBe(a.decidedBy === undefined ? undefined : F.ownerUser.displayName);
    }
  });

  it('the decision response keeps decidedByName and still parses without it', () => {
    const { approval } = F.fixtureResponses.decideApproval;
    expect(DecisionResponseSchema.parse({ approval }).approval.decidedByName).toBe(F.ownerUser.displayName);
    const { decidedByName: _name, ...without } = approval;
    expect(DecisionResponseSchema.parse({ approval: without })).toEqual({ approval: without });
  });

  it('an agent version parses with and without createdByName, and keeps it', () => {
    const { createdByName, ...without } = F.pizzaVersionV2;
    expect(createdByName).toBe(F.ownerUser.displayName);
    expect(AgentVersionSchema.parse(without)).toEqual(without);
    expect(AgentVersionSchema.parse(F.pizzaVersionV2).createdByName).toBe(F.ownerUser.displayName);
  });
});

describe('item names on a price edit', () => {
  it('a price edit approval keeps itemName and variationName, and parses without them', () => {
    const parsed = ProposePriceResponseSchema.parse({ approval: F.approvalPriceEditPending }).approval;
    expect(parsed).toMatchObject({ itemName: 'Pepperoni', variationName: 'Large' });
    const { itemName: _item, variationName: _variation, ...without } = F.approvalPriceEditPending;
    expect(ApprovalRequestSchema.parse(without)).toEqual(without);
  });

  it('the names are outside the payload, so the hash is the stored one', async () => {
    const a = F.approvalPriceEditPending;
    expect(Object.keys(a.payload).sort()).toEqual([...MATERIAL_FIELDS.price_edit].sort());
    expect(await approvalPayloadHash('price_edit', a.payload)).toBe(a.payloadHash);
    expect(a.payloadHash).toBe(GENERATED_HASHES['payload:apv_demo_p01']);
  });

  it('no stored fixture hash changed', () => {
    // The values before issue #108, copied from main. A changed payload would change its hash.
    expect(GENERATED_HASHES['payload:apv_demo_p01']).toBe('sha256:413420bb67db22d31073cbca397e57efd45bc3b03a5ac8a615c10dc2db56879b');
    expect(GENERATED_HASHES['payload:apv_demo_p88r']).toBe('sha256:092e567b69a3b2d7a7bb9bb382438f6e97c51c088d04c211d3f31b91ec9f202f');
    expect(GENERATED_HASHES['payload:apv_demo_01']).toBe('sha256:f0ad266ecf078fdddb0bad8aac8a9a14f5370a061fe27be2cec176274bdb75e1');
  });
});
