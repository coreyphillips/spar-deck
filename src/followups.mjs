import fs from 'node:fs';
import path from 'node:path';

// Ported from Spar 0.4.32 `src/followups.rs` (`parse`), so the card shows the
// number of entries `spar followup` would work.
const MARKER = '<!-- spar:followup -->';
const SECTIONS = new Set(['problem', 'reproduction', 'impact', 'expected behavior', 'expected behaviour', 'expected',
  'actual result', 'actual results', 'actual behavior', 'actual behaviour', 'steps to reproduce', 'summary']);
// Rust's char::is_whitespace. Unlike JavaScript's trim, it keeps a byte order mark.
const SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const LEADING = new RegExp(`^[${SPACE}]+`), TRAILING = new RegExp(`[${SPACE}]+$`);
const trim = text => text.replace(LEADING, '').replace(TRAILING, '');
const isSection = heading => SECTIONS.has(trim(trim(heading).replace(/:+$/, '')).toLowerCase());

export function countFollowups(text) {
  let count = 0, open = false, awaitingTitle = false, fenced = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r+$/, '').replace(LEADING, '');
    if (line.startsWith('```') || line.startsWith('~~~')) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (line.startsWith(MARKER)) { count++; open = true; awaitingTitle = true; continue; }
    if (!line.startsWith('## ')) continue;
    if (awaitingTitle) { awaitingTitle = false; continue; }
    // With nothing open, a first heading of `## Problem` is one entry called Problem.
    if (open && isSection(line.slice(3))) continue;
    count++; open = true;
  }
  return count;
}

const cache = new Map();
const statKey = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

// Runs for every project on every poll, so an unchanged file is not parsed again.
// Any failure counts as an empty queue: the card must stay usable.
export function readFollowupCount(directory) {
  const file = path.join(directory, '.spar', 'followups.md');
  let descriptor;
  try {
    // Refuse symlinks and special files, including FIFOs that would block a read.
    const entry = fs.lstatSync(file, { bigint: true });
    if (!entry.isFile()) return forget(file);
    if (cache.get(file)?.key === statKey(entry)) return cache.get(file).count;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) return forget(file);
    // Spar reads the file as UTF-8 and treats a file it cannot decode as no follow-ups.
    const count = countFollowups(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(descriptor)));
    cache.set(file, { key: statKey(stat), count });
    return count;
  } catch { return forget(file); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function forget(file) { cache.delete(file); return 0; }
