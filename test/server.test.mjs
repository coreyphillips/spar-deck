import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDeck } from '../src/server.mjs';
import { atomicJSON } from '../src/core.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 80; i++) { const result = await fn(); if (result) return result; await delay(100); } throw new Error('Timed out waiting for worker.'); }

test('project lifecycle, ordering, background reconnection, stop, security and failure reporting', { timeout: 30000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-integration-')));
  const root = path.join(temp, 'Documents'), dataDir = path.join(temp, 'data'); fs.mkdirSync(root);
  const fake = path.join(temp, 'fake-spar');
  fs.writeFileSync(fake, `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('spar test');process.exit(0)}\nconsole.log('started '+process.argv.slice(2).join(' '));\nif(process.argv[2]==='doctor'){console.error('prerequisite missing');process.exit(7)}\nif(process.argv[2]==='review'){console.log('review finished');process.exit(0)}\nif(process.argv[2]==='listen'){const orphan=require('node:child_process').spawn(process.execPath,['-e',\"const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'.'),50)\",require('node:path').join(process.cwd(),'child-heartbeat')],{detached:true,stdio:'ignore'});orphan.unref();}\nconst timer=setInterval(()=>console.log('still listening'),100);process.on('SIGINT',()=>{console.log('clean shutdown');clearInterval(timer);process.exit(0)});\n`, { mode: 0o700 });
  const options = { root, dataDir, binary: fake };
  let deck, base, token, startedId;
  const launch = async () => { deck = await createDeck(options); await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${deck.server.address().port}`; token = (await fetch(`${base}/api/state`).then(r => r.json())).token; };
  const request = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const snapshot = async () => (await request('/api/state')).data;
  const jobState = async jobId => (await snapshot()).jobs.find(j => j.id === jobId);
  const close = () => new Promise(resolve => { deck.server.closeAllConnections(); deck.server.close(resolve); });
  t.after(async () => {
    if (deck?.server.listening && startedId) await request(`/api/jobs/${startedId}/stop`, 'POST', {}).catch(() => {});
    if (deck?.server.listening) await close();
    await delay(200); fs.rmSync(temp, { recursive: true, force: true });
  });
  for (const name of ['alpha', 'beta']) { fs.mkdirSync(path.join(root, name)); execFileSync('git', ['init', '-q', path.join(root, name)]); fs.writeFileSync(path.join(root, name, 'spar.toml'), ''); }
  await launch();
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await request('/api/state', 'GET', undefined, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/state', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const badHost = await new Promise(resolve => { http.get(base + '/api/state', { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); }); });
  assert.equal(badHost, 403);
  assert.equal((await request('/api/projects', 'POST', { path: root }, { 'X-Deck-Token': '' })).status, 403);
  assert.equal((await request('/api/browse?path=' + encodeURIComponent(temp))).status, 400);
  const a = (await request('/api/projects', 'POST', { path: path.join(root, 'alpha') })).data;
  const b = (await request('/api/projects', 'POST', { path: path.join(root, 'beta') })).data;
  assert.equal((await request('/api/projects', 'POST', { path: a.path })).status, 400);
  assert.equal((await request('/api/order', 'PUT', { ids: [a.id, a.id] })).status, 400);
  assert.equal((await request('/api/order', 'PUT', { ids: [b.id, a.id] })).status, 200);
  const job = (await request('/api/jobs', 'POST', { projectId: a.id, command: 'listen' })).data; startedId = job.id;
  await until(async () => (await jobState(job.id)).status === 'running');
  const config = (await request(`/api/projects/${a.id}/config`)).data;
  assert.equal(config.content, '', 'active commands still allow reading config');
  assert.equal((await request(`/api/projects/${a.id}/config`, 'PUT', { content: 'value = 1', revision: config.revision })).status, 409);
  assert.equal(fs.readFileSync(path.join(a.path, 'spar.toml'), 'utf8'), '');
  const otherConfig = (await request(`/api/projects/${b.id}/config`)).data;
  assert.equal((await request(`/api/projects/${b.id}/config`, 'PUT', { content: 'value = 2', revision: otherConfig.revision })).status, 200, 'other projects remain editable');
  assert.equal((await request('/api/jobs', 'POST', { projectId: a.id, command: 'review' })).status, 409);
  assert.equal((await request(`/api/projects/${a.id}`, 'DELETE')).status, 409);
  // The worker survives closure of every HTTP connection and the server itself.
  await close(); await delay(300); await launch();
  assert.deepEqual((await snapshot()).projects.map(p => p.id), [b.id, a.id]);
  assert.equal((await jobState(job.id)).status, 'running');
  const output = (await request(`/api/jobs/${job.id}/log`)).data.output; assert.match(output, /still listening/);
  assert.equal((await request(`/api/jobs/${job.id}/stop`, 'POST', {})).status, 200);
  await until(async () => (await jobState(job.id)).status === 'stopped'); startedId = null;
  assert.match((await request(`/api/jobs/${job.id}/log`)).data.output, /clean shutdown/);
  const heartbeat = path.join(root, 'alpha', 'child-heartbeat');
  const heartbeatSize = fs.statSync(heartbeat).size;
  await delay(250); assert.equal(fs.statSync(heartbeat).size, heartbeatSize, 'detached descendant must stop writing after Stop');
  const failure = (await request('/api/jobs', 'POST', { projectId: a.id, command: 'doctor' })).data;
  await until(async () => (await jobState(failure.id)).status === 'failed'); assert.equal((await jobState(failure.id)).exitCode, 7);
  const success = (await request('/api/jobs', 'POST', { projectId: b.id, command: 'review', targets: '42' })).data;
  await until(async () => (await jobState(success.id)).status === 'completed');
  atomicJSON(path.join(dataDir, 'jobs', success.id, 'status.json'), { status: 'running', heartbeat: Date.now() - 20000 });
  assert.equal((await jobState(success.id)).status, 'interrupted');
  assert.equal((await request(`/api/projects/${b.id}`, 'DELETE')).status, 200);
  assert(fs.existsSync(path.join(root, 'beta', '.git')));
  assert.equal((await snapshot()).jobs.length, 3);
  assert.equal((await request('/api/jobs', 'POST', { projectId: a.id, command: 'sh' })).status, 400);
});

test('code validates requests and preserves prompts through the run supervisor', { timeout: 15000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-code-')));
  const root = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'spar.toml'), '');
  const fake = path.join(temp, 'fake-spar');
  fs.writeFileSync(fake, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const deck = await createDeck({ root, dataDir, binary: fake });
  t.after(async () => {
    deck.server.closeAllConnections(); await new Promise(resolve => deck.server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${deck.server.address().port}`;
  const snapshot = () => fetch(`${base}/api/state`).then(r => r.json());
  const state = await snapshot(), token = state.token;
  assert.equal(state.commands.code.prompt, true);
  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, { method: 'POST', headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const { data: project } = await post('/api/projects', { path: root });
  for (const input of [{}, { prompt: ' ' }, { prompt: 'Add export', dryRun: true, flags: { 'file-only': true } }]) {
    assert.equal((await post('/api/jobs', { projectId: project.id, command: 'code', ...input })).status, 400);
  }
  assert.equal((await snapshot()).jobs.length, 0);
  const prompt = '--auto-merge\nExport "quoted" rows; $(touch marker)';
  for (const options of [{}, { dryRun: true }, { flags: { 'file-only': true } }]) {
    const { status, data: job } = await post('/api/jobs', { projectId: project.id, command: 'code', prompt, ...options });
    assert.equal(status, 201);
    await until(async () => (await snapshot()).jobs.find(j => j.id === job.id)?.status === 'completed');
    const expected = ['code', ...(options.dryRun ? ['--dry-run'] : options.flags ? ['--file-only'] : []), '--', prompt];
    assert.deepEqual(job.args, expected);
    const folder = path.join(dataDir, 'jobs', job.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'request.json'), 'utf8')).args, expected);
    const output = fs.readFileSync(path.join(folder, 'output.log'), 'utf8');
    const argumentLine = output.split('\n').find(line => line.startsWith('["code"'));
    assert.deepEqual(JSON.parse(argumentLine), expected);
    assert.equal(fs.existsSync(path.join(root, 'marker')), false);
  }
});

test('run passes a lowest issue number to Spar and rejects invalid values', { timeout: 15000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-run-min-')));
  const root = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'spar.toml'), '');
  const fake = path.join(temp, 'fake-spar');
  fs.writeFileSync(fake, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const deck = await createDeck({ root, dataDir, binary: fake });
  t.after(async () => {
    deck.server.closeAllConnections(); await new Promise(resolve => deck.server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${deck.server.address().port}`;
  const snapshot = () => fetch(`${base}/api/state`).then(r => r.json());
  const token = (await snapshot()).token;
  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, { method: 'POST', headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const { data: project } = await post('/api/projects', { path: root });
  for (const value of ['0', '-5', '1.5', 'abc', '1234567']) {
    assert.equal((await post('/api/jobs', { projectId: project.id, command: 'run', flags: { 'min-number': value } })).status, 400);
  }
  assert.equal((await post('/api/jobs', { projectId: project.id, command: 'doctor', flags: { 'min-number': '120' } })).status, 400);
  assert.equal((await snapshot()).jobs.length, 0);
  const cases = [
    [{ flags: { 'min-number': '120' } }, ['run', '--min-number', '120']],
    [{ flags: { 'min-number': '' } }, ['run']],
    [{ targets: '42', flags: { 'max-rounds': '3', 'min-number': '120' }, limit: '5' }, ['run', '42', '--max-rounds', '3', '--min-number', '120', '--limit', '5']],
  ];
  for (const [options, expected] of cases) {
    const { status, data: job } = await post('/api/jobs', { projectId: project.id, command: 'run', ...options });
    assert.equal(status, 201);
    await until(async () => (await snapshot()).jobs.find(j => j.id === job.id)?.status === 'completed');
    assert.deepEqual(job.args, expected);
    const folder = path.join(dataDir, 'jobs', job.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'request.json'), 'utf8')).args, expected);
    const output = fs.readFileSync(path.join(folder, 'output.log'), 'utf8');
    assert.deepEqual(JSON.parse(output.split('\n').find(line => line.startsWith('["run"'))), expected);
  }
});

test('resume passes a next reviewer and shared options to Spar and rejects invalid values', { timeout: 15000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-resume-next-')));
  const root = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'spar.toml'), '');
  const fake = path.join(temp, 'fake-spar');
  fs.writeFileSync(fake, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const deck = await createDeck({ root, dataDir, binary: fake });
  t.after(async () => {
    deck.server.closeAllConnections(); await new Promise(resolve => deck.server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${deck.server.address().port}`;
  const snapshot = () => fetch(`${base}/api/state`).then(r => r.json());
  const token = (await snapshot()).token;
  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, { method: 'POST', headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const { data: project } = await post('/api/projects', { path: root });
  const invalid = [
    { next: '--repo' }, { next: 'a b' }, { next: true }, { first: '-x' }, { base: '-x' }, { base: 'a..b' }, { base: 'main\n' },
    { instructions: '-x' }, { instructions: 'bad\0text' }, { instructions: 'x'.repeat(4001) }, { absorb: '0' }, { 'min-number': '-5' },
    { 'close-skipped': true }, { repo: '/tmp' }, { config: '/tmp/spar.toml' }, { quiet: true }, { 'auto-merge': true },
  ];
  for (const flags of invalid) {
    const { status, data } = await post('/api/jobs', { projectId: project.id, command: 'resume', targets: '1923', flags });
    assert.equal(status, 400, JSON.stringify(flags)); assert.match(data.error, /Invalid|Unsupported option/);
  }
  assert.equal((await post('/api/jobs', { projectId: project.id, command: 'run', flags: { 'close-skipped': true, 'no-close-skipped': true } })).status, 400);
  assert.equal((await snapshot()).jobs.length, 0);
  const instructions = 'Keep "public" names; $(touch should-not-exist)';
  const cases = [
    [{ targets: '1923', flags: { next: 'codex' } }, ['resume', '1923', '--next', 'codex']],
    [{ targets: '1923', flags: { next: 'claude', first: 'codex', base: 'release/1.x', instructions, absorb: '2', 'keep-worktrees': true }, limit: '5' },
      ['resume', '1923', '--next', 'claude', '--first', 'codex', '--base', 'release/1.x', '--instructions', instructions, '--absorb', '2', '--keep-worktrees', '--limit', '5']],
  ];
  for (const [options, expected] of cases) {
    const { status, data: job } = await post('/api/jobs', { projectId: project.id, command: 'resume', ...options });
    assert.equal(status, 201);
    await until(async () => (await snapshot()).jobs.find(j => j.id === job.id)?.status === 'completed');
    assert.deepEqual(job.args, expected);
    assert.deepEqual((await snapshot()).jobs.find(j => j.id === job.id).args, expected);
    const folder = path.join(dataDir, 'jobs', job.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'request.json'), 'utf8')).args, expected);
    const output = fs.readFileSync(path.join(folder, 'output.log'), 'utf8');
    assert.deepEqual(JSON.parse(output.split('\n').find(line => line.startsWith('["resume"'))), expected);
  }
  assert.equal(fs.existsSync(path.join(root, 'should-not-exist')), false);
});

test('config update runs in the selected project, preserves settings, and reports failure', { timeout: 15000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-update-')));
  const root = path.join(temp, 'projects'), dataDir = path.join(temp, 'data'); fs.mkdirSync(root);
  const fake = path.join(temp, 'fake-spar');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('spar test'); process.exit(0); }
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['init', '--update'])) process.exit(9);
const text = fs.readFileSync('spar.toml', 'utf8');
if (text.includes('fail-update')) { console.error('Configuration could not be parsed'); process.exit(2); }
setTimeout(() => { fs.appendFileSync('spar.toml', '\\n# New option\\n# max_rounds = 4\\n'); console.log('added missing settings as comments'); }, 300);
`, { mode: 0o700 });
  const deck = await createDeck({ root, dataDir, binary: fake });
  t.after(async () => { deck.server.closeAllConnections(); await new Promise(resolve => deck.server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); });
  await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${deck.server.address().port}`;
  const token = (await fetch(`${base}/api/state`).then(r => r.json())).token;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const projects = [];
  for (const name of ['alpha', 'beta']) {
    const folder = path.join(root, name); fs.mkdirSync(folder); execFileSync('git', ['init', '-q', folder]);
    projects.push((await request('/api/projects', 'POST', { path: folder })).data);
  }
  const [project, other] = projects, file = path.join(project.path, 'spar.toml');
  const input = { projectId: project.id, command: 'init', flags: { update: true } };
  assert.equal((await request('/api/jobs', 'POST', input)).status, 400, 'missing configs need initialization');
  const original = '# My settings\n[loop]\nmax_rounds = 9\n'; fs.writeFileSync(file, original);
  let config = (await request(`/api/projects/${project.id}/config`)).data;
  fs.writeFileSync(file, original + '# Edited elsewhere\n');
  assert.equal((await request('/api/jobs', 'POST', { ...input, configRevision: config.revision })).status, 409);
  assert.equal((await request('/api/state')).data.jobs.length, 0);
  config = (await request(`/api/projects/${project.id}/config`)).data;
  const { status, data: job } = await request('/api/jobs', 'POST', { ...input, configRevision: config.revision });
  assert.equal(status, 201); assert.deepEqual(job.args, ['init', '--update']);
  assert.equal((await request('/api/jobs', 'POST', input)).status, 409, 'serialize config updates with project commands');
  await until(async () => (await request(`/api/jobs/${job.id}/log`)).data.job.status === 'completed');
  const updated = (await request(`/api/projects/${project.id}/config`)).data;
  assert.equal(updated.content, config.content + '\n# New option\n# max_rounds = 4\n');
  assert.notEqual(updated.revision, config.revision);
  assert.equal(fs.existsSync(path.join(other.path, 'spar.toml')), false);
  assert.match((await request(`/api/jobs/${job.id}/log`)).data.output, /added missing settings/);
  const jobRequest = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', job.id, 'request.json'), 'utf8'));
  assert.equal(jobRequest.cwd, project.path); assert.deepEqual(jobRequest.args, ['init', '--update']);
  fs.writeFileSync(file, '# fail-update\n');
  const failure = (await request('/api/jobs', 'POST', input)).data;
  await until(async () => (await request(`/api/jobs/${failure.id}/log`)).data.job.status === 'failed');
  assert.match((await request(`/api/jobs/${failure.id}/log`)).data.output, /Configuration could not be parsed/);
  assert.equal(fs.readFileSync(file, 'utf8'), '# fail-update\n');
  fs.unlinkSync(file); fs.symlinkSync(path.join(temp, 'outside.toml'), file); fs.writeFileSync(path.join(temp, 'outside.toml'), original);
  assert.equal((await request('/api/jobs', 'POST', input)).status, 400);
  assert.equal(fs.readFileSync(path.join(temp, 'outside.toml'), 'utf8'), original);
});

test('pausing a listener runs another command after it exits, then restarts it once', { timeout: 90000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pause-')));
  const root = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'spar.toml'), '');
  // Listen holds a marker while it runs. Other commands exit non-zero if it is present, so a
  // completed command proves the listener had exited first.
  const fake = path.join(temp, 'fake-spar');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv[2];
if (command === '--version') { console.log('spar test'); process.exit(0); }
if (command === 'listen') {
  fs.writeFileSync('listening', String(process.pid));
  setInterval(() => {}, 1000);
  process.on('SIGINT', () => { fs.rmSync('listening', { force: true }); console.log('listener stopped'); process.exit(0); });
} else {
  if (fs.existsSync('listening')) { console.error('listener still running'); process.exit(3); }
  if (command === 'review') { console.log('review finished'); process.exit(0); }
  setInterval(() => {}, 1000);
  process.on('SIGINT', () => process.exit(0));
}
`, { mode: 0o700 });
  let deck, base, token;
  const launch = async () => { deck = await createDeck({ root, dataDir, binary: fake }); await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${deck.server.address().port}`; token = (await fetch(`${base}/api/state`).then(r => r.json())).token; };
  const close = () => new Promise(resolve => { deck.server.closeAllConnections(); deck.server.close(resolve); });
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const jobs = async () => (await request('/api/state')).data.jobs;
  const jobState = async jobId => (await jobs()).find(j => j.id === jobId);
  const wait = async fn => { for (let i = 0; i < 300; i++) { const result = await fn(); if (result) return result; await delay(100); } throw new Error('Timed out.'); };
  const listeners = async () => (await jobs()).filter(j => j.command === 'listen');
  const runningListener = () => wait(async () => (await listeners()).find(j => j.status === 'running'));
  t.after(async () => {
    if (!deck?.server.listening) await launch();
    for (const job of await jobs()) if (['starting', 'running'].includes(job.status)) await request(`/api/jobs/${job.id}/stop`, 'POST', {}).catch(() => {});
    await wait(async () => !(await jobs()).some(j => ['starting', 'running', 'stopping'].includes(j.status))).catch(() => {});
    await close(); fs.rmSync(temp, { recursive: true, force: true });
  });
  await launch();
  const project = (await request('/api/projects', 'POST', { path: root })).data;
  const args = ['listen', '--since', '2h', '--first', 'codex'];
  const first = (await request('/api/jobs', 'POST', { projectId: project.id, command: 'listen', flags: { since: '2h', first: 'codex' } })).data;
  assert.deepEqual(first.args, args);
  await wait(async () => (await jobState(first.id)).status === 'running');

  assert.equal((await request('/api/jobs', 'POST', { projectId: project.id, command: 'review' })).status, 409, 'pausing needs an explicit opt-in');
  assert.equal((await request('/api/jobs', 'POST', { projectId: project.id, command: 'listen', pauseListener: true })).status, 409);
  assert.equal((await request('/api/jobs', 'POST', { projectId: project.id, command: 'sh', pauseListener: true })).status, 400);
  assert.equal((await request('/api/jobs', 'POST', { projectId: project.id, command: 'review', flags: { since: '2h' }, pauseListener: true })).status, 400);
  assert.equal((await request('/api/jobs', 'POST', { projectId: project.id, command: 'review', targets: 'x', pauseListener: true })).status, 400);
  assert.equal((await jobs()).length, 1);
  assert.equal((await jobState(first.id)).status, 'running', 'rejected requests leave the listener alone');

  const review = await request('/api/jobs', 'POST', { projectId: project.id, command: 'review', pauseListener: true });
  assert.equal(review.status, 201);
  assert.deepEqual(review.data.resume, { listenerId: first.id, args, status: 'pending' });
  await wait(async () => (await jobState(review.data.id)).status === 'completed');
  assert.equal((await jobState(first.id)).status, 'stopped');
  const second = await runningListener();
  assert.deepEqual(second.args, args);
  assert.deepEqual((await jobState(review.data.id)).resume, { listenerId: first.id, args, status: 'started', jobId: second.id });
  assert.match((await request(`/api/jobs/${first.id}/log`)).data.output, /\[deck\] Pausing Listen to run spar review/);
  assert.match((await request(`/api/jobs/${review.data.id}/log`)).data.output, /\[deck\] Waiting for Listen to stop[\s\S]*review finished/);
  assert.match((await request(`/api/jobs/${second.id}/log`)).data.output, /\[deck\] Restarting Listen after spar review ended as completed/);

  // A long command keeps the project busy, and the restart survives a web-server restart.
  const checkin = (await request('/api/jobs', 'POST', { projectId: project.id, command: 'checkin', pauseListener: true })).data;
  await wait(async () => (await jobState(checkin.id)).status === 'running');
  assert.equal((await jobState(second.id)).status, 'stopped');
  const busy = await request('/api/jobs', 'POST', { projectId: project.id, command: 'review' });
  assert.equal(busy.status, 409); assert.match(busy.data.error, /Listen is waiting to restart/);
  assert.equal((await request('/api/jobs', 'POST', { projectId: project.id, command: 'review', pauseListener: true })).status, 409);
  const config = (await request(`/api/projects/${project.id}/config`)).data;
  assert.equal((await request(`/api/projects/${project.id}/config`, 'PUT', { content: 'value = 1', revision: config.revision })).status, 409);
  assert.equal((await request(`/api/projects/${project.id}`, 'DELETE')).status, 409);
  await close(); await delay(300); await launch();
  assert.equal((await jobState(checkin.id)).status, 'running');
  assert.equal((await jobState(checkin.id)).resume.status, 'pending');
  assert.equal((await request(`/api/jobs/${checkin.id}/stop`, 'POST', {})).status, 200);
  await wait(async () => (await jobState(checkin.id)).status === 'stopped');
  const third = await runningListener();
  assert.deepEqual(third.args, args);
  assert.equal((await jobState(checkin.id)).resume.jobId, third.id);
  await close(); await delay(300); await launch(); await delay(1500);
  assert.equal((await listeners()).length, 3, 'each pause restarts Listen once');

  // Cancelling the restart leaves the command running and the project idle afterwards.
  const cancelled = (await request('/api/jobs', 'POST', { projectId: project.id, command: 'checkin', pauseListener: true })).data;
  await wait(async () => (await jobState(cancelled.id)).status === 'running');
  assert.equal((await request(`/api/jobs/${cancelled.id}/cancel-resume`, 'POST', {})).status, 200);
  assert.equal((await request(`/api/jobs/${cancelled.id}/cancel-resume`, 'POST', {})).status, 409);
  await delay(500);
  assert.equal((await jobState(cancelled.id)).status, 'running');
  await request(`/api/jobs/${cancelled.id}/stop`, 'POST', {});
  await wait(async () => (await jobState(cancelled.id)).status === 'stopped');
  await delay(1500);
  assert.equal((await listeners()).length, 3);
  assert.equal((await jobState(cancelled.id)).resume.status, 'cancelled');

  // The config editor's Stop run frees the project for saving without restarting Listen.
  const fourth = (await request('/api/jobs', 'POST', { projectId: project.id, command: 'listen', flags: { since: '2h', first: 'codex' } })).data;
  await wait(async () => (await jobState(fourth.id)).status === 'running');
  const editorStop = (await request('/api/jobs', 'POST', { projectId: project.id, command: 'checkin', pauseListener: true })).data;
  await wait(async () => (await jobState(editorStop.id)).status === 'running');
  await request(`/api/jobs/${editorStop.id}/stop`, 'POST', { cancelResume: true });
  await wait(async () => (await jobState(editorStop.id)).status === 'stopped');
  await delay(1500);
  assert.equal((await listeners()).length, 4);
  assert(!(await jobs()).some(j => ['starting', 'running', 'stopping'].includes(j.status)));
  const fresh = (await request(`/api/projects/${project.id}/config`)).data;
  assert.equal((await request(`/api/projects/${project.id}/config`, 'PUT', { content: 'value = 1', revision: fresh.revision })).status, 200);

  // Only a running, repeating listener can be paused.
  const once = (await request('/api/jobs', 'POST', { projectId: project.id, command: 'listen', flags: { once: true } })).data;
  await wait(async () => (await jobState(once.id)).status === 'running');
  assert.equal((await request('/api/jobs', 'POST', { projectId: project.id, command: 'review', pauseListener: true })).status, 409);
  await request(`/api/jobs/${once.id}/stop`, 'POST', {});
  assert.equal((await jobState(once.id)).status, 'stopping');
  assert.equal((await request('/api/jobs', 'POST', { projectId: project.id, command: 'review', pauseListener: true })).status, 409);
  await wait(async () => (await jobState(once.id)).status === 'stopped');
});

test('a pause that cannot finish cleanly never runs the command or restarts Listen', { timeout: 30000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pause-fail-')));
  const root = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]); fs.mkdirSync(dataDir);
  const fake = path.join(temp, 'fake-spar');
  fs.writeFileSync(fake, `#!${process.execPath}\nif (process.argv[2] !== '--version') require('node:fs').appendFileSync('ran', process.argv[2] + '\\n');\n`, { mode: 0o700 });
  const project = { id: 'project', path: root, name: 'project', addedAt: new Date().toISOString() };
  const args = ['listen', '--since', '2h'], createdAt = new Date().toISOString();
  const record = (jobId, command, extra = {}) => ({ id: jobId, projectId: project.id, projectName: project.name, command, args: command === 'listen' ? args : [command], createdAt, ...extra });
  const resume = listenerId => ({ resume: { listenerId, args, status: 'pending' } });
  // Listen ended failed during the pause, and a second command's supervisor was lost.
  atomicJSON(path.join(dataDir, 'jobs', 'listener', 'status.json'), { status: 'failed', cleanupIncomplete: true, heartbeat: Date.now() });
  atomicJSON(path.join(dataDir, 'jobs', 'blocked', 'request.json'), { cwd: root, binary: fake, args: ['review'], waitFor: 'listener' });
  atomicJSON(path.join(dataDir, 'jobs', 'lost', 'status.json'), { status: 'running', heartbeat: Date.now() - 60000 });
  atomicJSON(path.join(dataDir, 'deck.json'), { version: 1, projects: [project], jobs: [record('listener', 'listen'), record('lost', 'checkin', resume('listener')), record('blocked', 'review', resume('listener'))] });
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../src/worker.mjs', import.meta.url)), dataDir, 'blocked'], { stdio: 'ignore' });
  await new Promise(resolve => worker.once('exit', resolve));
  const deck = await createDeck({ root, dataDir, binary: fake });
  t.after(async () => { deck.server.closeAllConnections(); await new Promise(resolve => deck.server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); });
  await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve));
  await delay(1500);
  const { jobs } = await deck.snapshot();
  const blocked = jobs.find(j => j.id === 'blocked'), lost = jobs.find(j => j.id === 'lost');
  assert.equal(blocked.status, 'failed'); assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.resume, { listenerId: 'listener', args, status: 'skipped', reason: 'blocked' });
  assert.match(fs.readFileSync(path.join(dataDir, 'jobs', 'blocked', 'output.log'), 'utf8'), /\[deck\] Listen ended as failed instead of stopping cleanly\. This command did not run/);
  assert.equal(lost.status, 'interrupted');
  assert.deepEqual(lost.resume, { listenerId: 'listener', args, status: 'skipped', reason: 'interrupted' });
  assert.equal(jobs.length, 3, 'no listener starts');
  assert.equal(fs.existsSync(path.join(root, 'ran')), false, 'Spar never ran');
});

test('a deck that cannot bind its port never restarts a paused listener', { timeout: 10000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pause-port-')));
  const root = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]); fs.mkdirSync(dataDir);
  const project = { id: 'project', path: root, name: 'project', addedAt: new Date().toISOString() };
  const done = { id: 'done', projectId: project.id, projectName: project.name, command: 'review', args: ['review'], createdAt: new Date().toISOString(), resume: { listenerId: 'listener', args: ['listen'], status: 'pending' } };
  atomicJSON(path.join(dataDir, 'jobs', 'done', 'status.json'), { status: 'completed', heartbeat: Date.now() });
  atomicJSON(path.join(dataDir, 'deck.json'), { version: 1, projects: [project], jobs: [done] });
  const running = http.createServer();
  await new Promise(resolve => running.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => running.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); });
  const deck = await createDeck({ root, dataDir, binary: path.join(temp, 'missing-spar') });
  const error = await new Promise(resolve => { deck.server.once('error', resolve); deck.server.listen(running.address().port, '127.0.0.1'); });
  assert.equal(error.code, 'EADDRINUSE');
  await delay(1500);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'jobs')), ['done']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'deck.json'), 'utf8')).jobs[0].resume.status, 'pending');
});

test('a run that ends in a Spar escalation is recorded as escalated, and real failures stay failed', { timeout: 20000 }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-escalated-')));
  const root = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'spar.toml'), '');
  // The target number picks the report and how the fake exits. Writes are synchronous so a signal cannot drop them.
  const fake = path.join(temp, 'fake-spar');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const target = process.argv[3];
const rule = '='.repeat(60);
const items = target === '2' ? ['#7     error      rounds=1', '       implementation failed'] : ['#1942  escalated  rounds=4 https://github.com/OWNER/REPO/pull/1', '       one point left after the closing pass'];
fs.writeSync(1, ['working', '', rule, ...items, rule, '', 'spent: 2 agent call(s), 3m of model time', '', 'writes: 7 attempted, 7 succeeded, 0 failed', ''].join('\\n'));
if (target === '4') process.kill(process.pid, 'SIGKILL');
process.exit(target === '3' ? 2 : 1);
`, { mode: 0o700 });
  const deck = await createDeck({ root, dataDir, binary: fake });
  t.after(async () => { deck.server.closeAllConnections(); await new Promise(resolve => deck.server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); });
  await new Promise(resolve => deck.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${deck.server.address().port}`;
  const token = (await fetch(`${base}/api/state`).then(r => r.json())).token;
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const project = await post('/api/projects', { path: root });
  const cases = [['1', 'escalated', 1, null], ['2', 'failed', 1, null], ['3', 'failed', 2, null], ['4', 'failed', null, 'SIGKILL']];
  for (const [target, expected, exitCode, signal] of cases) {
    const job = await post('/api/jobs', { projectId: project.id, command: 'run', targets: target });
    // Under load the view can briefly read interrupted, so wait for the supervisor's final record.
    const done = await until(async () => {
      const view = (await deck.snapshot()).jobs.find(j => j.id === job.id);
      return view.endedAt && view;
    });
    assert.equal(done.status, expected, `run ${target}`);
    assert.equal(done.exitCode, exitCode, `run ${target}`); assert.equal(done.signal, signal, `run ${target}`);
    const folder = path.join(dataDir, 'jobs', job.id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'status.json'), 'utf8')).status, expected);
    const last = fs.readFileSync(path.join(folder, 'output.log'), 'utf8').trimEnd().split('\n').at(-1);
    assert.equal(last, `[deck] ${expected}${exitCode == null ? '' : ` (exit ${exitCode})`}`);
  }
});
