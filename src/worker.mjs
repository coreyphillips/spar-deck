import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ACTIVE, atomicJSON, readJSON, socketPath } from './core.mjs';
import { descendants, signalVerified, createProcessMonitor } from './process-tree.mjs';

// A separate supervisor owns each run, so browser and web-server lifetimes do not matter.
const [dataDir, jobId] = process.argv.slice(2);
const folder = path.join(dataDir, 'jobs', jobId);
const request = readJSON(path.join(folder, 'request.json'));
const statusFile = path.join(folder, 'status.json');
const logFile = path.join(folder, 'output.log');
const socket = socketPath(dataDir, jobId);
fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
let child, stopping = false, finished = false, killTimer, rootExited = false;
let cleanupIncomplete = false;
const knownDescendants = new Map();
let bytes = 0;
let state = { status: 'starting', startedAt: new Date().toISOString(), heartbeat: Date.now() };
const save = extra => { state = { ...state, ...extra, heartbeat: Date.now() }; atomicJSON(statusFile, state); };
function log(chunk) {
  if (bytes + chunk.length > 2 * 1024 * 1024) {
    fs.renameSync(logFile, `${logFile}.previous`); bytes = 0;
  }
  fs.appendFileSync(logFile, chunk, { mode: 0o600 }); bytes += chunk.length;
}
const monitor = createProcessMonitor({
  onTable(table) {
    if (finished || rootExited || !child?.pid) return;
    for (const item of descendants(child.pid, table)) knownDescendants.set(item.pid, item);
    const identity = table.find(p => p.pid === child.pid);
    if (identity && !state.identity) save({ identity });
  },
  onError(error, retryMs) {
    if (finished || rootExited) return;
    const reason = error.killed || error.code === 'ETIMEDOUT' ? 'the process scan timed out' : 'the process scan failed';
    log(`\n[deck] Process monitoring temporarily unavailable: ${reason}. Spar is still running. Retrying in ${retryMs / 1000}s; repeated warnings are limited to once every 5 minutes.\n`);
  },
  onRecovery() { if (!finished && !rootExited) log('\n[deck] Process monitoring recovered.\n'); },
});
async function signalDescendants(sig) {
  try { await signalVerified([...knownDescendants.values()], sig); return true; }
  catch { log('\n[deck] Could not verify subprocess identities for cleanup.\n'); return false; }
}
function signal(sig) {
  if (!child?.pid || finished || rootExited) return;
  try { process.kill(-child.pid, sig); } catch (error) { if (error.code !== 'ESRCH') log(`\n${error.message}\n`); }
}
async function stop() {
  if (stopping || finished) return;
  stopping = true; save({ status: 'stopping' });
  clearInterval(scans);
  log('\n[deck] Stop requested. Checking subprocesses, then allowing up to 20 seconds for cleanup.\n');
  cleanupIncomplete = await monitor.poll(true) === false;
  if (finished || rootExited) return;
  signal('SIGINT');
  killTimer = setTimeout(() => {
    // Terminate the root promptly even if verifying descendants takes longer.
    signal('SIGKILL');
  }, 20000);
}
const control = net.createServer(connection => {
  connection.setEncoding('utf8'); connection.setTimeout(2000, () => connection.destroy());
  connection.once('data', data => { if (data.trim() === 'stop') void stop(); connection.end('ok'); });
});
// A paused listener must be gone before this command starts, because both would share the checkout.
// Only a clean stop qualifies: a failed stop may have left tool subprocesses behind.
async function waitForListener() {
  const file = path.join(dataDir, 'jobs', request.waitFor, 'status.json');
  const began = Date.now();
  for (;;) {
    const listener = readJSON(file, null);
    if (listener?.status === 'stopped') return null;
    if (listener && !ACTIVE.has(listener.status)) return `Listen ended as ${listener.status} instead of stopping cleanly.`;
    if (!listener || Date.now() - listener.heartbeat > 12000) return 'Listen’s supervisor stopped responding.';
    // The server sends stop right after starting this supervisor, so a listener still running did not get it.
    if (listener.status === 'running' && Date.now() - began > 10000) return 'Listen did not accept the stop request.';
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
control.listen(socket, async () => {
  fs.chmodSync(socket, 0o600);
  if (request.note) log(`[deck] ${request.note}\n`);
  if (request.waitFor) {
    log('[deck] Waiting for Listen to stop before starting this command.\n');
    const reason = await waitForListener();
    if (reason) { log(`[deck] ${reason} This command did not run, and Listen will not restart. Inspect the Listen run, then start commands again from the card.\n`); return finish(1, null, { blocked: true }); }
    log('[deck] Listen stopped.\n');
    if (stopping) return finish(null, null);
  }
  log(`[deck] spar ${request.args.join(' ')}\n[deck] ${request.cwd}\n\n`);
  child = spawn(request.binary, request.args, { cwd: request.cwd, env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.once('spawn', () => {
    save({ status: stopping ? 'stopping' : 'running', pid: child.pid });
    void monitor.poll(true);
  });
  child.stdout.on('data', log); child.stderr.on('data', log);
  child.once('error', error => { log(`\n[deck] ${error.message}\n`); finish(1, null); });
  child.once('exit', async (code, signalName) => {
    rootExited = true;
    clearInterval(scans); clearTimeout(killTimer);
    if (stopping) {
      await signalDescendants('SIGTERM');
      setTimeout(async () => {
        const verified = await signalDescendants('SIGKILL');
        cleanupIncomplete = cleanupIncomplete || !verified;
        if (cleanupIncomplete) log('\n[deck] Spar exited, but subprocess cleanup could not be verified. Inspect remaining processes before retrying.\n');
        finish(code, signalName);
      }, 1000);
    }
  });
  child.once('close', (code, signalName) => { if (!stopping) finish(code, signalName); });
});
control.on('error', error => { log(`[deck] Supervisor error: ${error.message}\n`); finish(1, null); });
// Heartbeats stay independent of scans, including during timeouts and shutdown.
const heartbeat = setInterval(() => save({}), 2000);
const scans = setInterval(() => { if (child?.pid && !rootExited && !stopping) void monitor.poll(); }, 1000);
function finish(code, signalName, extra = {}) {
  if (finished) return;
  finished = true; clearInterval(heartbeat); clearInterval(scans); clearTimeout(killTimer);
  save({ status: extra.blocked || cleanupIncomplete ? 'failed' : stopping ? 'stopped' : code === 0 ? 'completed' : 'failed', cleanupIncomplete, exitCode: code, signal: signalName, endedAt: new Date().toISOString(), ...extra });
  log(`\n[deck] ${state.status}${code != null ? ` (exit ${code})` : ''}\n`);
  control.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
