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
