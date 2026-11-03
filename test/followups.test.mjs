import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDeck } from '../src/server.mjs';
import { countFollowups } from '../src/followups.mjs';

// The shape Spar appends: a marker, a title, then the four report sections.
const entry = title => `<!-- spar:followup -->\n## ${title}\n\nFound while working on #12.\n\n## Problem\n\nRows vanish.\n\n## Reproduction\n\nExport a quoted row.\n\n## Impact\n\nData loss.\n\n## Expected behavior\n\nEvery row is exported.\n\n`;
const handWritten = '# Notes\n\n## Export drops quoted rows\n\nSome text.\n\n## Problem\n\n## Steps to reproduce:\n\n## SUMMARY\n\n## Reproduction steps are missing\n\n## Actual Behaviour :\n\n### Deeper heading\n\n##Not a heading\n\n  ## Indented title\n';

test('counts follow-up entries the way spar followup does', () => {
  const cases = [
    ['', 0],
    [' \n\t\n  \n', 0],
    ['Just a preamble with no headings.\n', 0],
    [entry('Export drops quoted rows'), 1],
    [entry('Export drops quoted rows') + entry('Import ignores BOM'), 2],
    // After a marker, the next heading is the title even when it names a section.
    ['<!-- spar:followup -->\n## Impact\n\nThe first one.\n\n<!-- spar:followup -->\n## Problem\n\nThe second one.\n', 2],
    ['<!-- spar:followup -->\nA finding with no title.\n', 1],
    // Titles count; report sections under an open entry do not, matched whole and case-insensitively.
    [handWritten, 3],
    ['## Only entry\n\n```md\n## Not an entry\n```\n\n  ~~~\n## Nor this\n~~~\n\n## Problem\n', 1],
    ['## Problem\n\nThe first heading opens an entry.\n\n## Impact\n\nStill the same entry.\n', 1],
    // Spar keeps a byte order mark, so the heading after it is not recognised.
    ['﻿## Title\n', 0],
  ];
  for (const [text, expected] of cases) {
    assert.equal(countFollowups(text), expected, JSON.stringify(text));
    assert.equal(countFollowups(text.replaceAll('\n', '\r\n')), expected, `CRLF ${JSON.stringify(text)}`);
  }
});

test('project state reports the pending follow-up count without blocking on unsafe files', { timeout: 15000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-followups-')));
  const root = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'spar.toml'), '');
  const fake = path.join(temp, 'fake-spar');
  fs.writeFileSync(fake, `#!${process.execPath}\nconsole.log('spar test');\n`, { mode: 0o700 });
  const deck = await createDeck({ root, dataDir, binary: fake });
  t.after(async () => {
    deck.server.closeAllConnections(); await new Promise(resolve => deck.server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${deck.server.address().port}`;
  const token = (await fetch(`${base}/api/state`).then(r => r.json())).token;
  await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: root }) });
  const project = async () => {
    const [card] = (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(3000) }).then(r => r.json())).projects;
    assert.equal(card.available, true);
    return card.followups;
  };
  assert.equal(await project(), 0, 'no .spar directory');
  const folder = path.join(root, '.spar'), file = path.join(folder, 'followups.md');
  fs.mkdirSync(folder);
  fs.writeFileSync(file, '');
  assert.equal(await project(), 0, 'empty file');
  fs.writeFileSync(file, entry('First') + entry('Second'));
  assert.equal(await project(), 2);
  fs.writeFileSync(path.join(folder, 'followups.done.md'), entry('Done') + entry('Also done') + entry('Done too'));
  assert.equal(await project(), 2, 'worked entries are ignored');
  fs.appendFileSync(file, entry('Third'));
  assert.equal(await project(), 3, 'a changed file is counted again');
  fs.writeFileSync(file, entry('Remaining'));
  assert.equal(await project(), 1, 'a drained file is counted again');
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x0a]));
  assert.equal(await project(), 0, 'Spar cannot read invalid UTF-8');
  const outside = path.join(temp, 'outside.md'); fs.writeFileSync(outside, entry('Elsewhere'));
  fs.rmSync(file); fs.symlinkSync(outside, file);
  assert.equal(await project(), 0, 'symlink');
  fs.rmSync(file); fs.mkdirSync(file);
  assert.equal(await project(), 0, 'directory');
  fs.rmSync(file, { recursive: true }); execFileSync('mkfifo', [file]);
  const started = Date.now();
  assert.equal(await project(), 0, 'FIFO');
  assert.ok(Date.now() - started < 2000, 'a FIFO must not block the state request');
});
