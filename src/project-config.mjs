import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'smol-toml';
import { resolveDirectory } from './core.mjs';

export const MAX_CONFIG_BYTES = 64 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const revision = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function configPath(root, project) {
  const directory = resolveDirectory(root, project.path);
  if (directory !== project.path) throw fail('The project folder moved. Remove and add its card again.');
  return path.join(directory, 'spar.toml');
}

export function readConfig(root, project) {
  const file = configPath(root, project);
  let descriptor;
  try {
    // Refuse symlinks and special files, including FIFOs that would block a read.
    const entry = fs.lstatSync(file);
    if (!entry.isFile()) throw fail('The project spar.toml must be a regular file, not a symlink or directory.');
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw fail('The project spar.toml must be a regular file.');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(descriptor, buffer, length, buffer.length - length, null))) length += count;
    if (length > MAX_CONFIG_BYTES) throw fail('spar.toml is larger than the 64 KB editor limit.', 413);
    const bytes = buffer.subarray(0, length);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw fail('spar.toml must contain valid UTF-8 text.'); }
    return { content, revision: revision(bytes), exists: true, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return { content: '', revision: null, exists: false, mode: 0o600 };
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function writeConfig(root, project, input) {
  if (typeof input.content !== 'string' || !input.content.trim()) throw fail('Enter a nonempty TOML configuration.');
  if (Buffer.byteLength(input.content, 'utf8') > MAX_CONFIG_BYTES) throw fail('spar.toml is larger than the 64 KB editor limit.', 413);
  if (input.revision !== null && (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision))) throw fail('Reload the configuration before saving.');
  try { parse(input.content, { integersAsBigInt: true }); }
  catch (error) { throw fail(`Invalid TOML: ${error.message}`); }
  const current = readConfig(root, project);
  if (current.revision !== input.revision) throw fail('spar.toml changed on disk. Copy your edits, then reload the file before saving.', 409);
  const file = configPath(root, project);
  const temporary = path.join(path.dirname(file), `.spar-config-${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, input.content, 'utf8');
    fs.fchmodSync(descriptor, current.mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    // Recheck just before replacement. Creation uses an exclusive hard link so
    // an independently created configuration can never be overwritten here.
    if (readConfig(root, project).revision !== current.revision) throw fail('spar.toml changed on disk. Copy your edits, then reload the file before saving.', 409);
    if (current.exists) fs.renameSync(temporary, file);
    else {
      try { fs.linkSync(temporary, file); }
      catch (error) { if (error.code === 'EEXIST') throw fail('spar.toml was created on disk. Reload before saving.', 409); throw error; }
    }
    return readConfig(root, project);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}
