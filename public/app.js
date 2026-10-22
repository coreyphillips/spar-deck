const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/>',
  terminal: '<path d="m5 6 6 6-6 6M13 18h6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  grip: '<circle cx="9" cy="5" r=".7"/><circle cx="15" cy="5" r=".7"/><circle cx="9" cy="12" r=".7"/><circle cx="15" cy="12" r=".7"/><circle cx="9" cy="19" r=".7"/><circle cx="15" cy="19" r=".7"/>',
  branch: '<path d="M6 6v12M18 6v3a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3"/><circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="4" r="2"/>',
  review: '<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  sliders: '<path d="M4 7h4m4 0h8M4 17h8m4 0h4"/><circle cx="10" cy="7" r="2"/><circle cx="14" cy="17" r="2"/>',
  folder: '<path d="M3 7V5h7l2 3h9v12H3V7Z"/>',
  play: '<path d="m7 4 13 8-13 8V4Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.terminal}</svg>`;
$$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const activeStatuses = new Set(['starting', 'running', 'stopping', 'unresponsive']);
let state = { projects: [], jobs: [], commands: {} }, filter = 'all', view = 'projects', query = '', signature = '', connected = false;
let commandProject, currentFolder, selectedLog, removeId, draggedId, toastTimer, refreshing = false;
const busyProjects = new Set();
const latest = project => state.jobs.find(j => j.projectId === project.id);
const isActive = job => job && activeStatuses.has(job.status);
const statusLabel = job => !job ? 'Ready' : job.status === 'running' ? job.command === 'listen' ? 'Listening' : 'Working' : ({ completed: 'Completed', stopped: 'Stopped', starting: 'Starting', stopping: 'Stopping', failed: 'Failed', interrupted: 'Interrupted', unresponsive: 'Needs attention' }[job.status] || job.status);
const time = value => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function relative(value) {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 3500);
}
async function api(url, method = 'GET', data) {
  const response = await fetch(url, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Deck-Token': state.token }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Something went wrong.'); return result;
}
async function action(fn) { try { await fn(); } catch (error) { toast(error.message, true); } }
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await api('/api/state'); state = next; connected = true;
    $('#connection-label').textContent = 'Background service online'; $('#connection-dot').classList.remove('offline');
    const nextSignature = JSON.stringify({ projects: next.projects, jobs: next.jobs.map(({ heartbeat, ...rest }) => rest) });
    if ((force || nextSignature !== signature) && !draggedId) { signature = nextSignature; render(); }
    if ($('#logs-dialog').open && selectedLog) await refreshLog();
  } catch (error) {
    connected = false; $('#connection-label').textContent = 'Reconnecting to service'; $('#connection-dot').classList.add('offline');
    $('#footer-status').textContent = 'Service offline. Started runs may still be working.';
    if (!state.token) $('#projects').innerHTML = `<div class="empty-state">${icon('radio')}<h2>Waiting for your deck.</h2><p>The local service is not available yet. This page will reconnect automatically.</p></div>`;
  } finally { refreshing = false; }
}
function render() {
  const active = state.projects.filter(p => isActive(latest(p)));
  const attention = state.projects.filter(p => !p.available || !p.configured || ['failed', 'interrupted', 'unresponsive'].includes(latest(p)?.status));
  $('#project-count').textContent = state.projects.length; $('#history-count').textContent = state.jobs.length;
  $('#total-value').textContent = state.projects.length;
  $('#listening-value').textContent = active.filter(p => latest(p).command === 'listen').length;
  $('#working-value').textContent = active.filter(p => latest(p).command !== 'listen').length;
  $('#all-count').textContent = state.projects.length; $('#active-count').textContent = active.length; $('#attention-count').textContent = attention.length;
  $('#page-title').textContent = view === 'projects' ? 'Everything on deck.' : 'Every run, in one place.';
  $('#page-description').textContent = view === 'projects' ? 'Your projects. Your pace. Spar keeps things moving.' : 'Pick up the thread. See what ran, what finished, and what needs you.';
  $('#page-name').textContent = view === 'projects' ? 'Projects' : 'Run history';
  $('#list-label').textContent = view === 'projects' ? 'YOUR PROJECTS' : 'RECENT RUNS';
  $('#arrange-hint').hidden = view !== 'projects'; $('#projects').hidden = view !== 'projects'; $('#history').hidden = view !== 'activity';
  $('.tabs').hidden = view !== 'projects';
  $('#footer-status').textContent = 'Layout saved automatically';
  $$('[data-view]').forEach(el => el.classList.toggle('selected', el.dataset.view === view));
  $$('[data-filter]').forEach(el => el.classList.toggle('active', el.dataset.filter === filter));
  const matches = p => `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase());
  const shown = state.projects.filter(p => matches(p) && (filter === 'all' || (filter === 'active' ? active : attention).includes(p)));
  const focused = document.activeElement?.closest('[data-project]');
  const focusProject = focused?.dataset.project, focusAction = focused?.dataset.action;
  $('#projects').innerHTML = shown.map(card).join('') + (filter === 'all' && !query && state.projects.length ? `<button class="add-card" data-action="add"><span class="add-symbol">${icon('plus')}</span><strong>Something else on your mind?</strong><span>Add another project to your deck</span></button>` : '');
  if (!shown.length) $('#projects').innerHTML = `<div class="empty-state">${icon(state.projects.length ? 'search' : 'layers')}<h2>${state.projects.length ? 'A little quiet here.' : 'Your next project belongs here.'}</h2><p>${state.projects.length ? 'No projects match this view. Try another filter or search.' : 'Bring a project onto your deck to listen, review, and run Spar.<br>Your layout and run history will be right here when you return.'}</p>${!state.projects.length ? '<button class="button primary" data-action="add">Add your first project</button>' : ''}</div>`;
  if (focusProject && focusAction && !document.querySelector('dialog[open]')) $(`[data-project="${focusProject}"][data-action="${focusAction}"]`)?.focus({ preventScroll: true });
  const jobs = state.jobs.filter(j => `${j.projectName} ${j.command}`.toLowerCase().includes(query.toLowerCase()));
  $('#history').innerHTML = jobs.length ? jobs.map(j => `<button class="history-row" data-job="${j.id}"><span class="project-avatar">${icon(j.command === 'listen' ? 'radio' : 'terminal')}</span><span class="history-info"><strong>${esc(j.projectName)}</strong><code>${esc(`spar ${j.args.join(' ')}`)}</code></span><span class="badge ${esc(j.status)}">${statusLabel(j)}</span><time>${time(j.createdAt)}</time>${icon('chevron')}</button>`).join('') : `<div class="empty-state">${icon('activity')}<h2>A fresh page.</h2><p>Your command history will appear here after your first run.</p></div>`;
}
function card(project) {
  const job = latest(project), running = isActive(job), busy = busyProjects.has(project.id);
  const status = !project.available ? 'Unavailable' : running ? statusLabel(job) : !project.configured ? 'Setup needed' : ['failed', 'interrupted', 'unresponsive'].includes(job?.status) ? statusLabel(job) : 'Ready';
  const statusClass = !project.available ? 'unavailable' : running ? job.command === 'listen' ? 'listening' : 'working' : ['failed', 'interrupted', 'unresponsive'].includes(job?.status) ? job.status : '';
  const disabled = !connected || !project.available || busy;
  const relativePath = project.path.startsWith(state.root) ? `${state.root.split('/').pop()}${project.path.slice(state.root.length)}` : project.path;
  const tone = [...project.name].reduce((n, c) => n + c.charCodeAt(0), 0) % 5;
  return `<article class="project-card" data-card="${project.id}"><div class="card-body"><div class="card-top"><span class="project-avatar tone-${tone}">${esc(project.name.slice(0, 2).toUpperCase())}</span><span class="badge ${statusClass}">${status}</span><button class="icon-button grip" draggable="true" data-drag="${project.id}" aria-label="Drag ${esc(project.name)} to reorder" title="Drag to reorder">${icon('grip')}</button></div><h2 class="card-title" title="${esc(project.name)}">${esc(project.name)}</h2><p class="card-path" title="${esc(project.path)}">${esc(relativePath)}</p><div class="branch-row">${icon('branch')}<span>${esc(project.branch || 'folder unavailable')}</span><span class="config-state ${project.configured ? '' : 'needs-setup'}">${icon(project.configured ? 'check' : 'sliders')}${project.configured ? 'Configured' : 'Needs config'}</span></div><div class="run-preview ${running ? 'is-active' : ''}"><div class="preview-command">${icon('terminal')}${job ? esc(`spar ${job.args.join(' ')}`) : 'Ready when you are.'}</div><div class="preview-meta">${job ? `${statusLabel(job)} · ${running ? 'started' : 'updated'} ${relative(job.endedAt || job.createdAt)}` : 'Start listening or choose your next command.'}</div></div><div class="card-actions">${running ? `<button class="button danger" data-action="stop" data-project="${project.id}" ${busy || job.status === 'starting' || job.status === 'stopping' ? 'disabled' : ''}>${icon('stop')}${job.status === 'stopping' ? 'Stopping…' : 'Stop run'}</button>` : `<button class="button listen-button" data-action="${project.configured ? 'listen' : 'init'}" data-project="${project.id}" ${disabled ? 'disabled' : ''}>${icon(project.configured ? 'radio' : 'plus')}${project.configured ? 'Listen' : 'Initialize'}</button>`}<button class="button" data-action="${running ? 'logs' : 'review'}" data-project="${project.id}" ${disabled || (!running && !project.configured) ? 'disabled' : ''}>${icon(running ? 'terminal' : 'review')}${running ? 'Live output' : 'Review'}</button><button class="button more-button" data-action="commands" data-project="${project.id}" aria-label="More commands for ${esc(project.name)}" title="Command options" ${disabled || running ? 'disabled' : ''}>${icon('more')}</button></div></div><div class="card-footer"><button class="text-button" data-action="logs" data-project="${project.id}" ${job ? '' : 'disabled'}>${job ? 'View run history' : 'No runs yet'}${job ? icon('arrow') : ''}</button><div><button class="icon-button" data-action="left" data-project="${project.id}" aria-label="Move ${esc(project.name)} earlier" title="Move earlier">${icon('left')}</button><button class="icon-button" data-action="right" data-project="${project.id}" aria-label="Move ${esc(project.name)} later" title="Move later">${icon('right')}</button><button class="icon-button" data-action="remove" data-project="${project.id}" aria-label="Remove ${esc(project.name)} card" title="Remove card" ${running ? 'disabled' : ''}>${icon('x')}</button></div></div></article>`;
}
async function openPicker(directory = state.root) { $('#picker-dialog').showModal(); await browse(directory); }
async function browse(directory) {
  const result = await api(`/api/browse?path=${encodeURIComponent(directory)}`); currentFolder = result.path;
  const parts = result.path.slice(state.root.length).split('/').filter(Boolean);
  const crumbs = [{ name: state.root.split('/').pop(), path: state.root }];
  parts.forEach((part, index) => crumbs.push({ name: part, path: `${state.root}/${parts.slice(0, index + 1).join('/')}` }));
  $('#folder-breadcrumb').innerHTML = crumbs.map(c => `<button data-folder="${esc(c.path)}">${esc(c.name)}</button>`).join('<span>/</span>');
  const added = state.projects.some(p => p.path === result.path);
  $('#add-current').hidden = !result.repository || added;
  $('#folder-selection').textContent = added ? 'Already on your deck.' : result.repository ? 'Git repository selected.' : 'Browse a folder to find your projects.';
  $('#folder-list').innerHTML = result.entries.map(entry => {
    const existing = state.projects.some(p => p.path === entry.path);
    return `<div class="folder-row">${icon(entry.repository ? 'branch' : 'folder')}<button class="folder-open" data-folder="${esc(entry.path)}"><strong>${esc(entry.name)}</strong><small>${entry.repository ? entry.configured ? 'Git repository · Spar configured' : 'Git repository' : 'Folder'}</small></button>${entry.repository ? `<button class="button small" data-add-path="${esc(entry.path)}" ${existing ? 'disabled' : ''}>${existing ? 'Added' : '+ Add'}</button>` : icon('chevron')}</div>`;
  }).join('') || '<p class="folder-empty">No subfolders here. If this is a Git repository, add it using the button below.</p>';
}
async function addProject(directory) {
  await api('/api/projects', 'POST', { path: directory }); await refresh(true); await browse(currentFolder); toast('Project added to your deck.');
}
function openCommand(project, command = 'listen') {
  commandProject = project; $('#command-project').textContent = project.name;
  $('#command-select').innerHTML = Object.entries(state.commands).map(([key, spec]) => `<option value="${key}">${esc(spec.label)}</option>`).join('');
  $('#command-select').value = command; commandFields(); $('#command-dialog').showModal();
}
function commandFields() {
  const command = $('#command-select').value, spec = state.commands[command];
  $('#command-description').textContent = spec.description;
  $('#command-fields').innerHTML = `${spec.numbers ? '<label class="field">Issue or PR numbers <input name="targets" placeholder="All open items, or e.g. 42, 108" autocomplete="off"></label>' : ''}${spec.topic ? '<label class="field">Topic <input name="topic" maxlength="4000" placeholder="What would you like to explore?"></label>' : ''}${spec.dryRun ? '<label class="checkbox-field"><input type="checkbox" name="dryRun"> Dry run: preview without posting or pushing</label>' : ''}${(spec.flags || []).map(flag => `<label class="checkbox-field"><input type="checkbox" name="flag:${flag}"> ${esc({ once: 'Poll once and exit', verdict: 'Submit a formal approval or change request', recheck: 'Recheck previous findings', 'reply-only': 'Reply without changing code', 'screen-only': 'Screen the queue without writing', 'file-only': 'File issues without implementing' }[flag])}</label>`).join('')}<div class="advanced-options">${!['doctor', 'init', 'clean', 'brainstorm'].includes(command) ? '<label class="field">Item limit <input name="limit" type="number" min="1" max="999999" placeholder="20 (Spar default)"></label>' : ''}${(spec.valueFlags || []).map(flag => `<label class="field">${esc({ since: 'Look back on first run', 'max-rounds': 'Maximum rounds', ideas: 'Ideas to keep' }[flag])}<input name="flag:${flag}" ${flag === 'since' ? 'placeholder="e.g. 2h"' : 'type="number" min="1" max="999999" placeholder="Use Spar default"'}></label>`).join('')}</div>`;
  commandPreview();
}
function commandInput() {
  const data = new FormData($('#command-form')); const input = { command: data.get('command'), flags: {} };
  for (const [key, value] of data.entries()) {
    if (key.startsWith('flag:')) input.flags[key.slice(5)] = value === 'on' ? true : value;
    else if (key === 'dryRun') input.dryRun = true;
    else if (value) input[key] = value;
  }
  return input;
}
function commandPreview() {
  const input = commandInput();
  const bits = ['spar', input.command, input.targets || '', input.topic ? JSON.stringify(input.topic) : '', input.dryRun ? '--dry-run' : '', input.limit ? `--limit ${input.limit}` : ''];
  for (const [flag, value] of Object.entries(input.flags)) if (value) bits.push(`--${flag}${value === true ? '' : ` ${value}`}`);
  $('#command-preview').textContent = bits.filter(Boolean).join(' ');
}
async function run(project, input) {
  if (busyProjects.has(project.id)) return;
  busyProjects.add(project.id); render();
  try {
    const job = await api('/api/jobs', 'POST', { projectId: project.id, ...input });
    $('#command-dialog').close(); await refresh(true); toast(`${state.commands[input.command].label} started for ${project.name}.`);
    if (input.command === 'doctor' || input.command === 'init') await openLogs(job.id);
  } finally { busyProjects.delete(project.id); render(); }
}
async function stop(job) { await api(`/api/jobs/${job.id}/stop`, 'POST', {}); toast('Stop requested. Spar is cleaning up.'); await refresh(true); }
async function openLogs(jobId) {
  selectedLog = jobId; const job = state.jobs.find(j => j.id === jobId); if (!job) return;
  $('#log-project').textContent = job.projectName; $('#log-title').textContent = 'A closer look.';
  $('#log-run-select').innerHTML = state.jobs.filter(j => j.projectId === job.projectId).map(j => `<option value="${j.id}">${esc(`spar ${j.args.join(' ')} · ${time(j.createdAt)}`)}</option>`).join('');
  $('#log-run-select').value = jobId; $('#follow-log').checked = true; $('#log-output').textContent = 'Loading output…';
  $('#logs-dialog').showModal(); await refreshLog();
}
async function refreshLog() {
  const requested = selectedLog;
  const result = await api(`/api/jobs/${requested}/log`);
  if (selectedLog !== requested || !$('#logs-dialog').open) return;
  const output = result.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
  if ($('#log-output').textContent !== output) {
    $('#log-output').textContent = output || 'Waiting for Spar output…';
    if ($('#follow-log').checked) $('#log-output').scrollTop = $('#log-output').scrollHeight;
  }
  $('#log-status').textContent = statusLabel(result.job); $('#log-status').className = `badge ${result.job.status}`;
  $('#stop-log').hidden = !isActive(result.job); $('#stop-log').disabled = ['starting', 'stopping'].includes(result.job.status);
}
async function reorder(ids) { await api('/api/order', 'PUT', { ids }); await refresh(true); }
function about() {
  $('#about-content').innerHTML = `<span class="about-version">Spar Deck 1.0 · ${esc(state.version)}</span><h3>Close the tab. Keep the momentum.</h3><p>Each command runs in its own background supervisor. Closing this page or restarting the web service leaves your runs working. Open the deck again to reconnect.</p><h3>One command per project</h3><p>Stop a listener before running a manual command on the same project. This keeps Spar’s shared state and worktrees from competing. Other projects run independently.</p><h3>Saved on this Mac</h3><p>Your cards, their order, and run history live in <code>${esc(state.dataDir)}</code>. Each run keeps up to two 2 MB log segments. A reboot ends active commands; they are marked interrupted and can be started again from a card.</p><h3>Project root</h3><p><code>${esc(state.root)}</code></p><h3>Background service</h3><p>The included macOS login service keeps the dashboard available and starts it when you sign in. Use <code>npm run service:status</code> from the Spar Deck folder to check it.</p><h3>Your existing Spar configuration</h3><p>Commands use each project’s <code>spar.toml</code> and your installed tools. Listen can trigger reviews and check-ins. Review posts findings unless you choose a dry run in command options.</p>`;
  $('#about-dialog').showModal();
}
// Delegation keeps controls working through live status updates.
document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]'); if (close) $(`#${close.dataset.close}`).close();
  const nav = event.target.closest('[data-view]'); if (nav) { view = nav.dataset.view; render(); }
  const tab = event.target.closest('[data-filter]'); if (tab) { filter = tab.dataset.filter; render(); }
  const folder = event.target.closest('[data-folder]'); if (folder) action(() => browse(folder.dataset.folder));
  const add = event.target.closest('[data-add-path]'); if (add) action(() => addProject(add.dataset.addPath));
  const job = event.target.closest('[data-job]'); if (job) action(() => openLogs(job.dataset.job));
  const button = event.target.closest('[data-action]'); if (!button) return;
  const project = state.projects.find(p => p.id === button.dataset.project);
  action(async () => {
    switch (button.dataset.action) {
      case 'add': return openPicker();
      case 'listen': case 'review': case 'init': return run(project, { command: button.dataset.action });
      case 'commands': return openCommand(project);
      case 'logs': return openLogs(latest(project).id);
      case 'stop': return stop(latest(project));
      case 'remove': removeId = project.id; $('#remove-description').textContent = `${project.name} will leave your dashboard. Its files and saved run history will stay on this Mac.`; return $('#remove-dialog').showModal();
      case 'left': case 'right': {
        const ids = state.projects.map(p => p.id); const index = ids.indexOf(project.id), next = index + (button.dataset.action === 'left' ? -1 : 1);
        if (next < 0 || next >= ids.length) return;
        [ids[index], ids[next]] = [ids[next], ids[index]]; return reorder(ids);
      }
    }
  });
});
$('#confirm-remove').addEventListener('click', () => action(async () => { await api(`/api/projects/${removeId}`, 'DELETE'); $('#remove-dialog').close(); await refresh(true); toast('Card removed. Your project files are untouched.'); }));
$('#add-project').addEventListener('click', () => action(() => openPicker()));
$('#add-current').addEventListener('click', () => action(() => addProject(currentFolder)));
$('#settings-button').addEventListener('click', about);
$('#mobile-about').addEventListener('click', about);
$('#search').addEventListener('input', event => { query = event.target.value; render(); });
$('#command-select').addEventListener('change', commandFields);
$('#command-form').addEventListener('input', commandPreview);
$('#command-form').addEventListener('submit', event => { event.preventDefault(); action(() => run(commandProject, commandInput())); });
$('#log-run-select').addEventListener('change', event => { selectedLog = event.target.value; $('#log-output').textContent = ''; action(refreshLog); });
$('#stop-log').addEventListener('click', () => action(() => stop(state.jobs.find(j => j.id === selectedLog))));
$('#copy-log').addEventListener('click', () => action(async () => { await navigator.clipboard.writeText($('#log-output').textContent); toast('Output copied.'); }));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
document.addEventListener('keydown', event => {
  if (event.key === 'k' && (event.metaKey || event.ctrlKey) || event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    if (!document.querySelector('dialog[open]')) { event.preventDefault(); $('#search').focus(); }
  }
});
$('#projects').addEventListener('dragstart', event => {
  const grip = event.target.closest('[data-drag]'); if (!grip) return event.preventDefault();
  draggedId = grip.dataset.drag; event.dataTransfer.setData('text/plain', draggedId); event.dataTransfer.effectAllowed = 'move';
  const card = grip.closest('.project-card'); event.dataTransfer.setDragImage(card, 30, 25); card.classList.add('dragging');
});
$('#projects').addEventListener('dragover', event => {
  const card = event.target.closest('[data-card]'); if (draggedId && card) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; $$('.drop-target').forEach(el => el.classList.remove('drop-target')); card.classList.add('drop-target'); }
});
$('#projects').addEventListener('drop', event => {
  event.preventDefault(); const target = event.target.closest('[data-card]')?.dataset.card;
  if (target && draggedId && target !== draggedId) {
    const ids = state.projects.map(p => p.id); const from = ids.indexOf(draggedId), to = ids.indexOf(target); ids.splice(from, 1); ids.splice(to, 0, draggedId);
    draggedId = null; action(() => reorder(ids));
  }
});
$('#projects').addEventListener('dragend', () => { draggedId = null; $$('.dragging,.drop-target').forEach(el => el.classList.remove('dragging', 'drop-target')); });
refresh(); setInterval(refresh, 2000);
