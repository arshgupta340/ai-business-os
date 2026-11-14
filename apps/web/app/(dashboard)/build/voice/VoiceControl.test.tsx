// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BuilderMessage} from '@/lib/api';
import {BusinessProvider} from '@/lib/session';
import {BuilderThreadContext, type BuilderThread, type InputMode} from '../_hooks/useBuilderThread';
import {EMPTY_NOTES} from '../_lib/spec';
import {BuilderChat} from '../_components/BuilderChat';
import {speakReplyEvent} from './realtime';
import {NOT_AVAILABLE, PRIVACY_NOTE, VoiceControl} from './VoiceControl';
import {apiError, createFakes, flush, SECRET, type FakeOptions} from './fakes.test-helpers';

function message(id: string, role: 'owner' | 'assistant', text: string, inputMode: InputMode = 'text'): BuilderMessage {
  return {id, sessionId: 'bld_one', role, inputMode, text, createdAt: '2026-11-14T10:00:00Z'};
}

type ThreadPatch = Partial<Pick<BuilderThread, 'sessionId' | 'isSending' | 'pending' | 'messages'>>;

function makeThread(patch: ThreadPatch = {}, send = vi.fn(async (_text: string, _mode?: InputMode) => true)): BuilderThread {
  const messages = patch.messages ?? [message('bmsg_1', 'assistant', 'What would you like an agent to do?')];
  return {
    sessionId: 'bld_one',
    session: {id: 'bld_one'} as BuilderThread['session'],
    messages,
    isLoading: false,
    loadError: null,
    reload: vi.fn() as unknown as BuilderThread['reload'],
    pending: null,
    isSending: false,
    notes: EMPTY_NOTES,
    hasOwnerTurn: false,
    send,
    retry: vi.fn(async () => true),
    takeFailedText: vi.fn(() => ''),
    ...patch,
  } as BuilderThread;
}

function Wrap({thread, children}: {thread: BuilderThread; children: ReactNode}) {
  return (
    <BusinessProvider>
      <BuilderThreadContext.Provider value={thread}>{children}</BuilderThreadContext.Provider>
    </BusinessProvider>
  );
}

function renderControl(thread: BuilderThread, fakes: ReturnType<typeof createFakes>, isMock = false) {
  const props = {deps: fakes.deps, mint: fakes.mint, isMock};
  const view = render(
    <Wrap thread={thread}>
      <VoiceControl {...props} />
    </Wrap>,
  );
  return {
    ...view,
    update: (next: BuilderThread) =>
      view.rerender(
        <Wrap thread={next}>
          <VoiceControl {...props} />
        </Wrap>,
      ),
  };
}

async function click(name: string | RegExp) {
  const button = await screen.findByRole('button', {name});
  await act(async () => {
    fireEvent.click(button);
    await flush();
  });
}

async function startVoice(fakes: ReturnType<typeof createFakes>) {
  await click('Talk to the builder');
  await act(async () => {
    fakes.dc.open();
  });
  await screen.findByText(new RegExp(`Listening\\. ${PRIVACY_NOTE.replace('.', '\\.')}`));
}

function transcript(fakes: ReturnType<typeof createFakes>, text: string) {
  act(() => {
    fakes.dc.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_x', content_index: 0, transcript: text});
  });
}

const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, method));
  }
});

afterEach(() => {
  cleanup();
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    spy.mockRestore();
  }
  consoleSpies.length = 0;
  vi.unstubAllGlobals();
});

describe('VoiceControl', () => {
  it('in mock mode says voice is not available and never asks for the microphone', async () => {
    const fakes = createFakes();
    renderControl(makeThread(), fakes, true);
    expect(screen.getByText(NOT_AVAILABLE)).toBeTruthy();
    const button = screen.getByRole('button', {name: /not available in this environment/});
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      fireEvent.click(button);
      await flush();
    });
    expect(fakes.log).toEqual([]);
  });

  it('does not touch the microphone until the owner presses the button', async () => {
    const fakes = createFakes();
    renderControl(makeThread(), fakes);
    await flush();
    expect(fakes.log).toEqual([]);
    await click('Talk to the builder');
    expect(fakes.log[0]).toBe('getUserMedia:{"audio":true}');
    expect(fakes.log[1]).toBe('mint');
  });

  it('sends one transcript as exactly one voice turn and speaks the reply', async () => {
    const fakes = createFakes();
    const send = vi.fn(async () => true);
    const thread = makeThread({}, send);
    const {update} = renderControl(thread, fakes);
    await startVoice(fakes);

    transcript(fakes, 'I run a pizza shop and want an AI that takes pickup orders.');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('I run a pizza shop and want an AI that takes pickup orders.', 'voice');

    // The thread refetches: the owner turn and the builder reply appear.
    update(
      makeThread(
        {
          messages: [
            ...thread.messages,
            message('bmsg_2', 'owner', 'I run a pizza shop and want an AI that takes pickup orders.', 'voice'),
            message('bmsg_3', 'assistant', 'What is your pickup window?'),
          ],
        },
        send,
      ),
    );
    await waitFor(() => expect(fakes.dc.sent).toHaveLength(1));
    expect(fakes.dc.sentEvents()).toEqual([speakReplyEvent('What is your pickup window?')]);
    expect(fakes.dc.sentEvents().some((e) => e.type === 'session.update')).toBe(false);
    expect(await screen.findByText(/Reading the reply aloud/)).toBeTruthy();
    // The greeting that was there before voice started is not read aloud.
    expect(fakes.dc.sent.join('')).not.toContain('What would you like an agent to do?');
  });

  it('drops speech while a turn is in flight and says so', async () => {
    const fakes = createFakes();
    const send = vi.fn(async () => true);
    const {update} = renderControl(makeThread({}, send), fakes);
    await startVoice(fakes);
    update(makeThread({isSending: true, pending: {status: 'sending', text: 'typed one', inputMode: 'text'}}, send));
    expect(await screen.findByText(/Sending what you said/)).toBeTruthy();

    transcript(fakes, 'And we close at ten.');
    expect(send).not.toHaveBeenCalled();
    expect(await screen.findByText(/The builder was still answering, so that was not sent/)).toBeTruthy();
  });

  it('drops speech while a failed turn waits for a retry', async () => {
    const fakes = createFakes();
    const send = vi.fn(async () => true);
    const {update} = renderControl(makeThread({}, send), fakes);
    await startVoice(fakes);
    update(makeThread({pending: {status: 'failed', text: 'x', inputMode: 'voice', error: apiError('NOT_FOUND')}}, send));
    transcript(fakes, 'Hello');
    expect(send).not.toHaveBeenCalled();
  });

  it('mute and stop', async () => {
    const fakes = createFakes();
    renderControl(makeThread(), fakes);
    await startVoice(fakes);
    await click('Mute the microphone');
    expect(fakes.tracks[0].enabled).toBe(false);
    expect(screen.getByText(/Muted\./)).toBeTruthy();
    await click('Unmute the microphone');
    expect(fakes.tracks[0].enabled).toBe(true);
    await click('Stop voice');
    expect(fakes.tracks[0].stopped).toBe(true);
    expect(fakes.pc.closed).toBe(true);
    expect(screen.getByText('Voice is off.')).toBeTruthy();
  });

  it('unmount (route change) releases the microphone and the connection', async () => {
    const fakes = createFakes();
    const {unmount} = renderControl(makeThread(), fakes);
    await startVoice(fakes);
    unmount();
    expect(fakes.tracks[0].stopped).toBe(true);
    expect(fakes.pc.closed).toBe(true);
    expect(fakes.dc.readyState).toBe('closed');
  });

  it('a new session (Start over) stops voice', async () => {
    const fakes = createFakes();
    const {update} = renderControl(makeThread(), fakes);
    await startVoice(fakes);
    update(makeThread({sessionId: 'bld_two', messages: []}));
    await waitFor(() => expect(fakes.tracks[0].stopped).toBe(true));
    expect(fakes.pc.closed).toBe(true);
  });

  it('page unload stops voice', async () => {
    const fakes = createFakes();
    renderControl(makeThread(), fakes);
    await startVoice(fakes);
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(fakes.tracks[0].stopped).toBe(true);
    expect(fakes.pc.closed).toBe(true);
  });

  it('keeps the secret out of storage and the URL', async () => {
    const fakes = createFakes();
    renderControl(makeThread(), fakes);
    await startVoice(fakes);
    const stored = [window.localStorage, window.sessionStorage].flatMap((s) =>
      Array.from({length: s.length}, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? '')}`),
    );
    expect(stored.join('\n')).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it.each<[string, FakeOptions, RegExp]>([
    ['a denied microphone', {micError: {name: 'NotAllowedError'}}, /The microphone is blocked, so voice is off/],
    ['INTEGRATION_UNAVAILABLE', {mintError: apiError('INTEGRATION_UNAVAILABLE', {provider: 'openai'})}, /Voice is not available in this environment/],
    ['RATE_LIMITED', {mintError: apiError('RATE_LIMITED', {retryAfterSeconds: 30})}, /Try again in \d+ seconds/],
    ['an SDP failure', {sdpStatus: 500}, /Voice did not connect/],
  ])('after %s it explains in one sentence and releases the microphone', async (_name, options, sentence) => {
    const fakes = createFakes(options);
    renderControl(makeThread(), fakes);
    await click('Talk to the builder');
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(fakes.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('after INTEGRATION_UNAVAILABLE the control is disabled and never asks again', async () => {
    const fakes = createFakes({mintError: apiError('INTEGRATION_UNAVAILABLE')});
    renderControl(makeThread(), fakes);
    await click('Talk to the builder');
    const button = await screen.findByRole('button', {name: /not available in this environment/});
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', {name: 'Talk to the builder'})).toBeNull();
  });

  it('a dropped connection explains it and releases everything', async () => {
    const fakes = createFakes();
    renderControl(makeThread(), fakes);
    await startVoice(fakes);
    act(() => fakes.pc.drop());
    expect(await screen.findByText(/The voice connection dropped/)).toBeTruthy();
    expect(fakes.tracks[0].stopped).toBe(true);
  });
});

describe('Typed chat with voice on the page', () => {
  async function typeAndSend(text: string) {
    const input = await screen.findByRole('textbox');
    await act(async () => {
      input.textContent = text;
      fireEvent.input(input);
    });
    const sendButton = await screen.findByRole('button', {name: /^send/i});
    await waitFor(() => expect(sendButton.getAttribute('aria-disabled')).not.toBe('true'));
    await act(async () => {
      fireEvent.click(sendButton);
    });
  }

  it('still sends typed turns after the microphone is denied (real browser deps, stubbed globals)', async () => {
    const getUserMedia = vi.fn(() => Promise.reject(Object.assign(new Error('denied'), {name: 'NotAllowedError'})));
    vi.stubGlobal('RTCPeerConnection', class {});
    Object.defineProperty(navigator, 'mediaDevices', {value: {getUserMedia}, configurable: true});
    const send = vi.fn(async () => true);
    render(
      <Wrap thread={makeThread({}, send)}>
        <BuilderChat timeZone="America/Los_Angeles" />
      </Wrap>,
    );
    await click('Talk to the builder');
    expect(getUserMedia).toHaveBeenCalledWith({audio: true});
    expect(await screen.findByText(/The microphone is blocked/)).toBeTruthy();

    await typeAndSend('We close at ten on Fridays.');
    expect(send).toHaveBeenCalledWith('We close at ten on Fridays.', 'text');
    Object.defineProperty(navigator, 'mediaDevices', {value: undefined, configurable: true});
  });

  it('a browser without WebRTC shows voice as unsupported and typed chat works', async () => {
    const send = vi.fn(async () => true);
    render(
      <Wrap thread={makeThread({}, send)}>
        <BuilderChat timeZone="America/Los_Angeles" />
      </Wrap>,
    );
    expect(await screen.findByText('Voice is not supported in this browser.')).toBeTruthy();
    await typeAndSend('Pickup only.');
    expect(send).toHaveBeenCalledWith('Pickup only.', 'text');
  });
});
