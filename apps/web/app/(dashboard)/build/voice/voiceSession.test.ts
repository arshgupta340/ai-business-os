import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DATA_CHANNEL_LABEL, parseServerEvent, REALTIME_CALLS_URL, speakReplyEvent} from './realtime';
import {VoiceSession, type VoiceState} from './voiceSession';
import {ANSWER_SDP, apiError, createFakes, flush, SECRET, type FakeOptions} from './fakes.test-helpers';

const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  // The secret is never logged, by anything the session runs.
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    spy.mockRestore();
  }
  consoleSpies.length = 0;
});

function setup(options: FakeOptions = {}, extra: {unavailable?: 'mock'} = {}) {
  const fakes = createFakes(options);
  const states: VoiceState[] = [];
  const transcripts: string[] = [];
  const session = new VoiceSession({
    deps: fakes.deps,
    mint: fakes.mint,
    onChange: (s) => states.push(s),
    onTranscript: (t) => transcripts.push(t),
    unavailable: extra.unavailable,
  });
  return {fakes, session, states, transcripts};
}

async function connect(options: FakeOptions = {}) {
  const ctx = setup(options);
  await ctx.session.start();
  ctx.fakes.dc?.open();
  return ctx;
}

function expectReleased(fakes: ReturnType<typeof createFakes>) {
  expect(fakes.tracks.length).toBeGreaterThan(0);
  expect(fakes.tracks.every((t) => t.stopped)).toBe(true);
  for (const pc of fakes.pcs) expect(pc.closed).toBe(true);
  for (const pc of fakes.pcs) for (const dc of pc.channels) expect(dc.readyState).toBe('closed');
  for (const audio of fakes.audios) expect(audio.srcObject).toBeNull();
}

describe('VoiceSession: the happy path', () => {
  it('asks for the microphone, then mints, then connects and posts the SDP offer with the secret', async () => {
    const {fakes, session, states} = await connect();
    expect(fakes.log).toEqual([
      'getUserMedia:{"audio":true}',
      'mint',
      'createPeerConnection',
      'addTrack',
      `createDataChannel:${DATA_CHANNEL_LABEL}`,
      'createOffer',
      'setLocalDescription',
      'fetch',
      'setRemoteDescription',
    ]);
    expect(states.map((s) => s.phase)).toEqual(['requesting_microphone', 'connecting', 'listening']);
    expect(session.state.phase).toBe('listening');

    const [call] = fakes.fetchCalls;
    expect(call.url).toBe(REALTIME_CALLS_URL);
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe('v=0 offer');
    expect(call.init.headers).toEqual({Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/sdp'});
    expect(fakes.pc.remote).toEqual({type: 'answer', sdp: ANSWER_SDP});
    expect(fakes.dc.label).toBe('oai-events');
  });

  it('plays the remote audio track', async () => {
    const {fakes} = await connect();
    const remote = {id: 'remote'};
    fakes.pc.ontrack?.({streams: [remote]});
    expect(fakes.audios[0].autoplay).toBe(true);
    expect(fakes.audios[0].srcObject).toBe(remote);
  });

  it('keeps the secret out of state and out of every URL', async () => {
    const {fakes, states} = await connect();
    expect(JSON.stringify(states)).not.toContain(SECRET);
    for (const call of fakes.fetchCalls) expect(call.url).not.toContain(SECRET);
  });

  it('reports each completed transcription once, and a blank or failed one as a note', async () => {
    const {fakes, transcripts, session} = await connect();
    fakes.dc.emit({type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: 'I run'});
    fakes.dc.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', content_index: 0, transcript: '  I run a pizza shop. '});
    expect(transcripts).toEqual(['I run a pizza shop.']);

    fakes.dc.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_2', content_index: 0, transcript: '   '});
    expect(transcripts).toHaveLength(1);
    expect(session.state.note).toBe('not_heard');

    session.setNote(null);
    fakes.dc.emit({type: 'conversation.item.input_audio_transcription.failed', item_id: 'item_3', content_index: 0, error: {message: 'x'}});
    expect(session.state.note).toBe('not_heard');
    expect(transcripts).toHaveLength(1);
  });

  it('asks the model to speak the reply exactly, with no tools, and never sends session.update', async () => {
    const {fakes, session} = await connect();
    expect(session.speak('What time do you close on Fridays?')).toBe(true);
    expect(session.state.phase).toBe('speaking');
    const events = fakes.dc.sentEvents();
    expect(events).toEqual([speakReplyEvent('What time do you close on Fridays?')]);
    const [event] = events as Array<{type: string; response: Record<string, unknown>}>;
    expect(event.type).toBe('response.create');
    expect(event.response.input).toEqual([
      {type: 'message', role: 'user', content: [{type: 'input_text', text: 'What time do you close on Fridays?'}]},
    ]);
    expect(event.response.conversation).toBe('none');
    expect(event.response.tool_choice).toBe('none');
    expect('tools' in event.response).toBe(false);
    expect(events.some((e) => e.type === 'session.update')).toBe(false);
  });

  it('goes back to listening when the spoken audio stops or the response does not complete', async () => {
    const {fakes, session} = await connect();
    session.speak('One');
    fakes.dc.emit({type: 'output_audio_buffer.started', response_id: 'resp_1'});
    fakes.dc.emit({type: 'response.done', response: {id: 'resp_1', status: 'completed'}});
    expect(session.state.phase).toBe('speaking');
    fakes.dc.emit({type: 'output_audio_buffer.stopped', response_id: 'resp_1'});
    expect(session.state.phase).toBe('listening');

    session.speak('Two');
    fakes.dc.emit({type: 'response.done', response: {id: 'resp_2', status: 'failed'}});
    expect(session.state.phase).toBe('listening');
  });

  it('mutes and unmutes the microphone track', async () => {
    const {fakes, session} = await connect();
    session.setMuted(true);
    expect(fakes.tracks[0].enabled).toBe(false);
    expect(session.state.isMuted).toBe(true);
    session.setMuted(false);
    expect(fakes.tracks[0].enabled).toBe(true);
  });

  it('does not speak when it is not connected', () => {
    const {session} = setup();
    expect(session.speak('Hello')).toBe(false);
  });
});

describe('VoiceSession: stop and dispose', () => {
  it('stop releases the microphone, closes the channel and the connection, and stops the audio', async () => {
    const {fakes, session} = await connect();
    session.stop();
    expect(session.state.phase).toBe('ended');
    expectReleased(fakes);
  });

  it('stop while the microphone prompt is open releases the stream when it arrives and never mints', async () => {
    const {fakes, session} = setup({holdMic: true});
    const started = session.start();
    session.stop();
    fakes.releaseMic();
    await started;
    expect(fakes.log).toEqual(['getUserMedia:{"audio":true}']);
    expect(fakes.tracks[0].stopped).toBe(true);
    expect(session.state.phase).toBe('ended');
  });

  it('stop while minting never opens a connection', async () => {
    const {fakes, session} = setup({holdMint: true});
    const started = session.start();
    await flush();
    session.stop();
    fakes.releaseMint();
    await started;
    expect(fakes.pcs).toHaveLength(0);
    expect(fakes.tracks[0].stopped).toBe(true);
  });

  it('dispose releases everything and reports nothing afterwards', async () => {
    const {fakes, session, states} = await connect();
    const count = states.length;
    session.dispose();
    expectReleased(fakes);
    fakes.dc.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: 'late'});
    expect(states).toHaveLength(count);
  });

  it('can start again after stopping', async () => {
    const {fakes, session} = await connect();
    session.stop();
    await session.start();
    fakes.dc.open();
    expect(session.state.phase).toBe('listening');
    expect(fakes.pcs).toHaveLength(2);
  });
});

describe('VoiceSession: failures', () => {
  it('mock mode never asks for the microphone', async () => {
    const {fakes, session} = setup({}, {unavailable: 'mock'});
    expect(session.state).toMatchObject({phase: 'failed', failure: 'mock'});
    expect(session.canStart()).toBe(false);
    await session.start();
    expect(fakes.log).toEqual([]);
  });

  it('no WebRTC support: fails before the microphone', async () => {
    const {fakes, session} = setup({supported: false});
    session.checkSupport();
    expect(session.state.failure).toBe('unsupported');
    await session.start();
    expect(fakes.log).toEqual([]);
  });

  it.each([
    ['NotAllowedError', 'microphone_denied'],
    ['SecurityError', 'microphone_denied'],
    ['NotFoundError', 'no_microphone'],
    ['NotReadableError', 'microphone_failed'],
  ])('a microphone %s ends in %s and never mints', async (name, failure) => {
    const {fakes, session} = setup({micError: {name}});
    await session.start();
    expect(session.state).toMatchObject({phase: 'failed', failure});
    expect(fakes.log).toEqual(['getUserMedia:{"audio":true}']);
    expect(session.canStart()).toBe(true);
  });

  it('INTEGRATION_UNAVAILABLE releases the microphone and never asks for it again', async () => {
    const {fakes, session} = setup({mintError: apiError('INTEGRATION_UNAVAILABLE', {provider: 'openai'})});
    await session.start();
    expect(session.state).toMatchObject({phase: 'failed', failure: 'integration_unavailable'});
    expect(fakes.tracks[0].stopped).toBe(true);
    expect(fakes.pcs).toHaveLength(0);
    expect(session.canStart()).toBe(false);
    await session.start();
    expect(fakes.log.filter((l) => l.startsWith('getUserMedia'))).toHaveLength(1);
  });

  it('RATE_LIMITED waits for Retry-After before voice can start again', async () => {
    const {fakes, session} = setup({mintError: apiError('RATE_LIMITED', {retryAfterSeconds: 30})});
    await session.start();
    expect(session.state.failure).toBe('rate_limited');
    expect(session.state.retryAt).toBe(fakes.deps.now() + 30_000);
    expect(fakes.tracks[0].stopped).toBe(true);
    expect(session.canStart()).toBe(false);
    await session.start();
    expect(fakes.log.filter((l) => l === 'mint')).toHaveLength(1);
    fakes.advance(30_000);
    expect(session.canStart()).toBe(true);
  });

  it('counts the rate limit down on its own clock, not Date.now', async () => {
    const {fakes, session} = setup({mintError: apiError('RATE_LIMITED', {retryAfterSeconds: 30})});
    expect(session.retryInMs()).toBeNull();
    await session.start();
    expect(session.retryInMs()).toBe(30_000);
    fakes.advance(12_000);
    expect(session.retryInMs()).toBe(18_000);
    fakes.advance(60_000);
    expect(session.retryInMs()).toBe(0);
  });

  it('RATE_LIMITED without retryAfterSeconds waits 60 seconds', async () => {
    const {fakes, session} = setup({mintError: apiError('RATE_LIMITED')});
    await session.start();
    expect(session.state.retryAt).toBe(fakes.deps.now() + 60_000);
  });

  it('any other mint error is a plain failure that can be tried again', async () => {
    const {fakes, session} = setup({mintError: apiError('NOT_FOUND')});
    await session.start();
    expect(session.state.failure).toBe('mint_failed');
    expect(fakes.tracks[0].stopped).toBe(true);
    expect(session.canStart()).toBe(true);
  });

  it('an already expired secret is not used', async () => {
    const {fakes, session} = setup({expiresInMs: -1});
    await session.start();
    expect(session.state.failure).toBe('expired');
    expect(fakes.fetchCalls).toHaveLength(0);
    expect(fakes.tracks[0].stopped).toBe(true);
  });

  it('an SDP answer error fails cleanly and shows nothing from the provider body', async () => {
    const {fakes, session, states} = setup({sdpStatus: 401});
    await session.start();
    expect(session.state.failure).toBe('connection_failed');
    expectReleased(fakes);
    expect(JSON.stringify(states)).not.toContain('provider error body');
  });

  it('a network error on the SDP post fails cleanly', async () => {
    const {fakes, session} = setup({fetchThrows: true});
    await session.start();
    expect(session.state.failure).toBe('connection_failed');
    expectReleased(fakes);
  });

  it('a data channel that never opens times out', async () => {
    const {fakes, session} = setup();
    await session.start();
    expect(session.state.phase).toBe('connecting');
    const timer = fakes.timers[fakes.timers.length - 1];
    timer.fn();
    expect(session.state.failure).toBe('connection_failed');
    expectReleased(fakes);
  });

  it('the connection dropping after it opened ends in connection_lost', async () => {
    const {fakes, session} = await connect();
    fakes.pc.drop();
    expect(session.state).toMatchObject({phase: 'failed', failure: 'connection_lost'});
    expectReleased(fakes);
  });

  it('the data channel closing ends in connection_lost', async () => {
    const {fakes, session} = await connect();
    fakes.dc.remoteClose();
    expect(session.state.failure).toBe('connection_lost');
    expectReleased(fakes);
  });
});

describe('parseServerEvent', () => {
  it('ignores what it does not know and bad JSON', () => {
    expect(parseServerEvent('not json')).toEqual({kind: 'other'});
    expect(parseServerEvent(JSON.stringify({type: 'session.created'}))).toEqual({kind: 'other'});
    expect(parseServerEvent(42)).toEqual({kind: 'other'});
  });
});
