import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { defaultDataDir } from '../src/core.mjs';

if (process.platform !== 'darwin') throw new Error('The login service installer currently supports macOS. Run npm start on other systems.');
const command = process.argv[2] || 'status';
const label = 'local.spar-deck';
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.resolve(defaultDataDir());
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
function run(args) { return spawnSync('/bin/launchctl', args, { encoding: 'utf8' }); }
function running() { return run(['print', service]).status === 0; }
if (command === 'install') {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true }); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const environment = { PATH: process.env.PATH, SPAR_DECK_DATA: data, SPAR_DECK_PORT: process.env.SPAR_DECK_PORT || '4177', SPAR_DECK_ROOT: process.env.SPAR_DECK_ROOT || path.join(os.homedir(), 'Documents') };
  // launchd does not load shell profiles, so retain the tool paths used at installation.
  if (process.env.SPAR_BIN) environment.SPAR_BIN = process.env.SPAR_BIN;
  const envXML = Object.entries(environment).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(project, 'src/server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>EnvironmentVariables</key><dict>${envXML}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(data, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(data, 'service-error.log'))}</string>
</dict></plist>\n`;
  if (running()) { const result = run(['bootout', service]); if (result.status !== 0) throw new Error(result.stderr); }
  fs.writeFileSync(plistPath, plist, { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', plistPath], { stdio: 'inherit' });
  const result = run(['bootstrap', domain, plistPath]); if (result.status !== 0) throw new Error(result.stderr || 'Unable to install the login service.');
  console.log(`Spar Deck starts at login and is available at http://127.0.0.1:${environment.SPAR_DECK_PORT}`);
  console.log(`Service: ${plistPath}\nLogs and saved data: ${data}`);
} else if (command === 'uninstall') {
  if (running()) { const result = run(['bootout', service]); if (result.status !== 0) throw new Error(result.stderr); }
  fs.rmSync(plistPath, { force: true });
  console.log('Login service removed. Project cards, logs, and active Spar runs are preserved. Stop runs from the dashboard before uninstalling if you want them ended.');
} else if (command === 'status') {
  const result = run(['print', service]);
  if (result.status !== 0) { console.log('Spar Deck login service is not loaded.'); process.exitCode = 1; }
  else console.log(result.stdout.split('\n').filter(line => /state =|pid =|path =|last exit code =/.test(line)).join('\n'));
} else throw new Error('Use install, uninstall, or status.');
