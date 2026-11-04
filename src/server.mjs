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
import { readConfig, writeConfig } from './project-config.mjs';
import { readFollowupCount } from './followups.mjs';
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
      return { ...project, branch: result.stdout.trim() || 'detached', configured: fs.existsSync(path.join(project.path, 'spar.toml')), available: true, followups: readFollowupCount(project.path) };
    } catch { return { ...project, branch: '', configured: false, available: false, followups: 0 }; }
  }
  async function snapshot() {
    return { token, root, version, commands: COMMANDS, projects: await Promise.all(state.projects.map(metadata)), jobs: allJobs().reverse(), dataDir };
  }
  async function body(req, limit = 20000) {
    const buffers = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > limit) throw Object.assign(new Error('Request too large.'), { status: 413 }); buffers.push(chunk); }
    const chunks = Buffer.concat(buffers).toString('utf8');
    try { return JSON.parse(chunks || '{}'); } catch { throw new Error('Invalid JSON.'); }
  }
  function projectById(projectId) {
    const project = state.projects.find(p => p.id === projectId); if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 }); return project;
  }
  const conflict = message => Object.assign(new Error(message), { status: 409 });
  const awaitingResume = projectId => state.jobs.some(j => j.projectId === projectId && j.resume?.status === 'pending');
  // Called before any check that requires an idle project, so a command that has just finished
  // hands the project back to its listener before anything else can claim it.
  function requireIdle(project, message) {
    resumeListeners(project.id);
    if (awaitingResume(project.id)) throw conflict('Listen is waiting to restart when this project’s command finishes. Stop the command, or cancel the restart, first.');
    if (message && activeJobs(project.id).length) throw conflict(message);
  }
  function startJob(project, input) {
    resolveDirectory(root, project.path);
    const args = buildArgs(input.command, input);
    let resume;
    if (input.pauseListener === true) {
      requireIdle(project);
      const active = activeJobs(project.id), listener = active[0];
      if (input.command === 'listen') throw conflict('Listen is already running on this project.');
      if (active.length !== 1 || listener.command !== 'listen' || listener.status !== 'running') throw conflict('Listen can be paused only while it is running. Refresh and try again.');
      // A one-shot listener exits on its own. Restarting it would poll again.
      if (listener.args.includes('--once')) throw conflict('A listener started with Poll once cannot be paused. Let it finish, then start the command.');
      resume = { listenerId: listener.id, args: listener.args, status: 'pending' };
    } else {
      // Spar commands share state and worktrees. Serializing a project avoids competing runs.
      requireIdle(project, 'Stop this project’s active command before starting another.');
    }
    if (input.command === 'init' && input.flags?.update === true) {
      const config = readConfig(root, project);
      if (!config.exists) throw new Error('Initialize this project before updating its configuration.');
      if (input.configRevision !== undefined && input.configRevision !== config.revision) throw conflict('spar.toml changed on disk. Reload the file before updating.');
    }
    return launch(project, input.command, args, resume ? { record: { resume }, request: { waitFor: resume.listenerId } } : {});
  }
  function launch(project, command, args, { record = {}, request = {} } = {}) {
    const job = { id: id(), projectId: project.id, projectName: project.name, command, args, createdAt: new Date().toISOString(), ...record };
    const folder = path.join(dataDir, 'jobs', job.id);
    atomicJSON(path.join(folder, 'request.json'), { cwd: project.path, binary, args, ...request });
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
  async function pauseListener(job) {
    const listener = state.jobs.find(j => j.id === job.resume.listenerId);
    try { fs.appendFileSync(path.join(dataDir, 'jobs', listener.id, 'output.log'), `\n[deck] Pausing Listen to run spar ${job.args.join(' ')}. Listen restarts with the same options when that command finishes.\n`, { mode: 0o600 }); } catch {}
    // If the stop never arrives, the command's supervisor reports it and fails without running Spar.
    await stopJob(listener).catch(() => {});
  }
  // Restarts listeners whose pausing command has finished. Only the web server writes deck.json,
  // so this runs on a server timer and at startup rather than from a browser poll.
  function resumeListeners(projectId) {
    let changed = false;
    for (const job of state.jobs) {
      const resume = job.resume;
      if (resume?.status !== 'pending' || (projectId && job.projectId !== projectId)) continue;
      const view = jobView(job);
      if (ACTIVE.has(view.status)) continue;
      const project = state.projects.find(p => p.id === job.projectId);
      // Commands are not replayed after a lost supervisor, and a blocked command means Listen did not stop cleanly.
      if (view.status === 'interrupted' || view.blocked || !project) {
        Object.assign(resume, { status: 'skipped', reason: view.blocked ? 'blocked' : view.status === 'interrupted' ? 'interrupted' : 'removed' });
        changed = true; continue;
      }
      // A listener still shutting down after a stop during the wait keeps the project busy.
      if (activeJobs(project.id).length) continue;
      resume.status = 'started';
      try {
        resolveDirectory(root, project.path);
        resume.jobId = launch(project, 'listen', resume.args, { request: { note: `Restarting Listen after spar ${job.args.join(' ')} ended as ${view.status}.` } }).id;
      } catch (error) { Object.assign(resume, { status: 'failed', error: error.message }); }
      changed = true;
    }
    if (changed) save();
  }
  function tick() { try { resumeListeners(); } catch (error) { console.error(`Could not restart a paused listener: ${error.message}`); } }
  tick();
  const resumeTimer = setInterval(tick, 1000); resumeTimer.unref();
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
      const configMatch = url.pathname.match(/^\/api\/projects\/([\w-]+)\/config$/);
      if (configMatch && ['GET', 'PUT'].includes(req.method)) {
        const project = projectById(configMatch[1]);
        if (req.method === 'GET') return reply(res, 200, readConfig(root, project));
        // JSON escaping can expand a 64 KB document by up to six times.
        const input = await body(req, 6 * 64 * 1024 + 1024);
        requireIdle(project, 'Stop this project’s active command before saving its configuration.');
        return reply(res, 200, writeConfig(root, project, input));
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([\w-]+)$/);
      if (req.method === 'DELETE' && projectMatch) {
        const project = projectById(projectMatch[1]);
        requireIdle(project, 'Stop the active command before removing this card.');
        state.projects = state.projects.filter(p => p.id !== project.id); save(); return reply(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const input = await body(req); const job = startJob(projectById(input.projectId), input);
        if (job.resume) await pauseListener(job);
        return reply(res, 201, job);
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/(log|stop|cancel-resume)$/);
      if (jobMatch) {
        const job = state.jobs.find(j => j.id === jobMatch[1]);
        if (!job) return reply(res, 404, { error: 'Run not found.' });
        if (req.method === 'GET' && jobMatch[2] === 'log') return reply(res, 200, { job: jobView(job), output: tailFile(path.join(dataDir, 'jobs', job.id, 'output.log')) });
        if (req.method === 'POST' && jobMatch[2] === 'stop') {
          // The config editor stops a pausing command to free the project, so the listener stays off.
          if ((await body(req)).cancelResume === true && job.resume?.status === 'pending') { job.resume.status = 'cancelled'; save(); }
          await stopJob(job); return reply(res, 200, { ok: true });
        }
        if (req.method === 'POST' && jobMatch[2] === 'cancel-resume') {
          if (job.resume?.status !== 'pending') return reply(res, 409, { error: 'Listen is no longer waiting to restart.' });
          job.resume.status = 'cancelled'; save(); return reply(res, 200, { ok: true });
        }
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, type] = files[url.pathname]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(fs.readFileSync(path.join(publicDir, file)));
      }
      reply(res, 404, { error: 'Not found.' });
    } catch (error) { reply(res, error.status || 400, { error: error.message }); }
  });
  server.on('close', () => clearInterval(resumeTimer));
  return { server, snapshot, dataDir };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deck = await createDeck();
  const port = Number(process.env.SPAR_DECK_PORT || 4177);
  deck.server.listen(port, '127.0.0.1', () => console.log(`Spar Deck is ready at http://127.0.0.1:${port}\nData: ${deck.dataDir}`));
  deck.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Spar Deck may already be running.` : error.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { deck.server.close(); process.exit(0); });
}
