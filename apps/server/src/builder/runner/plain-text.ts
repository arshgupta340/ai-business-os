// Agent and builder replies are spoken on a phone call and shown as plain
// text. The model is told to write plain sentences; this is the server's
// safety net for when it does not. It removes Markdown emphasis, inline code
// marks, headings, quotes, links and list markers, and joins lines into one
// paragraph. It does not touch underscores inside words, so IDs such as
// `apv_mock_0001` and snake_case keys survive.

const LIST_MARKER = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
const HEADING = /^\s*#{1,6}\s+/;
const QUOTE = /^\s*>+\s?/;
const END_PUNCTUATION = /[.!?:;,]$/;

function stripInline(line: string): string {
  return (
    line
      // [text](url) and ![alt](url) keep only the text.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // **bold**, __bold__, then *italic* and _italic_ at word edges only.
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(^|[^\w])__(.+?)__(?=[^\w]|$)/g, '$1$2')
      .replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?=[^\w*]|$)/g, '$1$2')
      .replace(/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?=[^\w]|$)/g, '$1$2')
      // ~~strike~~ and `code`.
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`+([^`]*)`+/g, '$1')
      // Any emphasis pair left unmatched.
      .replace(/\*\*|__/g, '')
  );
}

export function toPlainSpokenText(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw;
    const isItem = LIST_MARKER.test(line);
    line = line.replace(HEADING, '').replace(QUOTE, '').replace(LIST_MARKER, '');
    line = stripInline(line).replace(/\s+/g, ' ').trim();
    if (line === '' || /^[-*_=]{3,}$/.test(line)) continue;
    // A list item becomes its own sentence, so the items do not run together.
    if (isItem && !END_PUNCTUATION.test(line)) line = `${line}.`;
    out.push(line);
  }
  return out.join(' ');
}
