import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { atomicJSON, readJSON, socketPath } from './core.mjs';
import { descendants, signalVerified, processTable } from './process-tree.mjs';

// A separate supervisor owns each run, so browser and web-server lifetimes do not matter.
const [dataDir, jobId] = process.argv.slice(2);
const folder = path.join(dataDir, 'jobs', jobId);
const request = readJSON(path.join(folder, 'request.json'));
const statusFile = path.join(folder, 'status.json');
const logFile = path.join(folder, 'output.log');
const socket = socketPath(dataDir, jobId);
fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
let child, stopping = false, finished = false, killTimer, rootExited = false, exitCode, exitSignal;
const knownDescendants = new Map();
function collectDescendants() {
  if (!child?.pid || rootExited) return;
  try { for (const item of descendants(child.pid)) knownDescendants.set(item.pid, item); } catch (error) { log(`\n[deck] Could not inspect descendants: ${error.message}\n`); }
}
function signalDescendants(sig) {
  try { signalVerified([...knownDescendants.values()], sig); } catch (error) { log(`\n[deck] Could not stop descendants: ${error.message}\n`); }
}
let bytes = 0;
let state = { status: 'starting', startedAt: new Date().toISOString(), heartbeat: Date.now() };
const save = extra => { state = { ...state, ...extra, heartbeat: Date.now() }; atomicJSON(statusFile, state); };
function log(chunk) {
  if (bytes + chunk.length > 2 * 1024 * 1024) {
    fs.renameSync(logFile, `${logFile}.previous`); bytes = 0;
  }
  fs.appendFileSync(logFile, chunk, { mode: 0o600 }); bytes += chunk.length;
}
function signal(sig) {
  if (!child?.pid || finished) return;
  try { process.kill(-child.pid, sig); } catch (error) { if (error.code !== 'ESRCH') log(`\n${error.message}\n`); }
}
function stop() {
  if (stopping || finished) return;
  collectDescendants();
  stopping = true; save({ status: 'stopping' });
  log('\n[deck] Stop requested. Allowing up to 20 seconds for cleanup.\n');
  signal('SIGINT');
  killTimer = setTimeout(() => { signalDescendants('SIGKILL'); signal('SIGKILL'); }, 20000);
}
const control = net.createServer(connection => {
  connection.setEncoding('utf8'); connection.setTimeout(2000, () => connection.destroy());
  connection.once('data', data => { if (data.trim() === 'stop') stop(); connection.end('ok'); });
});
control.listen(socket, () => {
  fs.chmodSync(socket, 0o600);
  log(`[deck] spar ${request.args.join(' ')}\n[deck] ${request.cwd}\n\n`);
  child = spawn(request.binary, request.args, { cwd: request.cwd, env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.once('spawn', () => {
    let identity;
    try { identity = processTable().find(p => p.pid === child.pid); } catch {}
    save({ status: 'running', pid: child.pid, identity });
  });
  child.stdout.on('data', log); child.stderr.on('data', log);
  child.once('error', error => { log(`\n[deck] ${error.message}\n`); finish(1, null); });
  child.once('exit', (code, signalName) => {
    rootExited = true; exitCode = code; exitSignal = signalName;
    if (stopping) {
      signalDescendants('SIGTERM');
      setTimeout(() => { signalDescendants('SIGKILL'); finish(exitCode, exitSignal); }, 1000);
    }
  });
  child.once('close', (code, signalName) => { if (!stopping) finish(code, signalName); });
});
control.on('error', error => { log(`[deck] Supervisor error: ${error.message}\n`); finish(1, null); });
const heartbeat = setInterval(() => { collectDescendants(); save({}); }, 2000);
function finish(code, signalName) {
  if (finished) return;
  finished = true; clearInterval(heartbeat); clearTimeout(killTimer);
  save({ status: stopping ? 'stopped' : code === 0 ? 'completed' : 'failed', exitCode: code, signal: signalName, endedAt: new Date().toISOString() });
  log(`\n[deck] ${state.status}${code != null ? ` (exit ${code})` : ''}\n`);
  control.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
