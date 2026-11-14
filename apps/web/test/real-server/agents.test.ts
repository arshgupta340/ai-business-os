// Builder sessions and agents: create, message, preview, test, publish, pause, versions, rollback,
// the voice client secret and the live agent, through the web client against the real server.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { barberAgent, barberVersionV1, pizzaAgent, pizzaVersionV1, pizzaVersionV2 } from "@abos/contracts/fixtures";
import * as api from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { BARBER, BUSINESSES, PIZZA, markProvidersHealthy, rejection, startRealServer, VOICE_ENV, type RealServer } from "./harness";

vi.mock("@/lib/supabase/client", async () => (await import("./harness")).fakeSupabaseModule);

let s: RealServer;
beforeAll(async () => {
  s = await startRealServer({}, VOICE_ENV);
  markProvidersHealthy(s.world);
}, 120_000);
afterAll(async () => {
  await s?.close();
});

const PIZZA_SCRIPT = [
  "I run a pizza shop and want an AI that takes pickup orders.",
  "Ask the caller if they agree to get one text with the payment link, and only send it if they say yes.",
];

describe("builder sessions", () => {
  let sessionId = "";

  it.each(BUSINESSES)("createBuilderSession for %s answers a session with messages and progress", async (businessId) => {
    const session = await api.createBuilderSession(businessId);
    expect(session).toMatchObject({ businessId, status: "active" });
    expect(Array.isArray(session.messages)).toBe(true);
    expect(session.progress).toBeDefined();
    expect(Array.isArray(session.missingFields)).toBe(true);
    if (businessId === PIZZA) sessionId = session.id;
  });

  it("sendBuilderMessage answers a turn with the fields the Build screen reads", async () => {
    let turn = await api.sendBuilderMessage(PIZZA, sessionId, { text: PIZZA_SCRIPT[0]!, inputMode: "text" });
    expect(turn.reply.text.length).toBeGreaterThan(0);
    expect(Array.isArray(turn.suggestions)).toBe(true);
    expect(Array.isArray(turn.stopConditions)).toBe(true);
    expect(Array.isArray(turn.unsupportedRequests)).toBe(true);
    expect(turn.draftSpec).toBeDefined();
    turn = await api.sendBuilderMessage(PIZZA, sessionId, { text: PIZZA_SCRIPT[1]!, inputMode: "voice" });
    expect(turn.progress).toBeDefined();
  });

  it("getBuilderSession reads the session back with both owner messages", async () => {
    const session = await api.getBuilderSession(PIZZA, sessionId);
    expect(session.id).toBe(sessionId);
    expect(session.messages.filter((m) => m.role === "owner").map((m) => m.text)).toEqual(PIZZA_SCRIPT);
  });

  it("getBuilderSession from the other business answers NOT_FOUND", async () => {
    const err = (await rejection(api.getBuilderSession(BARBER, sessionId))) as ApiError;
    expect(err.code).toBe("NOT_FOUND");
  });

  it("createAgent from the session answers a draft agent, and getAgent reads it", async () => {
    const agent = await api.createAgent(PIZZA, { builderSessionId: sessionId });
    expect(agent).toMatchObject({ businessId: PIZZA, state: "draft", isLiveAgent: false });
    const read = await api.getAgent(PIZZA, agent.id);
    expect(read).toMatchObject({ id: agent.id, state: "draft" });
    expect(read.draftSpec).toBeDefined();
  });

  it("createRealtimeClientSecret answers an ApiError the Build screen can fall back from when OpenAI is not configured", async () => {
    // No OpenAI key reaches the builder in this world, so no secret is minted and nothing goes to the network.
    const err = (await rejection(api.createRealtimeClientSecret(PIZZA, { builderSessionId: sessionId }))) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe("http");
    expect(err.code).toBe("INTEGRATION_UNAVAILABLE");
  });
});

describe("agents", () => {
  it.each(BUSINESSES)("listAgents %s lists the seeded agent with the fields the Agents screen reads", async (businessId) => {
    const page = await api.listAgents(businessId);
    const seeded = businessId === PIZZA ? pizzaAgent : barberAgent;
    const agent = page.items.find((a) => a.id === seeded.id);
    expect(agent).toMatchObject({ businessId, name: seeded.name, state: "live" });
    expect(agent!.activeVersionId).toBeDefined();
    expect(typeof agent!.isLiveAgent).toBe("boolean");
    expect(page.items.every((a) => a.businessId === businessId)).toBe(true);
  });

  it("listAgents sends state and limit as query parameters", async () => {
    const page = await api.listAgents(PIZZA, { state: "live", limit: 5 });
    expect(page.items.every((a) => a.state === "live")).toBe(true);
    const url = s.requests.at(-1)!.url;
    expect(url.searchParams.get("state")).toBe("live");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it.each([
    [PIZZA, pizzaAgent.id],
    [BARBER, barberAgent.id],
  ])("getAgent %s answers the active version", async (businessId, agentId) => {
    const agent = await api.getAgent(businessId, agentId);
    expect(agent.state).toBe("live");
    expect(agent.activeVersion?.id).toBe(agent.activeVersionId);
    expect(agent.activeVersion?.spec).toBeDefined();
  });

  it("the pizza agent is the live agent; the barber agent is not", async () => {
    expect((await api.getAgent(PIZZA, pizzaAgent.id)).isLiveAgent).toBe(true);
    expect((await api.getAgent(BARBER, barberAgent.id)).isLiveAgent).toBe(false);
  });

  it.each([
    [PIZZA, pizzaAgent.id],
    [BARBER, barberAgent.id],
  ])("previewAgent %s answers permissions and examples from mock tools", async (businessId, agentId) => {
    const preview = await api.previewAgent(businessId, agentId);
    expect(preview.agentId).toBe(agentId);
    expect(preview.permissions.readOnly.length).toBeGreaterThan(0);
    expect(Array.isArray(preview.examples)).toBe(true);
    for (const ex of preview.examples) for (const t of ex.toolTrace) expect(t.mocked).toBe(true);
    expect(s.world.squareWrites).toEqual([]);
  });

  it.each([
    [PIZZA, pizzaAgent.id],
    [BARBER, barberAgent.id],
  ])("testAgent %s answers a turn with a session id and a tool trace of mock tools only", async (businessId, agentId) => {
    const first = await api.testAgent(businessId, agentId, { message: "What are your hours?" });
    expect(typeof first.reply).toBe("string");
    expect(first.testSessionId).toBeDefined();
    expect(first.callId).toBeUndefined();
    for (const t of first.toolTrace) expect(t.mocked).toBe(true);
    const second = await api.testAgent(businessId, agentId, { testSessionId: first.testSessionId, message: "Thanks", end: true });
    expect(second.testSessionId).toBe(first.testSessionId);
    expect(s.world.messageSends).toBe(0);
  });

  it.each([
    [PIZZA, pizzaAgent.id],
    [BARBER, barberAgent.id],
  ])("listAgentVersions %s answers versions newest first", async (businessId, agentId) => {
    const page = await api.listAgentVersions(businessId, agentId);
    expect(page.items.length).toBeGreaterThan(0);
    const numbers = page.items.map((v) => v.version);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    for (const v of page.items) expect(v.agentId).toBe(agentId);
  });

  it("getAgent for an unknown id answers NOT_FOUND", async () => {
    const err = (await rejection(api.getAgent(PIZZA, "agt_missing"))) as ApiError;
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("publish, pause, rollback and the live agent", () => {
  it("getLiveAgent answers the number and the seeded pizza agent", async () => {
    const live = await api.getLiveAgent();
    expect(live).toMatchObject({ businessId: PIZZA, agentId: pizzaAgent.id, agentVersionId: pizzaVersionV2.id });
    expect(live.phoneNumber).toMatch(/^\+/);
  });

  it("publishAgent without confirm is refused with a VALIDATION_FAILED ApiError", async () => {
    const err = (await rejection(api.publishAgent(PIZZA, pizzaAgent.id, { confirm: false } as never))) as ApiError;
    expect(err.code).toBe("VALIDATION_FAILED");
  });

  let published = "";
  it("publishAgent publishes a new version and answers agent, version and phone number", async () => {
    const res = await api.publishAgent(PIZZA, pizzaAgent.id, { confirm: true, makeLive: true });
    expect(res.agent).toMatchObject({ id: pizzaAgent.id, state: "live", activeVersionId: res.version.id });
    expect(res.version.agentId).toBe(pizzaAgent.id);
    expect(res.phoneNumber).toMatch(/^\+/);
    published = res.version.id;
    expect((await api.getLiveAgent()).agentVersionId).toBe(published);
  });

  it("pauseAgent answers the paused agent", async () => {
    const agent = await api.pauseAgent(PIZZA, pizzaAgent.id);
    expect(agent).toMatchObject({ id: pizzaAgent.id, state: "paused" });
  });

  it("rollbackAgent moves the active version and leaves a paused agent paused", async () => {
    const res = await api.rollbackAgent(PIZZA, pizzaAgent.id, { toVersionId: pizzaVersionV1.id, confirm: true });
    expect(res.agent).toMatchObject({ id: pizzaAgent.id, state: "paused", activeVersionId: pizzaVersionV1.id });
    expect(res.version.id).toBe(pizzaVersionV1.id);
    const versions = await api.listAgentVersions(PIZZA, pizzaAgent.id);
    expect(versions.items.map((v) => v.id)).toEqual(expect.arrayContaining([published, pizzaVersionV1.id, pizzaVersionV2.id]));
  });

  it("pausing a draft agent answers INVALID_STATE", async () => {
    const draft = await api.createAgent(BARBER, { spec: barberVersionV1.spec });
    expect(draft.state).toBe("draft");
    const err = (await rejection(api.pauseAgent(BARBER, draft.id))) as ApiError;
    expect(err.code).toBe("INVALID_STATE");
  });

  it("setLiveAgent points the number at the barber agent, and getLiveAgent reads it back", async () => {
    const live = await api.setLiveAgent({ agentId: barberAgent.id });
    expect(live).toMatchObject({ businessId: BARBER, agentId: barberAgent.id });
    expect(await api.getLiveAgent()).toMatchObject({ businessId: BARBER, agentId: barberAgent.id });
    expect((await api.getAgent(BARBER, barberAgent.id)).isLiveAgent).toBe(true);
  });

  it("setLiveAgent for a paused agent answers INVALID_STATE", async () => {
    const err = (await rejection(api.setLiveAgent({ agentId: pizzaAgent.id }))) as ApiError;
    expect(err.code).toBe("INVALID_STATE");
  });
});
