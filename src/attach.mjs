import { openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, sep } from 'node:path';

// What `beckon-attach` may send to a Slack thread: images, videos and PDFs, told apart by their
// first bytes rather than their name, so a renamed settings or key file is not uploaded.

export const ATTACH_MAX = 1024 ** 3; // Slack's own limit per file

export function sniffKind(head) {
  const b = Buffer.from(head);
  const ascii = (from, to) => b.subarray(from, to).toString('latin1');
  if (b.length >= 4 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
  if (ascii(0, 4) === 'GIF8') return 'image';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image';
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video'; // webm, mkv
  if (ascii(4, 8) === 'ftyp') return /^(heic|heix|mif1|msf1|avif)$/.test(ascii(8, 12)) ? 'image' : 'video'; // mp4, mov, m4v, heic
  return null;
}

// Checks a file for upload. Returns { path, name, size, kind } or { reason }.
export function checkAttachment(file) {
  let path;
  let st;
  try {
    path = realpathSync(file);
    st = statSync(path);
  } catch {
    return { reason: `${file} does not exist` };
  }
  if (!st.isFile()) return { reason: `${file} is not a file` };
  if (st.size === 0) return { reason: `${file} is empty` };
  if (st.size > ATTACH_MAX) return { reason: `${file} is ${Math.round(st.size / 1024 ** 2)} MB; Slack takes files up to 1 GB` };
  const head = Buffer.alloc(16);
  const fd = openSync(path, 'r');
  try { readSync(fd, head, 0, 16, 0); } finally { closeSync(fd); }
  const kind = sniffKind(head);
  if (!kind) return { reason: `${basename(path)} is not an image, a video or a PDF; only those can be sent to Slack` };
  return { path, name: basename(path), size: st.size, kind };
}

// Temporary folders: a file there was made for this, so it is deleted once it is in Slack.
export function inTempFolder(path) {
  const roots = new Set(['/tmp', '/private/tmp', tmpdir()]);
  for (const r of [...roots]) {
    try { roots.add(realpathSync(r)); } catch { /* not on this system */ }
  }
  return [...roots].some((r) => path.startsWith(r.endsWith(sep) ? r : r + sep));
}
