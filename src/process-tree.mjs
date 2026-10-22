import { execFileSync } from 'node:child_process';

// Spar starts tool subprocesses in separate process groups. A signal to Spar's
// group alone will not reach those tools, so retain verified descendant identities.
export function processTable() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 })
    .trim().split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3] }] : [];
    });
}
export function descendants(rootPid, table = processTable()) {
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) { changed = false; for (const process of table) if (found.has(process.ppid) && !found.has(process.pid)) { found.add(process.pid); changed = true; } }
  return table.filter(process => found.has(process.pid) && process.pid !== rootPid);
}
export function signalVerified(processes, signal) {
  if (!processes.length) return;
  const current = new Map(processTable().map(process => [process.pid, process.started]));
  for (const process of [...processes].reverse()) {
    if (current.get(process.pid) !== process.started) continue;
    try { globalThis.process.kill(process.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
