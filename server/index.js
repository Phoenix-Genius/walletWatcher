import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Compute project root relative to this server file, not the current working directory
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(__dirname, '..');
const CONFIG_PATH = resolvePath(ROOT, 'wallets.json');
const WATCH_SCRIPT = resolvePath(ROOT, 'src', 'watch.mjs');

let watcherProc = null;
const logBuffer = [];
const MAX_LOG_LINES = 500;

function startWatcher(args = []) {
  if (watcherProc) return { ok: false, message: 'already running' };
  console.log('[watcher]', 'ROOT =', ROOT);
  console.log('[watcher]', 'WATCH_SCRIPT =', WATCH_SCRIPT);
  const spawnArgs = [WATCH_SCRIPT, '--config=wallets.json', ...args];
  console.log('[watcher]', 'spawn:', 'node', spawnArgs.join(' '));
  watcherProc = spawn('node', spawnArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (chunk, isErr = false) => {
    const text = chunk.toString();
    process[isErr ? 'stderr' : 'stdout'].write(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      logBuffer.push((isErr ? '[err] ' : '') + line);
      if (logBuffer.length > MAX_LOG_LINES) logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
    }
  };
  watcherProc.stdout.on('data', (c) => onData(c, false));
  watcherProc.stderr.on('data', (c) => onData(c, true));
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

app.get('/api/logs', (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
  const lines = logBuffer.slice(-limit);
  res.json({ lines });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`server listening on http://localhost:${port}`));
