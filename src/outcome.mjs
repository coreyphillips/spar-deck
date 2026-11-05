// Spar 0.4.34 exits 1 both when it escalates an item to a person and when something
// actually failed. Only the report printed by `report_with` in Spar's `src/cli.rs`
// tells them apart, so this reads that report from the end of a run's log.
const RULE = '='.repeat(60);
// `IssueRun::succeeded` in Spar's `src/model.rs`.
const SUCCESS = new Set(['merged', 'approved', 'abandoned', 'reviewed', 'clean', 'answered', 'split', 'whole']);
const OUTCOME = /^#\d+\s+(\S+)\s+rounds=\d+(?:\s|$)/;
const WRITES = /^writes: \d+ attempted, \d+ succeeded, (\d+) failed$/;
// Lines Spar prints after the report when a wave of work stopped early.
const STOPPED = [/^could not read /, /^triage failed for /, /^the issue queue stopped:/, / was not reached after that failure$/];

// Spar holds back dependents of an item that did not merge, so an escalation often
// leaves them pending. That is part of the escalation, not a separate failure.
const allowed = item => item.status === 'escalated' || SUCCESS.has(item.status)
  || (item.status === 'pending' && item.note?.startsWith('held back:'));

// Returns 'escalated' when the last report shows at least one escalation and nothing
// else that Spar counts as a failure. Anything it cannot read stays 'failed'.
export function classifyReport(log) {
  const lines = log.split('\n').map(line => line.replace(/\r$/, ''));
  const close = lines.lastIndexOf(RULE);
  // lastIndexOf treats a negative start as counting from the end.
  const open = close > 0 ? lines.lastIndexOf(RULE, close - 1) : -1;
  if (open < 0) return 'failed';
  const items = [];
  for (const line of lines.slice(open + 1, close)) {
    const match = line.match(OUTCOME);
    if (match) items.push({ status: match[1] });
    // Notes come first among an item's indented lines.
    else if (line.startsWith(' ') && items.length) items.at(-1).note ??= line.trim();
    else return 'failed';
  }
  for (const line of lines.slice(close + 1)) {
    if (STOPPED.some(pattern => pattern.test(line))) return 'failed';
    const writes = line.match(WRITES);
    if (writes && Number(writes[1]) > 0) return 'failed';
  }
  return items.some(item => item.status === 'escalated') && items.every(allowed) ? 'escalated' : 'failed';
}
