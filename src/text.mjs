// Slack's markdown block takes up to 12,000 characters per message; stay under it with room
// for a closing code fence.
export const MAX_MARKDOWN = 11000;

export function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Turn Slack's message markup into the plain text Claude should read: drop the mention of
// beckon itself, unwrap links and channel references, keep other people's mentions.
export function slackToPlain(text, botUserId) {
  let s = String(text ?? '');
  if (botUserId) s = s.split(`<@${botUserId}>`).join('');
  s = s.replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, name) => `#${name || id}`);
  s = s.replace(/<!(here|channel|everyone)>/g, '@$1');
  s = s.replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, '$1');
  s = s.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url, label) => (label === url ? url : `${label} (${url})`));
  s = s.replace(/<((?:https?|mailto):[^>]+)>/g, '$1');
  return decodeEntities(s).trim();
}

// The text of a command, with channel mentions kept as their IDs, written #:C0123 (a colon
// cannot appear in a channel name), so the channel can be stored without a lookup by name.
export function commandText(text, botUserId) {
  const s = String(text ?? '').replace(/<#([A-Z0-9]+)(?:\|[^>]*)?>/g, ' #:$1 ');
  return slackToPlain(s, botUserId);
}

// Split long markdown into Slack-sized pieces at paragraph or line breaks. A piece that ends
// inside a code fence closes it, and the next piece reopens it.
export function chunkMarkdown(text, max = MAX_MARKDOWN) {
  const out = [];
  let rest = String(text ?? '');
  let reopen = '';
  while (rest.length > 0) {
    let piece = reopen + rest;
    if (piece.length <= max) {
      out.push(piece);
      break;
    }
    let cut = piece.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = piece.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    let head = piece.slice(0, cut);
    const fences = head.match(/^```.*$/gm) ?? [];
    reopen = '';
    if (fences.length % 2 === 1) {
      const lang = fences[fences.length - 1].slice(3);
      head += '\n```';
      reopen = '```' + lang + '\n';
    }
    out.push(head.trimEnd());
    rest = piece.slice(cut).replace(/^\n+/, '');
  }
  return out;
}

export function oneLine(s, max = 80) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

export function codeSpan(s, max = 80) {
  return '`' + oneLine(s, max).replace(/`/g, "'") + '`';
}

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
