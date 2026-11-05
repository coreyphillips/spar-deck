import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReport } from '../src/outcome.mjs';

const RULE = '='.repeat(60);
// Spar's `print_outcome`: number and status padded, notes indented by seven spaces.
const item = (number, status, ...notes) => [`#${String(number).padEnd(5)} ${status.padEnd(10)} rounds=4 https://github.com/OWNER/REPO/pull/${number}`, ...notes.map(note => `       ${note}`)];
const block = (...items) => ['', RULE, ...items.flat(), RULE].join('\n');
const spent = '\nspent: 12 agent call(s), 2h02m of model time\n  claude: 6 call(s), 70m11s\n  codex: 6 call(s), 52m35s, 1 failed\n';
const report = (items, after = '\nwrites: 7 attempted, 7 succeeded, 0 failed\n') => `[deck] spar run\n\nworking #1942\n${block(...items)}\n${spent}${after}`;
const escalated = item(1942, 'escalated', 'one point left after the closing pass', '10 call(s), 2h00m');
const heldBack = number => item(number, 'pending', 'held back: #102 is in this run and has not merged, so its work is not on the base this would be built from. Merge #102 and run #103 again.');

test('a report whose only failures are escalations is escalated', () => {
  const cases = {
    'only escalated': report([escalated]),
    'escalated and merged': report([item(101, 'merged'), escalated]),
    'held-back dependents': report([item(101, 'merged'), item(102, 'escalated', 'reviewers disagree'), heldBack(103), heldBack(104)]),
    'every success status': report([escalated, ...['merged', 'approved', 'abandoned', 'reviewed', 'clean', 'answered', 'split', 'whole'].map((status, i) => item(i + 1, status))]),
    'no writes line': report([escalated], ''),
    'parked items': report([escalated], '\n#12 contested and parked for you: claude wants to fix it, codex does not\n#13 skipped by both reviewers, commented on and left open: duplicate\n'),
    'CRLF line endings': report([escalated]).replaceAll('\n', '\r\n'),
    'earlier failed report': `${report([item(7, 'error')], '\ntriage failed for #8, so it was not worked: quota\n')}\nlater\n${report([escalated])}`,
    'five-digit number': report([item(12345, 'escalated')]),
  };
  for (const [name, log] of Object.entries(cases)) assert.equal(classifyReport(log), 'escalated', name);
});

test('anything else in the report stays failed', () => {
  const cases = {
    'escalated and error': report([escalated, item(7, 'error', 'implementation failed')]),
    'a failed write': report([escalated], '\nwrites: 6 attempted, 5 succeeded, 1 failed\n'),
    'triage failed': report([escalated], '\ntriage failed for #12, so it was not worked: quota exceeded\n#13 was not reached after that failure\n'),
    'unread wave': report([escalated], '\ncould not read #12, so it was not worked: timeout\n'),
    'queue stopped': report([escalated], '\nthe issue queue stopped: lost the remote\n'),
    'unreached wave': report([escalated], '\n#13, #14 was not reached after that failure\n'),
    'pending not held back': report([escalated, item(103, 'pending', 'nothing to do')]),
    'pending without notes': report([escalated, item(103, 'pending')]),
    'held back but not first note': report([escalated, item(103, 'pending', 'other note', 'held back: #102')]),
    'moved review': report([escalated, item(9, 'moved')]),
    'unknown status': report([escalated, item(9, 'exploded')]),
    'no escalation': report([item(103, 'pending', 'held back: #102 is in this run and has not merged')]),
    'only successes': report([item(101, 'merged')]),
    'no report': '[deck] spar run\n\nError: could not reach GitHub\n',
    'empty log': '',
    'single rule': `${RULE}\n${escalated.join('\n')}\n`,
    'rule on first line': `${RULE}\n`,
    'empty block': `${RULE}\n${RULE}\n`,
    'unexpected line in block': report([escalated, ['warning: something else']]),
    'indented line before any outcome': report([['       stray note'], escalated]),
    'last of two reports has an error': `${report([escalated])}\n${report([escalated, item(7, 'error')])}`,
  };
  for (const [name, log] of Object.entries(cases)) assert.equal(classifyReport(log), 'failed', name);
});
