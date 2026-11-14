// The interruption gate (NOTES.md "Interruptions and background noise"). Pure: no I/O and no timers.
// The relay feeds it OpenAI's VAD events and the playback state, owns the one timer, and does what it
// returns. The session runs with `create_response: false` and `interrupt_response: false`, so nothing
// the caller's line picks up stops the agent or makes it answer until this gate says the turn is real.
//
// Per caller turn (one VAD item):
//   speech_started, agent silent      -> turn       (answered when committed)
//   speech_started, agent speaking    -> candidate  (the relay arms a timer for minMs)
//   candidate, timer fires first      -> confirmed  (barge-in: stop the agent; answered when committed)
//   candidate, speech_stopped first   -> short      (the agent keeps talking)
//   short, committed, agent silent    -> answered   (a quick "yes" just after the agent finished)
//   short, committed, agent speaking  -> held       (decided once the agent's audio has played)
//   held, agent finished within grace -> answered; otherwise the item is deleted from the conversation
//   held, a new response starts, a barge-in is confirmed, or another sound is held -> deleted

export type GateConfig = {
  /** Caller speech that lasts this long while the agent talks is an interruption. */
  bargeInMinMs: number;
  /** The same during the greeting. */
  greetingBargeInMinMs: number;
  /** A held short sound that ended at most this long before the agent finished is answered. */
  shortReplyGraceMs: number;
};

export type SpeechStart = { kind: 'turn' } | { kind: 'candidate'; confirmInMs: number };
export type Confirmation = { confirmed: boolean; drop?: string };
export type CommitDecision = { kind: 'reply' | 'hold' | 'ignore'; drop?: string };
export type DrainDecision = { reply?: string; drop?: string };

/** An item id the provider did not send. Turns still work; nothing is deleted for it. */
const NO_ID = '';

export class InterruptionGate {
  private candidate: { itemId: string; startedAt: number } | undefined;
  /** Items whose speech ended before they were confirmed, with when the speech ended. */
  private readonly shortItems = new Map<string, number>();
  private held: { itemId: string; endedAt: number } | undefined;

  constructor(private readonly cfg: GateConfig) {}

  /** `agentSpeaking`: the caller can hear the agent, or a response is being generated. */
  speechStarted(now: number, itemId: string | undefined, agentSpeaking: boolean, greeting: boolean): SpeechStart {
    const id = itemId ?? NO_ID;
    this.shortItems.delete(id);
    if (!agentSpeaking) {
      this.candidate = undefined;
      return { kind: 'turn' };
    }
    this.candidate = { itemId: id, startedAt: now };
    return { kind: 'candidate', confirmInMs: Math.max(0, greeting ? this.cfg.greetingBargeInMinMs : this.cfg.bargeInMinMs) };
  }

  /** The timer armed for a candidate fired. Confirmed only if that same speech is still going. */
  confirm(itemId: string | undefined): Confirmation {
    const id = itemId ?? NO_ID;
    if (this.candidate === undefined || this.candidate.itemId !== id) return { confirmed: false };
    this.candidate = undefined;
    const drop = this.takeHeld();
    return drop === undefined ? { confirmed: true } : { confirmed: true, drop };
  }

  /** Returns `short` when the speech ended before it was confirmed as an interruption. */
  speechStopped(now: number, itemId: string | undefined): 'short' | 'turn' {
    const id = itemId ?? NO_ID;
    if (this.candidate !== undefined && this.candidate.itemId === id) {
      this.candidate = undefined;
      this.shortItems.set(id, now);
      return 'short';
    }
    return 'turn';
  }

  /** The provider committed a caller item. */
  committed(itemId: string | undefined, agentSpeaking: boolean): CommitDecision {
    const id = itemId ?? NO_ID;
    const endedAt = this.shortItems.get(id);
    if (endedAt === undefined) return { kind: 'reply' };
    this.shortItems.delete(id);
    if (!agentSpeaking) return { kind: 'reply' };
    // A sound with no id cannot be deleted later; it is never answered while the agent speaks.
    if (id === NO_ID) return { kind: 'ignore' };
    const drop = this.takeHeld();
    this.held = { itemId: id, endedAt };
    return drop === undefined ? { kind: 'hold' } : { kind: 'hold', drop };
  }

  /** The agent's audio has all played and no response is being generated. */
  drained(now: number): DrainDecision {
    const held = this.held;
    if (held === undefined) return {};
    this.held = undefined;
    return now - held.endedAt <= this.cfg.shortReplyGraceMs ? { reply: held.itemId } : { drop: held.itemId };
  }

  /** A response started before the held sound was decided: the sound is left out of the conversation. */
  responseStarted(): string | undefined {
    return this.takeHeld();
  }

  get pendingCandidate(): boolean {
    return this.candidate !== undefined;
  }

  get heldItem(): string | undefined {
    return this.held?.itemId;
  }

  private takeHeld(): string | undefined {
    const id = this.held?.itemId;
    this.held = undefined;
    return id;
  }
}
