import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
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
