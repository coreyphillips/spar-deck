// Turns an `origin` URL into a github.com web address. The address is rebuilt from the owner
// and repository names alone, so credentials in a remote never reach the browser.
const PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:']);
// Git reads `host:path` as SSH only when no slash comes before the colon.
const SCP = /^(?:[^@/]+@)?([^@/:]+):(.+)$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/, REPOSITORY = /^[A-Za-z0-9._-]+$/;

export function githubRepository(remote) {
  if (typeof remote !== 'string') return null;
  const text = remote.trim();
  let host, pathname;
  if (text.includes('://')) {
    let url;
    try { url = new URL(text); } catch { return null; }
    if (!PROTOCOLS.has(url.protocol) || url.search || url.hash) return null;
    // Hosts in ssh: and other non-web URLs keep their case.
    host = url.hostname; pathname = url.pathname;
  } else {
    const match = text.match(SCP);
    if (!match) return null;
    [, host, pathname] = match;
  }
  if (host.toLowerCase() !== 'github.com') return null;
  const parts = pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, repository] = parts;
  if (!OWNER.test(owner) || !REPOSITORY.test(repository) || /^\.+$/.test(repository)) return null;
  return `https://github.com/${owner}/${repository}`;
}

// An empty branch means a detached HEAD, which links to the repository home page.
export function githubBranchUrl(remote, branch) {
  const repository = githubRepository(remote);
  if (!repository || !branch) return repository;
  return `${repository}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
}
