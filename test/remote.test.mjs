import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRepository, githubBranchUrl } from '../src/remote.mjs';

const HOME = 'https://github.com/owner/repo';

test('github.com remotes in every form Git uses map to the repository page', () => {
  const remotes = [
    'git@github.com:owner/repo.git', 'git@github.com:owner/repo', 'github.com:owner/repo.git', 'git@github.com:/owner/repo.git',
    'ssh://git@github.com/owner/repo.git', 'ssh://git@github.com:22/owner/repo', 'git+ssh://git@github.com/owner/repo.git',
    'https://github.com/owner/repo', 'https://github.com/owner/repo.git', 'https://github.com/owner/repo/', 'http://github.com/owner/repo.git',
    'git://github.com/owner/repo.git', 'git@GitHub.com:owner/repo.git', 'ssh://git@GITHUB.COM/owner/repo.git', 'https://GitHub.com/owner/repo.git',
    '  git@github.com:owner/repo.git\n',
  ];
  for (const remote of remotes) assert.equal(githubRepository(remote), HOME, remote);
  assert.equal(githubRepository('git@github.com:Some-Org/my.repo_2.git'), 'https://github.com/Some-Org/my.repo_2');
  assert.equal(githubRepository('https://github.com/owner/repo.git.git'), 'https://github.com/owner/repo.git', 'only one .git suffix is removed');
});

test('credentials in a remote never reach the web address', () => {
  for (const remote of ['https://user:ghp_secret@github.com/owner/repo.git', 'https://ghp_secret@github.com/owner/repo', 'ssh://user:ghp_secret@github.com/owner/repo.git', 'x-access-token:ghp_secret@github.com:owner/repo.git']) {
    const url = githubBranchUrl(remote, 'main');
    assert.equal(url, `${HOME}/tree/main`, remote);
    assert(!url.includes('secret') && !url.includes('user'), remote);
  }
});

test('other hosts and malformed remotes have no web address', () => {
  const remotes = [
    undefined, null, 42, '', '   ', 'not a remote', '/Users/me/repo', '../repo', 'file:///github.com/owner/repo', 'file:///Users/me/repo.git',
    'git@gitlab.com:owner/repo.git', 'https://bitbucket.org/owner/repo.git', 'https://github.example.com/owner/repo.git', 'git@ghe.internal:owner/repo.git',
    'https://github.com.evil.example/owner/repo', 'https://evil.example/github.com/owner/repo', 'git@evil.example:github.com/owner/repo', 'https://www.github.com/owner/repo',
    'https://github.com/owner', 'https://github.com/', 'https://github.com/owner/repo/tree/main', 'git@github.com:owner', 'git@github.com:',
    'https://github.com/owner/repo?ref=main', 'https://github.com/owner/repo#readme', 'https://github.com/own%65r/repo', 'https://github.com/owner/..',
    'https://github.com/owner/.git', 'https://github.com/-owner/repo', 'https://github.com/owner/re"po', 'ftp://github.com/owner/repo', 'javascript://github.com/owner/repo',
    'github.com/owner/repo',
  ];
  for (const remote of remotes) {
    assert.equal(githubRepository(remote), null, String(remote));
    assert.equal(githubBranchUrl(remote, 'main'), null, String(remote));
  }
});

test('branch names become a tree path with each segment escaped', () => {
  const remote = 'git@github.com:owner/repo.git';
  const cases = [
    ['main', `${HOME}/tree/main`], ['master', `${HOME}/tree/master`], ['feature/x', `${HOME}/tree/feature/x`],
    ['user/feature/deep-name_1.2', `${HOME}/tree/user/feature/deep-name_1.2`], ['fix#12', `${HOME}/tree/fix%2312`],
    ['a?b&c=d', `${HOME}/tree/a%3Fb%26c%3Dd`], ['100%', `${HOME}/tree/100%25`], ['café/naïve', `${HOME}/tree/caf%C3%A9/na%C3%AFve`],
    ['quote"tag<', `${HOME}/tree/quote%22tag%3C`], ['detached', `${HOME}/tree/detached`],
  ];
  for (const [branch, expected] of cases) assert.equal(githubBranchUrl(remote, branch), expected, branch);
  assert.equal(githubBranchUrl(remote, ''), HOME, 'a detached HEAD links to the repository home page');
});
