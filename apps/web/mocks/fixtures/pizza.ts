/**
 * Demo Pizza Co. (biz_pizza_01). Every time is relative to `now` so pending
 * approvals have a live countdown whenever the mock starts.
 */
import type { AgentSpec, BusinessFact, Call, CatalogItem, Cart } from "@/lib/api/pending-contracts";
import { buildOrder, factEditApproval, iso, MINUTE, orderApproval } from "../builders";
import { TIMEZONE, type MockState } from "../types";
import { History } from "./history";

export const PIZZA = "biz_pizza_01";

export const PIZZA_AGENT_ID = "agt_pizza_01";
export const PIZZA_AGENT_V1 = "agv_pizza_01_v1";
export const PIZZA_AGENT_V2 = "agv_pizza_01_v2";
export const PIZZA_FAQ_AGENT_ID = "agt_pizza_faq_01";

export function pizzaCatalog(now: number): CatalogItem[] {
  const syncedAt = iso(now - 30 * MINUTE);
  const toppings = {
    id: "SQ_MODLIST_TOPPINGS",
    name: "Toppings",
    selectionType: "MULTIPLE" as const,
    modifiers: [
      { id: "SQ_MOD_MUSHROOM", name: "Mushrooms", priceMinor: 150 },
      { id: "SQ_MOD_OLIVES", name: "Olives", priceMinor: 150 },
      { id: "SQ_MOD_XCHEESE", name: "Extra cheese", priceMinor: 200 },
    ],
  };
  return [
    {
      squareItemId: "SQ_ITEM_MARG",
      businessId: PIZZA,
      name: "Margherita",
      description: "Tomato, mozzarella, basil",
      available: true,
      variations: [
        { id: "SQ_VAR_MARG_SM", name: "Small", priceMinor: 1200, currency: "USD" },
        { id: "SQ_VAR_MARG_MD", name: "Medium", priceMinor: 1600, currency: "USD" },
        { id: "SQ_VAR_MARG_LG", name: "Large", priceMinor: 2000, currency: "USD" },
      ],
      modifierLists: [toppings],
      syncedAt,
    },
    {
      squareItemId: "SQ_ITEM_PEP",
      businessId: PIZZA,
      name: "Pepperoni",
      description: "Tomato, mozzarella, pepperoni",
      available: true,
      variations: [
        { id: "SQ_VAR_PEP_SM", name: "Small", priceMinor: 1400, currency: "USD" },
        { id: "SQ_VAR_PEP_MD", name: "Medium", priceMinor: 1800, currency: "USD" },
        { id: "SQ_VAR_PEP_LG", name: "Large", priceMinor: 2200, currency: "USD" },
      ],
      modifierLists: [toppings],
      syncedAt,
    },
  ];
}

/** The pizza timeline cart from CONTRACTS.md 9: Large Margherita with Mushrooms, Large Pepperoni. Total 4731. */
export const TIMELINE_CART: Cart = {
  lines: [
    { catalogItemId: "SQ_ITEM_MARG", variationId: "SQ_VAR_MARG_LG", quantity: 1, modifierIds: ["SQ_MOD_MUSHROOM"] },
    { catalogItemId: "SQ_ITEM_PEP", variationId: "SQ_VAR_PEP_LG", quantity: 1, modifierIds: [] },
  ],
};
const CART_TWO_PEP: Cart = {
  lines: [{ catalogItemId: "SQ_ITEM_PEP", variationId: "SQ_VAR_PEP_LG", quantity: 2, modifierIds: ["SQ_MOD_XCHEESE"] }],
};
const CART_ONE_MARG: Cart = {
  lines: [{ catalogItemId: "SQ_ITEM_MARG", variationId: "SQ_VAR_MARG_MD", quantity: 1, modifierIds: [] }],
};

export function pizzaSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: PIZZA_AGENT_ID,
    businessId: PIZZA,
    version: 2,
    template: "restaurant_order_taker",
    name: "Pizza Order Assistant",
    channel: "phone",
    goal: "Take pickup orders by phone and send each one to the owner for approval.",
    knowledgeScopes: ["business_profile", "catalog", "hours", "order_policies"],
    capabilities: [
      "catalog.read",
      "business.facts.read",
      "order.quote",
      "order.propose",
      "order.status.read",
      "order.checkout.prepare",
      "message.checkout.send",
      "sheets.rows.append",
    ],
    writePolicy: "owner_approval_each_action_bundle",
    escalation: "explain_unsupported_or_offer_callback",
    status: "live",
    guardrailVersion: "v1",
    greeting:
      "Hi, thanks for calling Demo Pizza Co. You are speaking with an AI assistant. I can answer menu questions and take pickup orders. What can I get for you?",
    ...overrides,
  };
}

const HOURS: Record<string, { open: string; close: string }> = {
  mon: { open: "11:00", close: "21:00" },
  tue: { open: "11:00", close: "21:00" },
  wed: { open: "11:00", close: "21:00" },
  thu: { open: "11:00", close: "22:00" },
  fri: { open: "11:00", close: "22:00" },
  sat: { open: "12:00", close: "22:00" },
  sun: { open: "12:00", close: "21:00" },
};

function fact(
  id: string,
  kind: BusinessFact["kind"],
  key: string,
  value: unknown,
  at: number,
  extra: Partial<BusinessFact> = {},
): BusinessFact {
  return {
    id,
    businessId: PIZZA,
    kind,
    key,
    value,
    sourceType: "seed",
    status: "verified",
    confidence: 1,
    version: 1,
    verifiedAt: iso(at),
    createdAt: iso(at),
    updatedAt: iso(at),
    ...extra,
  };
}

export function seedPizza(state: MockState, now: number): void {
  const h = new History(state, PIZZA);
  const seedAt = now - 26 * 60 * MINUTE;
  const catalog = pizzaCatalog(now);

  state.businesses.push({
    id: PIZZA,
    name: "Demo Pizza Co.",
    category: "restaurant",
    timezone: TIMEZONE,
    contact: { phone: "+15555550100", email: "owner@example.com", address: "100 Demo Street, San Luis Obispo, CA" },
    settings: {},
    createdAt: iso(seedAt),
    updatedAt: iso(seedAt),
  });
  state.catalog.push(...catalog);

  // ---- facts: hours per weekday (fri was edited once), policies, contact
  for (const [day, value] of Object.entries(HOURS)) {
    if (day === "fri") continue;
    state.facts.push(fact(`fact_pizza_hours_${day}`, "hours", day, value, seedAt));
  }
  const friV1 = fact("fact_pizza_hours_fri", "hours", "fri", { open: "11:00", close: "21:00" }, seedAt, {
    status: "superseded",
  });
  const friV2 = fact("fact_pizza_hours_fri_v2", "hours", "fri", HOURS.fri, now - 5 * 60 * MINUTE, {
    sourceType: "owner_chat",
    version: 2,
    supersedesId: friV1.id,
  });
  state.facts.push(friV1, friV2);
  state.facts.push(
    fact("fact_pizza_pickup_window", "policy", "pickup_window", { minutes: 20 }, seedAt),
    fact("fact_pizza_special_requests", "policy", "special_requests", { allowed: true }, seedAt),
    fact("fact_pizza_contact_phone", "contact", "phone", { phone: "+15555550100" }, seedAt),
  );

  // ---- uploaded menu: draft facts and two open conflicts (one required)
  const fileAt = now - 40 * MINUTE;
  state.files.push({
    id: "file_menu_01",
    businessId: PIZZA,
    name: "menu.pdf",
    mime: "application/pdf",
    sizeBytes: 182044,
    sha256: "4be0c1d29a7f4f0e8b3f0d6a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e",
    extractionState: "EXTRACTED",
    draftFactIds: ["fact_pizza_menu_marg_lg", "fact_pizza_menu_pep_lg", "fact_pizza_draft_pickup"],
    conflictIds: ["cfl_pizza_01", "cfl_pizza_02"],
    createdAt: iso(fileAt),
  });
  const draft = { sourceType: "upload" as const, fileId: "file_menu_01", status: "draft" as const, verifiedAt: undefined };
  state.facts.push(
    fact("fact_pizza_menu_marg_lg", "menu_item", "SQ_VAR_MARG_LG", { item: "Margherita", variation: "Large", priceMinor: 2100 }, fileAt, {
      ...draft,
      confidence: 0.93,
    }),
    fact("fact_pizza_menu_pep_lg", "menu_item", "SQ_VAR_PEP_LG", { item: "Pepperoni", variation: "Large", priceMinor: 2200 }, fileAt, {
      ...draft,
      confidence: 0.91,
    }),
    fact("fact_pizza_draft_pickup", "policy", "pickup_window", { minutes: 25 }, fileAt, { ...draft, confidence: 0.58 }),
  );
  state.conflicts.push(
    {
      id: "cfl_pizza_01",
      businessId: PIZZA,
      kind: "menu_item",
      key: "SQ_VAR_MARG_LG",
      required: true,
      candidates: [
        { factId: "fact_pizza_menu_marg_lg", sourceType: "upload", value: { priceMinor: 2100 } },
        { sourceType: "square", sourceRef: "cat_sq_var_marg_lg", value: { priceMinor: 2000 } },
      ],
      state: "open",
      createdAt: iso(fileAt + 4000),
    },
    {
      id: "cfl_pizza_02",
      businessId: PIZZA,
      kind: "policy",
      key: "pickup_window",
      required: false,
      candidates: [
        { factId: "fact_pizza_draft_pickup", sourceType: "upload", value: { minutes: 25 } },
        { factId: "fact_pizza_pickup_window", sourceType: "seed", value: { minutes: 20 } },
      ],
      state: "open",
      createdAt: iso(fileAt + 4000),
    },
  );
  h.emit("extraction.completed", "file_menu_01", "system", fileAt + 4000, {
    fileId: "file_menu_01",
    mime: "application/pdf",
    extractionState: "EXTRACTED",
    draftFactCount: 3,
    conflictCount: 2,
  });

  // ---- agents: live pizza agent with two versions, a paused FAQ agent
  const v1At = now - 24 * 60 * MINUTE;
  const v2At = now - 6 * 60 * MINUTE;
  state.versions.push(
    {
      id: PIZZA_AGENT_V1,
      agentId: PIZZA_AGENT_ID,
      version: 1,
      spec: pizzaSpec({ version: 1, goal: "Take pickup orders by phone." }),
      knowledgeSnapshotRef: { facts: [{ id: friV1.id, version: 1 }], catalogSyncedAt: iso(v1At) },
      createdBy: "usr_owner_01",
      publishedAt: iso(v1At),
    },
    {
      id: PIZZA_AGENT_V2,
      agentId: PIZZA_AGENT_ID,
      version: 2,
      spec: pizzaSpec(),
      knowledgeSnapshotRef: { facts: [{ id: friV1.id, version: 1 }], catalogSyncedAt: iso(v2At) },
      createdBy: "usr_owner_01",
      publishedAt: iso(v2At),
    },
    {
      id: "agv_pizza_faq_01_v1",
      agentId: PIZZA_FAQ_AGENT_ID,
      version: 1,
      spec: {
        id: PIZZA_FAQ_AGENT_ID,
        businessId: PIZZA,
        version: 1,
        template: "custom",
        name: "Pizza FAQ Assistant",
        channel: "phone",
        goal: "Answer questions about hours and the menu. It takes no orders.",
        knowledgeScopes: ["business_profile", "catalog", "hours", "faq"],
        capabilities: ["catalog.read", "business.facts.read"],
        writePolicy: "owner_approval_each_action_bundle",
        escalation: "explain_unsupported_or_offer_callback",
        status: "live",
        guardrailVersion: "v1",
      },
      knowledgeSnapshotRef: { facts: [], catalogSyncedAt: iso(now - 20 * 60 * MINUTE) },
      createdBy: "usr_owner_01",
      publishedAt: iso(now - 20 * 60 * MINUTE),
    },
  );
  state.agents.push(
    {
      id: PIZZA_AGENT_ID,
      businessId: PIZZA,
      name: "Pizza Order Assistant",
      template: "restaurant_order_taker",
      state: "live",
      activeVersionId: PIZZA_AGENT_V2,
      draftSpec: pizzaSpec(),
      createdAt: iso(v1At - 10 * MINUTE),
      updatedAt: iso(v2At),
    },
    {
      id: PIZZA_FAQ_AGENT_ID,
      businessId: PIZZA,
      name: "Pizza FAQ Assistant",
      template: "custom",
      state: "paused",
      activeVersionId: "agv_pizza_faq_01_v1",
      draftSpec: state.versions[2].spec,
      createdAt: iso(now - 21 * 60 * MINUTE),
      updatedAt: iso(now - 3 * 60 * MINUTE),
    },
  );
  h.emit("agent.published", PIZZA_AGENT_ID, "owner", v1At, { agentId: PIZZA_AGENT_ID, agentVersionId: PIZZA_AGENT_V1, version: 1, phoneNumberLast4: "0199" });
  h.emit("live_agent.changed", PIZZA_AGENT_ID, "owner", v1At, { phoneNumberLast4: "0199", agentId: PIZZA_AGENT_ID, agentVersionId: PIZZA_AGENT_V1 });
  h.emit("agent.published", "agt_pizza_faq_01", "owner", now - 20 * 60 * MINUTE, {
    agentId: PIZZA_FAQ_AGENT_ID,
    agentVersionId: "agv_pizza_faq_01_v1",
    version: 1,
  });
  h.emit("agent.paused", "agt_pizza_faq_01", "owner", now - 3 * 60 * MINUTE, { agentId: PIZZA_FAQ_AGENT_ID });
  h.emit("agent.published", PIZZA_AGENT_ID, "owner", v2At, { agentId: PIZZA_AGENT_ID, agentVersionId: PIZZA_AGENT_V2, version: 2, phoneNumberLast4: "0199" });
  h.emit("live_agent.changed", PIZZA_AGENT_ID, "owner", v2At, {
    phoneNumberLast4: "0199",
    agentId: PIZZA_AGENT_ID,
    agentVersionId: PIZZA_AGENT_V2,
    previousAgentId: PIZZA_AGENT_ID,
  });

  // ---- fact edits: APPROVED (fri), PENDING (sun), REJECTED (sat), EXPIRED (mon)
  const friAt = now - 5 * 60 * MINUTE - 2 * MINUTE;
  const friApproval = factEditApproval({
    id: "apv_pizza_fact_fri",
    businessId: PIZZA,
    subjectId: friV2.id,
    kind: "hours",
    key: "fri",
    fromVersion: 1,
    before: friV1.value,
    after: friV2.value,
    at: friAt,
  });
  state.approvals.push(friApproval);
  h.emit("approval.requested", friApproval.id, "owner", friAt, {
    approvalId: friApproval.id,
    bundleType: "fact_edit",
    subjectId: friV2.id,
    actionBundle: friApproval.actionBundle,
    expiresAt: friApproval.expiresAt,
  });
  h.decide(friApproval, "APPROVED", friApproval.id, friAt + 30_000);
  const friExe = h.execution(friApproval, "local.fact.update", "SUCCEEDED", friAt + 31_000);
  h.emit("execution.started", friApproval.id, "system", friAt + 31_000, {
    executionId: friExe.id,
    approvalId: friApproval.id,
    actionType: "local.fact.update",
    stepIndex: 0,
    attempt: 1,
  });
  h.emit("fact.changed", friApproval.id, "system", friAt + 32_000, {
    factId: friV2.id,
    kind: "hours",
    key: "fri",
    fromVersion: 1,
    toVersion: 2,
    sourceType: "owner_chat",
  });
  h.emit("execution.succeeded", friApproval.id, "system", friAt + 32_000, { executionId: friExe.id, actionType: "local.fact.update" });

  const factEdit = (id: string, day: string, after: unknown, at: number, end: "PENDING" | "REJECTED" | "EXPIRED") => {
    const current = state.facts.find((f) => f.kind === "hours" && f.key === day && f.status === "verified")!;
    const draftFact = fact(`fact_pizza_hours_${day}_d${id.slice(-2)}`, "hours", day, after, at, {
      sourceType: "owner_chat",
      status: end === "PENDING" ? "draft" : "superseded",
      verifiedAt: undefined,
    });
    state.facts.push(draftFact);
    const apv = factEditApproval({
      id,
      businessId: PIZZA,
      subjectId: draftFact.id,
      kind: "hours",
      key: day,
      fromVersion: current.version,
      before: current.value,
      after,
      at,
    });
    state.approvals.push(apv);
    h.emit("approval.requested", id, "owner", at, {
      approvalId: id,
      bundleType: "fact_edit",
      subjectId: draftFact.id,
      actionBundle: apv.actionBundle,
      expiresAt: apv.expiresAt,
    });
    if (end === "REJECTED") h.decide(apv, "REJECTED", id, at + 40_000);
    if (end === "EXPIRED") h.expire(apv, id);
  };
  factEdit("apv_pizza_fact_sat", "sat", { open: "11:00", close: "23:00" }, now - 7 * 60 * MINUTE, "REJECTED");
  factEdit("apv_pizza_fact_mon", "mon", { closed: true }, now - 9 * 60 * MINUTE, "EXPIRED");
  factEdit("apv_pizza_fact_sun", "sun", { open: "12:00", close: "22:00" }, now - 1 * MINUTE, "PENDING");

  // ---- calls and orders
  const contact = (name: string, phone: string) => ({ name, messageRecipient: phone, messageConsent: true });
  const call = (id: string, at: number, status: Call["status"], last: string, channel: Call["channel"] = "phone"): Call => ({
    id,
    businessId: PIZZA,
    agentId: PIZZA_AGENT_ID,
    agentVersionId: PIZZA_AGENT_V2,
    channel,
    stage: "CUSTOMER_CONFIRMED",
    providerCallId: channel === "phone" ? `CA${id.replace(/[^a-z0-9]/gi, "")}` : undefined,
    callerLast4: channel === "phone" ? last : undefined,
    status,
    endReason: status === "COMPLETED" ? "completed" : status === "DROPPED" ? "dropped" : undefined,
    startedAt: iso(at),
    endedAt: status === "IN_PROGRESS" ? undefined : iso(at + 4 * MINUTE),
  });
  const orderCall = (
    callId: string,
    orderId: string,
    approvalId: string,
    cart: Cart,
    who: [string, string],
    startAt: number,
    channel: Call["channel"] = "phone",
  ) => {
    const c = call(callId, startAt, "COMPLETED", who[1].slice(-4), channel);
    const proposedAt = h.call(c, ["CALL_STARTED", "COLLECTING", "VALIDATING", "CUSTOMER_CONFIRMED"], "order", startAt);
    const order = buildOrder({
      id: orderId,
      businessId: PIZZA,
      callId,
      catalog,
      cart,
      contact: contact(who[0], who[1]),
      pickupAt: startAt + 45 * MINUTE,
      at: proposedAt,
    });
    const approval = orderApproval(order, PIZZA_AGENT_V2, approvalId, proposedAt);
    order.approvalId = approval.id;
    state.orders.push(order);
    state.approvals.push(approval);
    h.proposal(order, approval, c, proposedAt);
    h.endCall(c, proposedAt + 30_000);
    return { order, approval, at: proposedAt };
  };

  // FULFILLMENT_READY, Sheets DONE
  {
    const { order, approval, at } = orderCall("call_pizza_ready", "ord_pizza_ready", "apv_pizza_ready", CART_ONE_MARG, ["Lee", "+15555550131"], now - 180 * MINUTE);
    h.approvedOrder(order, approval, at + MINUTE, { message: "SENT", payment: "verified", sync: "DONE", ready: true });
  }
  // REJECTED
  {
    const { order, approval, at } = orderCall("call_pizza_rej", "ord_pizza_rejected", "apv_pizza_rejected", CART_TWO_PEP, ["Kim", "+15555550132"], now - 150 * MINUTE);
    h.decide(approval, "REJECTED", order.callId, at + 2 * MINUTE);
    h.orderStatus(order, "AWAITING_OWNER_APPROVAL", "REJECTED", at + 2 * MINUTE);
  }
  // APPROVAL_EXPIRED
  {
    const { order, approval } = orderCall("call_pizza_exp", "ord_pizza_expired", "apv_pizza_expired", CART_ONE_MARG, ["Jo", "+15555550133"], now - 130 * MINUTE);
    h.expire(approval, order.callId);
    h.orderStatus(order, "AWAITING_OWNER_APPROVAL", "APPROVAL_EXPIRED", Date.parse(approval.expiresAt));
  }
  // PAYMENT_FAILED (simulated call, declined sandbox card)
  {
    const { order, approval, at } = orderCall("call_pizza_sim", "ord_pizza_payfail", "apv_pizza_payfail", CART_ONE_MARG, ["Ari", "+15555550134"], now - 100 * MINUTE, "test_console");
    h.approvedOrder(order, approval, at + MINUTE, { message: "SENT", payment: "failed" });
  }
  // PAID_VERIFIED, Sheets RETRYING
  {
    const { order, approval, at } = orderCall("call_pizza_paid", "ord_pizza_paid", "apv_pizza_paid", CART_TWO_PEP, ["Sam", "+15555550123"], now - 70 * MINUTE);
    h.approvedOrder(order, approval, at + MINUTE, { message: "SENT", payment: "verified", sync: "RETRYING" });
  }
  // A call lost before the order was confirmed (AC-18): no order, no approval
  {
    const c = call("call_pizza_dropped", now - 50 * MINUTE, "DROPPED", "0177");
    c.stage = "COLLECTING";
    const t = h.call(c, ["CALL_STARTED", "COLLECTING"], "order", now - 50 * MINUTE);
    h.endCall(c, t + 40_000);
  }
  // PAYMENT_PENDING, message FAILED so the QR code is the way to pay
  {
    const { order, approval, at } = orderCall("call_pizza_link", "ord_pizza_link", "apv_pizza_link", TIMELINE_CART, ["Max", "+15555550135"], now - 25 * MINUTE);
    h.approvedOrder(order, approval, at + MINUTE, { message: "FAILED", payment: "pending" });
  }
  // A guardrail refusal on a call with no order
  {
    const c = call("call_pizza_guard", now - 15 * MINUTE, "COMPLETED", "0188");
    c.stage = "COLLECTING";
    const t = h.call(c, ["CALL_STARTED", "COLLECTING"], "order", now - 15 * MINUTE);
    h.emit("guardrail.refused", c.id, "deployed_agent", t + 10_000, { callId: c.id, rule: "no_fact_changes" });
    h.endCall(c, t + 60_000);
  }
  // AWAITING_OWNER_APPROVAL, still pending (about 7 minutes left at start)
  orderCall("call_pizza_pending", "ord_pizza_pending", "apv_pizza_pending", TIMELINE_CART, ["Rae", "+15555550136"], now - 5 * MINUTE);

  // A rejected webhook against the Square integration
  h.emit("webhook.rejected", "whk_rejected_01", "provider", now - 12 * MINUTE, { provider: "square", reason: "signature_invalid" });
}
