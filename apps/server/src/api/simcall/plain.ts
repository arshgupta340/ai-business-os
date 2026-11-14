// Sim-call shows the agent's line as a caller would hear it. The phone prompt (voice/prompt.ts) has its own
// plain-speech rule; this one is appended to the sim-call model instructions and its reply is cleaned.

/** Replies are spoken on a phone call (and shown as the agent's line in sim-call): plain speech only. */
export const PLAIN_SPEECH_RULE =
  'Every reply is spoken aloud on a phone call. Use plain spoken sentences only: no Markdown, no asterisks, no bold or italics, no bullet or numbered lists, no headings, no emoji. Say amounts as words a person would say, for example "twenty-three dollars and ninety-three cents", not "$23.93".';

/**
 * Removes Markdown formatting from text that will be spoken or shown as the agent's line: emphasis
 * markers, inline code ticks, headings, list markers and block quotes. The words stay as they are.
 */
export function plainSpeech(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+/gm, '')
    .replace(/\*{2,}/g, '')
    .replace(/[ \t]+\n/g, '\n');
}
