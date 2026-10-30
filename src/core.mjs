import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const ACTIVE = new Set(['starting', 'running', 'stopping', 'unresponsive']);
// Options every agent command accepts. Path options, --quiet, and options that merge or bypass worktrees stay off every list.
const AGENT = ['first', 'base', 'instructions'];
const LOOP = ['keep-worktrees', 'retriage', 'close-skipped', 'no-close-skipped'];
export const COMMANDS = {
  listen: { label: 'Listen', description: 'Watch GitHub activity and act on review requests and mentions.', numbers: true, dryRun: true, flags: ['once'], valueFlags: ['since', 'min-number', ...AGENT] },
  review: { label: 'Review', description: 'Review open pull requests and post findings. Leave targets blank for all open PRs.', numbers: true, dryRun: true, flags: ['verdict', 'recheck'], valueFlags: ['max-rounds', 'min-number', ...AGENT] },
  checkin: { label: 'Check in', description: 'Answer PR comments and apply agreed changes.', numbers: true, dryRun: true, flags: ['reply-only', 'any-author', 'again', 'keep-worktrees'], valueFlags: ['min-number', ...AGENT] },
  run: { label: 'Run', description: 'Work issues and continue pull requests using this project’s Spar configuration.', numbers: true, flags: [...LOOP], valueFlags: ['max-rounds', 'min-number', 'absorb', ...AGENT] },
  code: { label: 'Code', description: 'Turn a project prompt into a detailed issue, then implement and review it as a pull request. Requires Spar 0.4.25 or newer.', prompt: true, dryRun: true, flags: ['file-only', ...LOOP], valueFlags: ['max-rounds', 'absorb', ...AGENT] },
  triage: { label: 'Triage', description: 'Triage open issues and write a local plan.', numbers: true, valueFlags: ['min-number', ...AGENT] },
  resume: { label: 'Resume', description: 'Continue the implementation and review loop on existing PRs.', numbers: true, flags: ['keep-worktrees'], valueFlags: ['next', 'max-rounds', 'min-number', 'absorb', ...AGENT] },
  brainstorm: { label: 'Brainstorm', description: 'Explore ideas and save the session locally.', topic: true, flags: ['file-issues'], valueFlags: ['max-rounds', 'ideas', ...AGENT] },
  followup: { label: 'Follow up', description: 'Work the follow-up queue recorded by Spar.', flags: ['screen-only', 'file-only', ...LOOP], valueFlags: ['max-rounds', 'absorb', ...AGENT] },
  split: { label: 'Split', description: 'Break issues or pull requests into smaller pieces.', numbers: true, dryRun: true, flags: ['again'], valueFlags: ['min-number', ...AGENT] },
  doctor: { label: 'Doctor', description: 'Check prerequisites and the project’s configured tools.' },
  init: { label: 'Initialize', description: 'Create spar.toml, or append missing options as comments with Update. Existing settings are preserved.', flags: ['update'] },
  clean: { label: 'Clean', description: 'Clean up Spar worktrees and state for completed pull requests.' },
};
export const defaultDataDir = () => process.env.SPAR_DECK_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'Spar Deck');
export const id = () => crypto.randomUUID();
export function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function inside(root, target) { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
export function resolveDirectory(root, input = root) {
  const resolved = fs.realpathSync(path.resolve(input));
  if (!inside(root, resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('Choose a folder inside your configured project root.');
  return resolved;
}
const integer = { test: value => /^[1-9]\d{0,5}$/.test(String(value)), hint: 'Use a whole number from 1 to 999999.' };
// Text values must arrive as strings so that true or an array cannot pass as a word.
const agent = { test: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value), hint: 'Use an agent key from spar.toml, such as codex.' };
const VALUE_RULES = {
  since: { test: value => /^\d+[smhd]$/.test(String(value)), hint: 'Use a duration such as 2h.' },
  'max-rounds': integer, 'min-number': integer, ideas: integer, absorb: integer,
  first: agent, next: agent,
  base: { test: value => typeof value === 'string' && /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,254}$/.test(value) && !value.includes('..'), hint: 'Use a branch name without spaces, "..", or a leading dash.' },
  instructions: { test: value => typeof value === 'string' && value.length <= 4000 && !value.startsWith('-') && !value.includes('\0'), hint: 'Use up to 4,000 characters that do not start with a dash.' },
};
export function buildArgs(command, input = {}) {
  if (!Object.hasOwn(COMMANDS, command)) throw new Error('Unknown Spar command.');
  const spec = COMMANDS[command];
  const args = [command];
  if (input.targets) {
    if (!spec.numbers || typeof input.targets !== 'string' || !/^\s*#?[1-9]\d*(?:[\s,]+#?[1-9]\d*)*\s*$/.test(input.targets)) throw new Error('Use positive issue or PR numbers separated by spaces or commas.');
    args.push(...input.targets.trim().split(/[\s,]+/).map(n => n.replace(/^#/, '')));
  }
  if (input.topic) {
    if (!spec.topic || typeof input.topic !== 'string' || input.topic.length > 4000 || input.topic.startsWith('-') || input.topic.includes('\0')) throw new Error('Enter a topic of up to 4,000 characters that does not start with a dash.');
    args.push(input.topic);
  }
  if (spec.prompt) {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000 || input.prompt.includes('\0')) throw new Error('Describe what to build, fix, or improve in 1 to 4,000 characters.');
  } else if (input.prompt !== undefined) throw new Error('This command does not accept a project prompt.');
  if (input.dryRun && input.flags?.['file-only']) throw new Error('Choose either dry run or file only.');
  if (input.dryRun) { if (!spec.dryRun) throw new Error('This command does not support dry run.'); args.push('--dry-run'); }
  for (const [flag, value] of Object.entries(input.flags || {})) {
    if (value === false || value === '' || value == null) continue;
    if (spec.flags?.includes(flag) && value === true) args.push(`--${flag}`);
    else if (spec.valueFlags?.includes(flag)) {
      if (!VALUE_RULES[flag].test(value)) throw new Error(`Invalid ${flag}. ${VALUE_RULES[flag].hint}`);
      args.push(`--${flag}`, String(value));
    } else throw new Error(`Unsupported option: ${flag}`);
  }
  if (input.flags?.['screen-only'] && input.flags?.['file-only']) throw new Error('Choose either screen only or file only.');
  if (input.flags?.['close-skipped'] && input.flags?.['no-close-skipped']) throw new Error('Choose either close skipped issues or leave them open.');
  if (input.limit) {
    if (['doctor', 'init', 'clean', 'code'].includes(command) || !/^[1-9]\d{0,5}$/.test(String(input.limit))) throw new Error('Invalid item limit.');
    args.push('--limit', String(input.limit));
  }
  // End option parsing before the prompt so pasted flags remain request text.
  if (spec.prompt) args.push('--', input.prompt);
  return args;
}
export function socketPath(dataDir, jobId) {
  const hash = crypto.createHash('sha256').update(`${dataDir}:${jobId}`).digest('hex').slice(0, 32);
  return path.join(os.tmpdir(), `spar-deck-${process.getuid?.() || 0}`, `${hash}.sock`);
}
export function tailFile(file, limit = 64 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const size = fs.fstatSync(fd).size; const data = Buffer.alloc(Math.min(size, limit)); fs.readSync(fd, data, 0, data.length, Math.max(0, size - data.length)); return data.toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
