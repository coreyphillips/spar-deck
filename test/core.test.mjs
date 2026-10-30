import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArgs, resolveDirectory, atomicJSON, readJSON, tailFile } from '../src/core.mjs';

test('command arguments are validated and never interpreted by a shell', () => {
  assert.deepEqual(buildArgs('review', { targets: '#42, 108', dryRun: true, flags: { recheck: true, 'max-rounds': '3' }, limit: 10 }), ['review', '42', '108', '--dry-run', '--recheck', '--max-rounds', '3', '--limit', '10']);
  assert.deepEqual(buildArgs('brainstorm', { topic: 'ideas; touch /tmp/should-not-exist' }), ['brainstorm', 'ideas; touch /tmp/should-not-exist']);
  for (const command of ['sh', '__proto__', 'constructor']) assert.throws(() => buildArgs(command));
  assert.throws(() => buildArgs('review', { targets: '42; touch /tmp/no' }));
  assert.throws(() => buildArgs('review', { targets: '--repo /tmp' }));
  assert.throws(() => buildArgs('review', { flags: { repo: '/tmp' } }));
  assert.throws(() => buildArgs('run', { dryRun: true }));
  assert.throws(() => buildArgs('listen', { flags: { since: 'yesterday' } }));
  assert.throws(() => buildArgs('brainstorm', { topic: '--file-issues' }));
  assert.throws(() => buildArgs('followup', { flags: { 'file-only': true, 'screen-only': true } }));
});
test('canonical project paths cannot escape the configured root', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-path-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root'); fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'project')); fs.mkdirSync(path.join(temp, 'outside'));
  fs.symlinkSync(path.join(temp, 'outside'), path.join(root, 'escape'));
  assert.equal(resolveDirectory(fs.realpathSync(root), path.join(root, 'project')), fs.realpathSync(path.join(root, 'project')));
  assert.throws(() => resolveDirectory(root, path.join(root, '..', 'outside')));
  assert.throws(() => resolveDirectory(root, path.join(root, 'escape')));
});
test('state is persisted atomically and log tails are bounded', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-files-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'state.json'); atomicJSON(file, { projects: [2, 1] }); assert.deepEqual(readJSON(file), { projects: [2, 1] });
  fs.writeFileSync(file, '{broken'); assert.throws(() => readJSON(file, {}));
  const log = path.join(temp, 'output.log'); fs.writeFileSync(log, '1234567890'); assert.equal(tailFile(log, 4), '7890'); assert.equal(tailFile(`${log}.missing`), '');
});

test('code preserves a multiline project prompt after the option separator', () => {
  const prompt = '--auto-merge\nFix "quoted" exports; $(touch /tmp/should-not-exist)';
  assert.deepEqual(buildArgs('code', { prompt, dryRun: true, flags: { 'max-rounds': '5' } }), ['code', '--dry-run', '--max-rounds', '5', '--', prompt]);
  assert.deepEqual(buildArgs('code', { prompt, flags: { 'file-only': true } }), ['code', '--file-only', '--', prompt]);
  assert.deepEqual(buildArgs('code', { prompt }), ['code', '--', prompt]);
});

test('code rejects missing prompts and incompatible or unsupported options', () => {
  for (const prompt of [undefined, null, '', ' \n\t ', 42, ['Add export'], 'x'.repeat(4001), 'bad\0prompt']) {
    assert.throws(() => buildArgs('code', { prompt }), /Describe what to build/);
  }
  const prompt = 'Add CSV export';
  assert.throws(() => buildArgs('code', { prompt, dryRun: true, flags: { 'file-only': true } }), /either dry run or file only/);
  assert.throws(() => buildArgs('code', { prompt, targets: '42' }));
  assert.throws(() => buildArgs('code', { prompt, limit: 5 }));
  assert.throws(() => buildArgs('code', { prompt, flags: { repo: '/tmp' } }));
  assert.throws(() => buildArgs('review', { prompt }));
  assert.equal(buildArgs('code', { prompt: 'x'.repeat(4000) }).at(-1).length, 4000);
});

test('initialize allows update without exposing destructive flags or output paths', () => {
  assert.deepEqual(buildArgs('init', { flags: { update: true } }), ['init', '--update']);
  assert.deepEqual(buildArgs('init'), ['init']);
  assert.throws(() => buildArgs('init', { flags: { force: true } }));
  assert.throws(() => buildArgs('init', { flags: { update: 'true' } }));
  assert.throws(() => buildArgs('init', { flags: { out: '/tmp/config' } }));
  assert.throws(() => buildArgs('init', { limit: 1 }));
});

test('run accepts a lowest issue number alongside its other options', () => {
  assert.deepEqual(buildArgs('run', { flags: { 'min-number': '120' } }), ['run', '--min-number', '120']);
  assert.deepEqual(buildArgs('run', { flags: { 'min-number': '' } }), ['run']);
  assert.deepEqual(buildArgs('run', { targets: '42, 108', flags: { 'max-rounds': '3', 'min-number': '120' }, limit: '5' }), ['run', '42', '108', '--max-rounds', '3', '--min-number', '120', '--limit', '5']);
  for (const value of ['0', '-5', '1.5', 'abc', '1234567', 0, -5]) assert.throws(() => buildArgs('run', { flags: { 'min-number': value } }), /Invalid min-number/);
  assert.throws(() => buildArgs('doctor', { flags: { 'min-number': '120' } }), /Unsupported option: min-number/);
});

test('resume chooses the next reviewer and accepts the shared agent options', () => {
  assert.deepEqual(buildArgs('resume', { targets: '1923', flags: { next: 'codex' } }), ['resume', '1923', '--next', 'codex']);
  const instructions = 'Keep the "public" API; $(touch /tmp/should-not-exist)\n-- stay small';
  assert.deepEqual(buildArgs('resume', { targets: '#1923', flags: { next: 'claude_2', first: 'codex', base: 'release/1.x', instructions, 'min-number': '100', absorb: '2', 'keep-worktrees': true }, limit: '3' }),
    ['resume', '1923', '--next', 'claude_2', '--first', 'codex', '--base', 'release/1.x', '--instructions', instructions, '--min-number', '100', '--absorb', '2', '--keep-worktrees', '--limit', '3']);
  assert.deepEqual(buildArgs('resume', { flags: { next: '', first: null, base: false, instructions: '' } }), ['resume']);
  assert.equal(buildArgs('listen', { flags: { instructions: 'x'.repeat(4000) } }).at(-1).length, 4000);
  for (const command of ['run', 'code', 'followup', 'triage', 'resume', 'checkin', 'review', 'brainstorm', 'split', 'listen']) {
    const input = { flags: { first: 'claude', base: 'main', instructions: 'Be brief.' }, ...(command === 'code' ? { prompt: 'Add export' } : {}) };
    assert.deepEqual(buildArgs(command, input).slice(1, 7), ['--first', 'claude', '--base', 'main', '--instructions', 'Be brief.']);
  }
  for (const command of ['doctor', 'init', 'clean']) for (const flag of ['first', 'base', 'instructions']) assert.throws(() => buildArgs(command, { flags: { [flag]: 'main' } }), new RegExp(`Unsupported option: ${flag}`));
  for (const command of ['run', 'review', 'listen']) assert.throws(() => buildArgs(command, { flags: { next: 'codex' } }), /Unsupported option: next/);
});

test('agent keys, branches, instructions, and numbers are validated', () => {
  for (const next of ['--repo', '-x', 'a b', 'codex\n', ' codex', 'a.b', 'a/b', 'x'.repeat(65), 'bad\0key', true, 42, ['codex']]) {
    assert.throws(() => buildArgs('resume', { flags: { next } }), /Invalid next/);
    assert.throws(() => buildArgs('run', { flags: { first: next } }), /Invalid first/);
  }
  assert.deepEqual(buildArgs('run', { flags: { first: 'x'.repeat(64) } }), ['run', '--first', 'x'.repeat(64)]);
  for (const base of ['-x', '--repo', 'a..b', 'a b', 'main\t', 'main\n', 'ma\0in', 'a~b', 'a:b', 'x'.repeat(256), true, 7]) assert.throws(() => buildArgs('review', { flags: { base } }), /Invalid base/);
  assert.equal(buildArgs('review', { flags: { base: 'x'.repeat(255) } }).at(-1).length, 255);
  for (const instructions of ['-x', '--repo /tmp', 'bad\0text', 'x'.repeat(4001), true, ['Be brief.']]) assert.throws(() => buildArgs('triage', { flags: { instructions } }), /Invalid instructions/);
  for (const flag of ['absorb', 'min-number', 'max-rounds']) for (const value of ['0', '-5', '1.5', 'abc', '1234567', 0, true]) assert.throws(() => buildArgs('resume', { flags: { [flag]: value } }), new RegExp(`Invalid ${flag}`));
});

test('new boolean options are offered only for their commands', () => {
  const allowed = {
    'keep-worktrees': ['resume', 'run', 'code', 'followup', 'checkin'],
    retriage: ['run', 'code', 'followup'],
    'close-skipped': ['run', 'code', 'followup'],
    'no-close-skipped': ['run', 'code', 'followup'],
    'any-author': ['checkin'],
    again: ['checkin', 'split'],
    'file-issues': ['brainstorm'],
  };
  const commands = ['listen', 'review', 'checkin', 'run', 'code', 'triage', 'resume', 'brainstorm', 'followup', 'split', 'doctor', 'init', 'clean'];
  for (const [flag, list] of Object.entries(allowed)) for (const command of commands) {
    const input = { flags: { [flag]: true }, ...(command === 'code' ? { prompt: 'Add export' } : {}) };
    if (list.includes(command)) assert.equal(buildArgs(command, input)[1], `--${flag}`, `${command} --${flag}`);
    else assert.throws(() => buildArgs(command, input), new RegExp(`Unsupported option: ${flag}`), `${command} --${flag}`);
    if (list.includes(command)) assert.throws(() => buildArgs(command, { ...input, flags: { [flag]: 'yes' } }), new RegExp(`Unsupported option: ${flag}`));
  }
  const valueAllowed = { 'min-number': ['listen', 'review', 'checkin', 'run', 'triage', 'resume', 'split'], absorb: ['run', 'code', 'resume', 'followup'], 'max-rounds': ['review', 'run', 'code', 'resume', 'brainstorm', 'followup'] };
  for (const [flag, list] of Object.entries(valueAllowed)) for (const command of commands) {
    const input = { flags: { [flag]: '2' }, ...(command === 'code' ? { prompt: 'Add export' } : {}) };
    if (list.includes(command)) assert.deepEqual(buildArgs(command, input).slice(1, 3), [`--${flag}`, '2']);
    else assert.throws(() => buildArgs(command, input), new RegExp(`Unsupported option: ${flag}`), `${command} --${flag}`);
  }
});

test('close skipped choices are exclusive and excluded flags stay unavailable', () => {
  for (const command of ['run', 'followup']) {
    assert.throws(() => buildArgs(command, { flags: { 'close-skipped': true, 'no-close-skipped': true } }), /either close skipped/);
    assert.deepEqual(buildArgs(command, { flags: { 'close-skipped': true, 'no-close-skipped': false } }), [command, '--close-skipped']);
  }
  assert.throws(() => buildArgs('code', { prompt: 'Add export', flags: { 'close-skipped': true, 'no-close-skipped': true } }), /either close skipped/);
  const excluded = { repo: '/tmp', config: '/tmp/spar.toml', out: '/tmp/out', 'plan-out': '/tmp/plan.json', file: '/tmp/queue', from: '/tmp/session', force: true, quiet: true, 'auto-merge': true, 'no-worktrees': true, all: true, 'pr-state': true };
  for (const command of ['listen', 'review', 'checkin', 'run', 'code', 'triage', 'resume', 'brainstorm', 'followup', 'split', 'doctor', 'init', 'clean']) {
    for (const [flag, value] of Object.entries(excluded)) assert.throws(() => buildArgs(command, { prompt: command === 'code' ? 'Add export' : undefined, flags: { [flag]: value } }), new RegExp(`Unsupported option: ${flag}`), `${command} --${flag}`);
  }
});
