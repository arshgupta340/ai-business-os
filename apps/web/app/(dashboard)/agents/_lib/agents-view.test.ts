import {describe, expect, it} from 'vitest';
import {ERROR_TEXT} from '@/lib/error-text';
import {ApiError, type Agent, type AgentSpec, type LiveAgent} from '@/lib/api';
import {
  answersNumber,
  canOfferLiveSwitch,
  canOfferPause,
  errorView,
  numberOwner,
  numberOwnerSentence,
  replacedAgentLabel,
  shownSpec,
} from './agents-view';

const businesses = [
  {id: 'biz_pizza_01', name: 'Demo Pizza Co.'},
  {id: 'biz_barber_01', name: 'Demo Barbershop'},
];

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agt_a',
    businessId: 'biz_pizza_01',
    name: 'Agent A',
    template: 'restaurant_order_taker',
    state: 'live',
    activeVersionId: 'agv_a_v1',
    draftSpec: {capabilities: ['catalog.read']},
    isLiveAgent: false,
    createdAt: '2026-11-13T19:00:00Z',
    updatedAt: '2026-11-13T19:00:00Z',
    ...over,
  };
}

const live = (over: Partial<LiveAgent> = {}): LiveAgent => ({
  phoneNumber: '+15555550199',
  businessId: 'biz_pizza_01',
  agentId: 'agt_b',
  agentVersionId: 'agv_b_v1',
  updatedAt: '2026-11-13T19:30:00Z',
  ...over,
});

describe('numberOwner', () => {
  it('is none when no agent answers', () => {
    const owner = numberOwner(live({agentId: undefined, agentVersionId: undefined}), 'biz_pizza_01', [], businesses);
    expect(owner).toEqual({kind: 'none'});
    expect(numberOwnerSentence(owner)).toBe('No agent is answering the phone number.');
    expect(replacedAgentLabel(owner)).toBeNull();
  });

  it('names an agent of this business', () => {
    const b = agent({id: 'agt_b', name: 'Agent B'});
    const owner = numberOwner(live(), 'biz_pizza_01', [b], businesses);
    expect(replacedAgentLabel(owner)).toBe('Agent B');
    expect(numberOwnerSentence(owner)).toBe('Agent B answers the phone number.');
  });

  it('names only the other business, never its agent', () => {
    const owner = numberOwner(live(), 'biz_barber_01', [], businesses);
    expect(owner).toEqual({kind: 'other', businessName: 'Demo Pizza Co.'});
    expect(replacedAgentLabel(owner)).toBe('the agent of Demo Pizza Co.');
  });
});

describe('switch and pause rules', () => {
  it('offers the switch only for a live, published agent that does not answer already', () => {
    expect(canOfferLiveSwitch(agent(), live())).toBe(true);
    expect(canOfferLiveSwitch(agent({state: 'draft', activeVersionId: undefined}), live())).toBe(false);
    expect(canOfferLiveSwitch(agent({state: 'paused'}), live())).toBe(false);
    expect(canOfferLiveSwitch(agent({id: 'agt_b'}), live())).toBe(false);
    expect(canOfferLiveSwitch(agent(), undefined)).toBe(false);
  });

  it('offers pause only for a live agent', () => {
    expect(canOfferPause(agent())).toBe(true);
    expect(canOfferPause(agent({state: 'draft'}))).toBe(false);
    expect(canOfferPause(agent({state: 'paused'}))).toBe(false);
  });

  it('reads who answers from the live agent record when it is loaded', () => {
    expect(answersNumber(agent({isLiveAgent: true}), live())).toBe(false);
    expect(answersNumber(agent({isLiveAgent: true}), undefined)).toBe(true);
  });
});

describe('shownSpec', () => {
  it('uses the active version when there is one, else the draft', () => {
    const version = {
      id: 'agv_a_v1',
      agentId: 'agt_a',
      version: 1,
      spec: {capabilities: ['order.propose' as const]} as AgentSpec, // only the field shownSpec reads
      knowledgeSnapshotRef: {facts: []},
      createdBy: 'usr_1',
      publishedAt: '2026-11-13T19:30:00Z',
    };
    expect(shownSpec(agent({activeVersion: version})).source).toBe('active');
    expect(shownSpec(agent()).source).toBe('draft');
  });
});

describe('errorView', () => {
  const err = (code: ApiError['code'], details?: Record<string, unknown>, retryable = false) =>
    new ApiError({code, message: 'Server text.', status: 409, retryable, details, kind: 'http', correlationId: 'c1'});

  it('explains INVALID_STATE per action without retry', () => {
    expect(errorView(err('INVALID_STATE', {state: 'draft'}), 'pause').message).toBe('This agent is a draft. Publish before pausing.');
    const sw = errorView(err('INVALID_STATE', {state: 'paused'}), 'liveSwitch');
    expect(sw.message).toMatch(/paused/);
    expect(sw.canRetry).toBe(false);
  });

  it('handles the common codes', () => {
    expect(errorView(err('UNAUTHENTICATED'), 'load').needsSignIn).toBe(true);
    expect(errorView(err('FORBIDDEN_BUSINESS'), 'load')).toMatchObject({forbidden: true, message: 'You do not have access to this business.'});
    expect(errorView(err('NOT_FOUND'), 'load')).toMatchObject({notFound: true, message: 'Not found in this business.'});
    expect(errorView(err('INTEGRATION_UNAVAILABLE', {provider: 'openai'}, true), 'change')).toMatchObject({message: 'OpenAI is not responding.', canRetry: true});
    expect(errorView(err('INTERNAL', undefined, true), 'load')).toMatchObject({message: ERROR_TEXT.INTERNAL, canRetry: true, correlationId: 'c1'});
  });
});
