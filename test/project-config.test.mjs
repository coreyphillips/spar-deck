import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDeck } from '../src/server.mjs';
import { readConfig, MAX_CONFIG_BYTES } from '../src/project-config.mjs';

test('project config API preserves files, validates syntax, and rejects stale or unsafe saves', async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-')));
  const root = path.join(temp, 'projects'); fs.mkdirSync(root);
  const alpha = path.join(root, 'alpha'), beta = path.join(root, 'beta');
  for (const project of [alpha, beta]) { fs.mkdirSync(project); execFileSync('git', ['init', '-q', project]); }
  const fake = path.join(temp, 'spar'); fs.writeFileSync(fake, `#!${process.execPath}\nconsole.log('spar test');\n`, { mode: 0o700 });
  const deck = await createDeck({ root, dataDir: path.join(temp, 'data'), binary: fake });
  t.after(async () => { deck.server.closeAllConnections(); await new Promise(resolve => deck.server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); });
  await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${deck.server.address().port}`;
  const { token } = await fetch(`${base}/api/state`).then(r => r.json());
  async function request(url, method = 'GET', body, headers = {}) {
    const response = await fetch(base + url, { method, headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const a = (await request('/api/projects', 'POST', { path: alpha })).data;
  const b = (await request('/api/projects', 'POST', { path: beta })).data;
  const url = `/api/projects/${a.id}/config`, file = path.join(alpha, 'spar.toml');
  assert.equal((await request('/api/projects/missing/config')).status, 404);
  let loaded = (await request(url)).data;
  assert.equal(loaded.exists, false); assert.equal(loaded.revision, null);
  const content = '# Keep comments and spacing\r\n[loop]\r\nmax_rounds = 4\r\nname = "café 日本語"\r\n';
  assert.equal((await request(url, 'PUT', { content, revision: null }, { 'X-Deck-Token': '' })).status, 403);
  assert.equal((await request(url, 'PUT', { content, revision: null }, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request(url, 'PUT', { content, revision: null })).status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await request(`/api/projects/${b.id}/config`)).data.exists, false);
  loaded = (await request(url)).data;
  for (const content of ['[loop', 'max_rounds = nope', 'a=[1 #', '', ' ', null, 42, 'x = 1\nx = 2']) {
    assert.equal((await request(url, 'PUT', { content, revision: loaded.revision })).status, 400);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), loaded.content);
  assert.equal((await request(url, 'PUT', { content: loaded.content })).status, 400);
  assert.equal((await request(url, 'PUT', { content, revision: null })).status, 409, 'creation must not replace an existing file');
  assert.equal((await request(url, 'PUT', { content: '#'.repeat(MAX_CONFIG_BYTES + 1), revision: loaded.revision })).status, 413);
  fs.chmodSync(file, 0o640);
  const updated = '# Another comment\n[loop]\nmax_rounds = 8\n';
  assert.equal((await request(url, 'PUT', { content: updated, revision: loaded.revision })).status, 200);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal((await request(url, 'PUT', { content, revision: loaded.revision })).status, 409);
  loaded = (await request(url)).data;
  fs.writeFileSync(file, '# External editor\nmax_rounds = 10\n');
  assert.equal((await request(url, 'PUT', { content, revision: loaded.revision })).status, 409);
  assert.match(fs.readFileSync(file, 'utf8'), /External editor/);
  fs.unlinkSync(file);
  assert.equal((await request(url, 'PUT', { content, revision: loaded.revision })).status, 409, 'deletion is a conflict');
  const outside = path.join(temp, 'outside.toml'); fs.writeFileSync(outside, 'secret = "unchanged"\n');
  fs.symlinkSync(outside, file);
  assert.equal((await request(url)).status, 400);
  assert.equal((await request(url, 'PUT', { content, revision: null })).status, 400);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'secret = "unchanged"\n');
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.equal((await request(url)).status, 400);
  fs.rmdirSync(file); fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
  assert.equal((await request(url)).status, 400);
  fs.writeFileSync(file, '#'.repeat(MAX_CONFIG_BYTES + 1));
  assert.equal((await request(url)).status, 413);
  fs.unlinkSync(file);
  // A request larger than the normal command body limit remains valid here.
  const large = '# ' + 'é'.repeat(20000) + '\nmax_rounds = 4\n';
  assert.equal((await request(url, 'PUT', { content: large, revision: null })).status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), large);
  assert.equal((await request('/api/state')).data.jobs.length, 0, 'editing must not start commands');
  assert.deepEqual(fs.readdirSync(alpha).sort(), ['.git', 'spar.toml']);
  // Retargeting a project's directory cannot redirect the editor.
  fs.renameSync(alpha, path.join(temp, 'moved')); fs.symlinkSync(path.join(temp, 'moved'), alpha);
  assert.equal((await request(url)).status, 400);
  assert.throws(() => readConfig(root, { path: path.join(temp, 'moved') }));
});
