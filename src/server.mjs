import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ACTIVE, COMMANDS, defaultDataDir, atomicJSON, readJSON, resolveDirectory, buildArgs, id, socketPath, tailFile } from './core.mjs';
import { processTable } from './process-tree.mjs';
const execute = promisify(execFile);
const source = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(source, '../public');

export async function createDeck(options = {}) {
  const dataDir = path.resolve(options.dataDir || defaultDataDir());
  const root = fs.realpathSync(options.root || process.env.SPAR_DECK_ROOT || path.join(os.homedir(), 'Documents'));
  const binary = options.binary || process.env.SPAR_BIN || 'spar';
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dataDir, 'deck.json');
  let state = readJSON(stateFile, { version: 1, projects: [], jobs: [] });
  if (state.version !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.jobs)) throw new Error('Unsupported or invalid dashboard data. Restore deck.json from a backup.');
  const token = crypto.randomBytes(32).toString('hex');
  const save = () => atomicJSON(stateFile, state);
  let version = 'Unavailable';
  try { version = (await execute(binary, ['--version'], { timeout: 4000 })).stdout.trim(); } catch {}
  function jobView(job) {
    const status = readJSON(path.join(dataDir, 'jobs', job.id, 'status.json'), { status: 'starting', heartbeat: Date.parse(job.createdAt) });
    if (ACTIVE.has(status.status) && Date.now() - status.heartbeat > 12000) {
      let live = false;
      if (status.identity) {
        try { live = processTable().some(p => p.pid === status.identity.pid && p.started === status.identity.started); }
        catch { live = true; }
      }
      status.status = live ? 'unresponsive' : 'interrupted';
    }
    return { ...job, ...status };
  }
  const allJobs = () => state.jobs.map(jobView);
  const activeJobs = projectId => allJobs().filter(j => j.projectId === projectId && ACTIVE.has(j.status));
  async function metadata(project) {
    try {
      resolveDirectory(root, project.path);
      const result = await execute('git', ['-C', project.path, 'branch', '--show-current'], { timeout: 2000 });
      return { ...project, branch: result.stdout.trim() || 'detached', configured: fs.existsSync(path.join(project.path, 'spar.toml')), available: true };
    } catch { return { ...project, branch: '', configured: false, available: false }; }
  }
  async function snapshot() {
    return { token, root, version, commands: COMMANDS, projects: await Promise.all(state.projects.map(metadata)), jobs: allJobs().reverse(), dataDir };
  }
  async function body(req) {
    let chunks = ''; for await (const chunk of req) { chunks += chunk; if (chunks.length > 20000) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
    try { return JSON.parse(chunks || '{}'); } catch { throw new Error('Invalid JSON.'); }
  }
  function projectById(projectId) {
    const project = state.projects.find(p => p.id === projectId); if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 }); return project;
  }
  function startJob(project, input) {
    resolveDirectory(root, project.path);
    const args = buildArgs(input.command, input);
    // Spar commands share state and worktrees. Serializing a project avoids competing runs.
    if (activeJobs(project.id).length) throw Object.assign(new Error('Stop this project’s active command before starting another.'), { status: 409 });
    const job = { id: id(), projectId: project.id, projectName: project.name, command: input.command, args, createdAt: new Date().toISOString() };
    const folder = path.join(dataDir, 'jobs', job.id);
    atomicJSON(path.join(folder, 'request.json'), { cwd: project.path, binary, args });
    state.jobs.push(job); save();
    const worker = spawn(process.execPath, [path.join(source, 'worker.mjs'), dataDir, job.id], { detached: true, stdio: 'ignore', env: process.env });
    worker.on('error', error => atomicJSON(path.join(folder, 'status.json'), { status: 'failed', error: error.message, endedAt: new Date().toISOString() }));
    worker.unref(); return job;
  }
  async function stopJob(job) {
    if (!ACTIVE.has(jobView(job).status)) return;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath(dataDir, job.id));
      socket.setTimeout(3000, () => socket.destroy(new Error('Worker did not respond.')));
      socket.once('connect', () => socket.write('stop\n'));
      socket.once('data', () => { socket.end(); resolve(); });
      socket.once('error', () => reject(new Error('The run supervisor is unavailable. If Spar is still running, stop it in Activity Monitor before starting another run.')));
    });
  }
  function reply(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) return reply(res, 403, { error: 'Invalid host.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, { error: 'Cross-site requests are not allowed.' });
      if (req.headers.origin && !hosts.map(h => `http://${h}`).includes(req.headers.origin)) return reply(res, 403, { error: 'Invalid origin.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method !== 'GET' && req.headers['x-deck-token'] !== token) return reply(res, 403, { error: 'Refresh the dashboard and try again.' });
      if (req.method === 'GET' && url.pathname === '/api/state') return reply(res, 200, await snapshot());
      if (req.method === 'GET' && url.pathname === '/api/browse') {
        const directory = resolveDirectory(root, url.searchParams.get('path') || root);
        const entries = fs.readdirSync(directory, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => {
          const p = path.join(directory, e.name);
          return { name: e.name, path: p, repository: fs.existsSync(path.join(p, '.git')), configured: fs.existsSync(path.join(p, 'spar.toml')) };
        }).sort((a, b) => a.name.localeCompare(b.name));
        return reply(res, 200, { path: directory, parent: directory === root ? null : path.dirname(directory), repository: fs.existsSync(path.join(directory, '.git')), entries });
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(req);
        const directory = resolveDirectory(root, input.path);
        const top = (await execute('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { timeout: 3000 })).stdout.trim();
        if (fs.realpathSync(top) !== directory) throw new Error('Select the root folder of a Git repository.');
        if (state.projects.some(p => p.path === directory)) throw new Error('This project is already on your deck.');
        const project = { id: id(), path: directory, name: path.basename(directory), addedAt: new Date().toISOString() };
        state.projects.push(project); save(); return reply(res, 201, project);
      }
      if (req.method === 'PUT' && url.pathname === '/api/order') {
        const { ids } = await body(req);
        if (!Array.isArray(ids) || new Set(ids).size !== state.projects.length || ids.length !== state.projects.length || ids.some(value => !state.projects.some(p => p.id === value))) throw new Error('Project list changed. Refresh and try again.');
        state.projects = ids.map(projectById); save(); return reply(res, 200, { ok: true });
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([\w-]+)$/);
      if (req.method === 'DELETE' && projectMatch) {
        const project = projectById(projectMatch[1]);
        if (activeJobs(project.id).length) throw Object.assign(new Error('Stop the active command before removing this card.'), { status: 409 });
        state.projects = state.projects.filter(p => p.id !== project.id); save(); return reply(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const input = await body(req); return reply(res, 201, startJob(projectById(input.projectId), input));
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/(log|stop)$/);
      if (jobMatch) {
        const job = state.jobs.find(j => j.id === jobMatch[1]);
        if (!job) return reply(res, 404, { error: 'Run not found.' });
        if (req.method === 'GET' && jobMatch[2] === 'log') return reply(res, 200, { job: jobView(job), output: tailFile(path.join(dataDir, 'jobs', job.id, 'output.log')) });
        if (req.method === 'POST' && jobMatch[2] === 'stop') { await stopJob(job); return reply(res, 200, { ok: true }); }
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, type] = files[url.pathname]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(fs.readFileSync(path.join(publicDir, file)));
      }
      reply(res, 404, { error: 'Not found.' });
    } catch (error) { reply(res, error.status || 400, { error: error.message }); }
  });
  return { server, snapshot, dataDir };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deck = await createDeck();
  const port = Number(process.env.SPAR_DECK_PORT || 4177);
  deck.server.listen(port, '127.0.0.1', () => console.log(`Spar Deck is ready at http://127.0.0.1:${port}\nData: ${deck.dataDir}`));
  deck.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Spar Deck may already be running.` : error.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { deck.server.close(); process.exit(0); });
}
