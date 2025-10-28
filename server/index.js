import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const ROOT = process.cwd();
const CONFIG_PATH = resolvePath(ROOT, 'wallets.json');
const WATCH_SCRIPT = resolvePath(ROOT, 'src', 'watch.mjs');

let watcherProc = null;

function startWatcher(args = []) {
  if (watcherProc) return { ok: false, message: 'already running' };
  const spawnArgs = [WATCH_SCRIPT, '--config=wallets.json', ...args];
  watcherProc = spawn('node', spawnArgs, { cwd: ROOT, stdio: 'inherit' });
  watcherProc.on('exit', (code) => { console.log('watcher exited', code); watcherProc = null; });
  return { ok: true };
}
function stopWatcher() {
  if (!watcherProc) return { ok: false, message: 'not running' };
  watcherProc.kill('SIGINT');
  watcherProc = null;
  return { ok: true };
}
function statusWatcher() { return { running: !!watcherProc }; }

async function readConfig() {
  if (!existsSync(CONFIG_PATH)) return [];
  const raw = await readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}
async function writeConfig(data) {
  await writeFile(CONFIG_PATH, JSON.stringify(data, null, 2));
}

app.get('/api/status', (_, res) => res.json(statusWatcher()));
app.post('/api/watcher/start', async (req, res) => {
  const { only, interval, usdDelta, concurrency } = req.body || {};
  const args = [];
  if (only) args.push(`--only=${only}`);
  if (interval) args.push(`--interval=${interval}`);
  if (usdDelta) args.push(`--usdDelta=${usdDelta}`);
  if (concurrency) args.push(`--concurrency=${concurrency}`);
  const r = startWatcher(args);
  res.json(r);
});
app.post('/api/watcher/stop', async (_, res) => res.json(stopWatcher()));

app.get('/api/wallets', async (_, res) => {
  try { res.json(await readConfig()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/wallets', async (req, res) => {
  try { await writeConfig(req.body || []); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`server listening on http://localhost:${port}`));
