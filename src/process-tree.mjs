import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const args = ['-axo', 'pid=,ppid=,lstart='];
const options = { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 };
const parse = output => output.trim().split('\n').flatMap(line => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3] }] : [];
});

// The synchronous lookup is only used to verify stale runs in the web server.
export function processTable() {
  return parse(execFileSync('/bin/ps', args, options));
}

// Supervisors must not block their heartbeats, output streams, or control sockets
// on a process-table scan. Bound each scan and kill a stuck ps on timeout.
export async function processTableAsync() {
  const { stdout } = await execute('/bin/ps', args, options);
  return parse(stdout);
}

// Spar starts tools in separate process groups. Retain descendant identities so
// stopping Spar can also stop those tools without signaling a reused process ID.
export function descendants(rootPid, table = processTable()) {
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) { changed = false; for (const process of table) if (found.has(process.ppid) && !found.has(process.pid)) { found.add(process.pid); changed = true; } }
  return table.filter(process => found.has(process.pid) && process.pid !== rootPid);
}
export async function signalVerified(processes, signal) {
  if (!processes.length) return;
  const current = new Map((await processTableAsync()).map(process => [process.pid, process.started]));
  for (const process of [...processes].reverse()) {
    if (current.get(process.pid) !== process.started) continue;
    try { globalThis.process.kill(process.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function createProcessMonitor({ readTable = processTableAsync, onTable, onError, onRecovery = () => {}, now = Date.now, intervalMs = 5000, maxBackoffMs = 60000, warningIntervalMs = 300000 }) {
  let pending, nextAt = 0, failures = 0, lastWarning = -Infinity;
  return {
    poll(force = false) {
      // All callers share one in-flight scan, including a stop request.
      if (pending) return pending;
      if (!force && now() < nextAt) return Promise.resolve();
      pending = Promise.resolve().then(readTable).then(table => {
        onTable(table);
        if (failures) onRecovery();
        failures = 0;
        nextAt = now() + intervalMs;
        return true;
      }).catch(error => {
        const retryMs = Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(++failures, 10));
        nextAt = now() + retryMs;
        if (now() - lastWarning >= warningIntervalMs) {
          lastWarning = now();
          onError(error, retryMs);
        }
        return false;
      }).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
