#!/usr/bin/env node
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { JsonRpcProvider, formatUnits, getAddress, isAddress, Contract } from 'ethers';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { networks, getRpcUrl } from './networks.mjs';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

// cache: { [chainId]: { [tokenAddressLower]: { decimals, symbol } } }
const tokenMetaCache = new Map();

function usageAndExit() {
  console.error('Usage: npm run watch -- [--config=wallets.json] [<EVM_ADDRESS> ...] [--file=wallet-addresses] [--only=eth,polygon,...] [--interval=30000] [--usdDelta=0.1] [--emailTo=addr] [--concurrency=50]');
  console.error('Tips:');
  console.error(' - Preferred: provide wallets in wallets.json as [{"user":"alex","wallets":[{"label":"exodus","address":"0x...","email":"you@example.com"}]}]');
  console.error(' - Legacy: one address per line in wallet-addresses (comments supported).');
  process.exit(1);
}

const argv = process.argv.slice(2);

// Split positional args and flags
const positional = [];
const opts = {};
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v = 'true'] = a.slice(2).split('=');
    opts[k] = v;
  } else {
    positional.push(a);
  }
}

const only = opts.only ? String(opts.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
const selected = only ? networks.filter((n) => only.includes(n.key)) : networks;
const intervalMs = Math.max(5000, Number(opts.interval || 30000));
const usdDelta = Number(opts.usdDelta || 0.1); // threshold in USD
const emailTo = opts.emailTo || process.env.EMAIL_TO;
const allowErrorsForEmail = (opts.allowErrors || process.env.ALLOW_ERRORS_FOR_EMAIL || 'false') === 'true';
const concurrency = Math.max(1, Number(opts.concurrency || process.env.CONCURRENCY || 50));

// Resolve addresses: JSON config (default: ./wallets.json), legacy file (./wallet-addresses), positional
const configPath = resolvePath(process.cwd(), String(opts.config || 'wallets.json'));
const filePath = resolvePath(process.cwd(), String(opts.file || 'wallet-addresses'));
function parseAddrLabel(input) {
  const line = input.trim();
  if (!line) return null;
  // CSV style first
  const parts = line.split(',').map((s) => s.trim()).filter(Boolean);
  const isAddr = (x) => {
    try { return isAddress(x); } catch { return false; }
  };
  if (parts.length >= 2) {
    if (isAddr(parts[0])) return { address: getAddress(parts[0]), label: parts.slice(1).join(',') };
    if (isAddr(parts[parts.length - 1])) return { address: getAddress(parts[parts.length - 1]), label: parts.slice(0, -1).join(',') };
  }
  // Whitespace split fallback
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const addrIdx = tokens.findIndex((t) => isAddr(t));
    if (addrIdx >= 0) {
      const addr = getAddress(tokens[addrIdx]);
      const labelTokens = tokens.slice(0, addrIdx).concat(tokens.slice(addrIdx + 1));
      const label = labelTokens.join(' ').trim();
      return { address: addr, label };
    }
  }
  // Single token: maybe just address
  if (isAddr(line)) return { address: getAddress(line), label: '' };
  return null;
}

async function readAddressesFromFileMaybe() {
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) continue;
    const parsed = parseAddrLabel(t);
    if (!parsed) { console.warn('Skipping invalid address/line in file:', t); continue; }
    out.push(parsed); // { address, label }
  }
  return out;
}

async function readAddressesFromJsonMaybe() {
  if (!existsSync(configPath)) return [];
  try {
    const raw = await readFile(configPath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('config root must be an array');
    const out = [];
    for (const user of data) {
      const uname = typeof user?.user === 'string' ? user.user : undefined;
    const uemail = typeof user?.email === 'string' && user.email.includes('@') ? user.email : undefined;
      const wallets = Array.isArray(user?.wallets) ? user.wallets : [];
      for (const w of wallets) {
        const addr = typeof w?.address === 'string' ? w.address : '';
        if (!isAddress(addr)) { console.warn('Skipping invalid address in config:', addr); continue; }
        out.push({
          user: uname,
          label: typeof w?.label === 'string' ? w.label : undefined,
          address: getAddress(addr),
      email: (typeof w?.email === 'string' && w.email.includes('@')) ? w.email : uemail
        });
      }
    }
    return out;
  } catch (e) {
    console.error('Failed to parse wallets.json:', e?.message || e);
    return [];
  }
}

function normalizeAddresses(arr) {
  const map = new Map(); // address -> entry
  for (const raw of arr) {
    let entry = null;
    if (typeof raw === 'string') {
      const parsed = parseAddrLabel(raw);
      if (parsed && parsed.address) entry = { address: getAddress(parsed.address), label: (parsed.label || '').trim() };
    } else if (raw && raw.address) {
      entry = {
        address: getAddress(raw.address),
        label: (raw.label || '').trim() || undefined,
        user: raw.user || undefined,
        email: raw.email || undefined
      };
    }
    if (!entry || !isAddress(entry.address)) { console.warn('Skipping invalid address:', raw?.address || raw); continue; }
    const prev = map.get(entry.address) || {};
    map.set(entry.address, { address: entry.address, label: entry.label ?? prev.label, user: entry.user ?? prev.user, email: entry.email ?? prev.email });
  }
  return Array.from(map.values());
}

// nodemailer config (prefer env, else fallback to provided sample)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: (process.env.SMTP_SECURE || 'false') === 'true' ? true : false,
  auth: {
    user: process.env.SMTP_USER || 'quintonsjenna190@gmail.com',
    pass: process.env.SMTP_PASS || 'vibq abzm rmal whev'
  }
});

function withTimeout(promise, ms, label) {
  const to = new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms: ${label}`)), ms));
  return Promise.race([promise, to]);
}

// Cache providers per chain to avoid repeated handshakes per wallet
const providerCache = new Map(); // chainId -> { provider, url }

async function getProvider(net) {
  const cached = providerCache.get(net.chainId);
  if (cached) {
    try {
      await withTimeout(cached.provider.getBlockNumber(), 4000, `${net.name}@cached`);
      return cached;
    } catch { /* fallthrough to try fresh */ }
  }
  const preferred = getRpcUrl(net);
  const candidates = Array.from(new Set([preferred, ...net.rpcs]));
  for (const url of candidates) {
    try {
      const provider = new JsonRpcProvider(url, net.chainId);
      await withTimeout(provider.getBlockNumber(), 6000, `${net.name}@${url}`);
      const good = { provider, url };
      providerCache.set(net.chainId, good);
      return good;
    } catch (_) {
      continue;
    }
  }
  throw new Error(`No RPC available for ${net.name}`);
}

async function fetchAllBalances(address) {
  const out = [];
  for (const net of selected) {
    try {
      const { provider, url } = await getProvider(net);
      const native = await withTimeout(provider.getBalance(address), 8000, `${net.name}@${url}`);
      const tokens = {};
      if (net.tokens) {
        for (const [sym, tAddr] of Object.entries(net.tokens)) {
          try {
            const c = new Contract(tAddr, ERC20_ABI, provider);
            const bal = await withTimeout(c.balanceOf(address), 8000, `${net.name}:${sym}`);
            // metadata cache
            let chainCache = tokenMetaCache.get(net.chainId);
            if (!chainCache) { chainCache = {}; tokenMetaCache.set(net.chainId, chainCache); }
            const key = tAddr.toLowerCase();
            if (!chainCache[key]) {
              const [dec, rsym] = await Promise.all([
                withTimeout(c.decimals(), 8000, `${net.name}:${sym}:decimals`),
                withTimeout(c.symbol(), 8000, `${net.name}:${sym}:symbol`)
              ]);
              chainCache[key] = { decimals: Number(dec), symbol: String(rsym) };
            }
            const meta = chainCache[key];
            tokens[sym] = { raw: bal, decimals: meta.decimals, symbol: meta.symbol, formatted: formatUnits(bal, meta.decimals) };
          } catch (e) {
            tokens[sym] = { error: e?.message || String(e) };
          }
        }
      }
      out.push({ net, url, native, tokens, provider });
    } catch (e) {
      out.push({ net, error: e?.message || String(e) });
    }
  }
  return out;
}

// transfer scanning and transaction details removed

function pow10n(d) { let r = 1n; for (let i=0;i<d;i++) r *= 10n; return r; }
function toMicroUsdBigInt(token) {
  // token: { raw: BigInt, decimals: number }
  try {
    const raw = BigInt(token.raw);
    const denom = pow10n(Number(token.decimals || 6));
    return (raw * 1000000n) / denom; // micro-dollar units
  } catch { return 0n; }
}
function calcUsdMicro(balances) {
  // Sum stablecoins as micro-dollars (int) to avoid float noise
  let total = 0n;
  const u = balances.tokens?.USDT;
  const c = balances.tokens?.USDC;
  if (u && !u.error && u.raw != null) total += toMicroUsdBigInt(u);
  if (c && !c.error && c.raw != null) total += toMicroUsdBigInt(c);
  return total;
}
function fmtMicroUSD(m) {
  const neg = m < 0n;
  const n = neg ? -m : m;
  const int = n / 1000000n;
  const frac = n % 1000000n;
  const fracStr = frac.toString().padStart(6, '0');
  return `${neg ? '-' : ''}${int.toString()}.${fracStr}`;
}

async function sendEmail(subject, text, toOverride) {
  const to = toOverride || emailTo;
  if (!to) return;
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || (process.env.SMTP_USER || 'watcher@example.com'),
      to,
      subject,
      text
    });
  } catch (e) {
    console.error('Email send failed:', e?.message || e);
  }
}

// Per-wallet state
const walletState = new Map(); // address -> { lastUsdMicro: BigInt | null, label?, user?, email? }

function shortAddr(a) { return a.slice(0, 6) + '...' + a.slice(-4); }
function labelOf(entry) {
  if (entry.label && entry.user) return `${entry.user}/${entry.label}`;
  if (entry.label) return entry.label;
  if (entry.user) return entry.user;
  return shortAddr(entry.address);
}

async function processWallet(entry) {
  const { address } = entry;
  const state = walletState.get(address) || { lastUsdMicro: null, label: entry.label, user: entry.user, email: entry.email };
  state.label = entry.label ?? state.label;
  state.user = entry.user ?? state.user;
  state.email = entry.email ?? state.email;
  const snap = await fetchAllBalances(address);
  const totalUsdMicro = snap.reduce((acc, it) => acc + (it.error ? 0n : calcUsdMicro(it)), 0n);
  const anyErrors = snap.some((it) => !!it.error);

  if (state.lastUsdMicro === null) {
    state.lastUsdMicro = totalUsdMicro;
    walletState.set(address, state);
    console.log(`[init] ${labelOf({ ...state, address })} (${shortAddr(address)}) ≈ ~$${fmtMicroUSD(totalUsdMicro)}`);
    return null;
  }

  const last = state.lastUsdMicro;
  const deltaMicro = (totalUsdMicro >= last) ? (totalUsdMicro - last) : (last - totalUsdMicro);
  const thresholdMicro = BigInt(Math.round(usdDelta * 1e6));
  let shouldEmail = deltaMicro >= thresholdMicro;
  if (shouldEmail && !allowErrorsForEmail && anyErrors) {
    console.log(`[skip] ${prettyName(address)} change but some networks errored.`);
    shouldEmail = false;
  }

  let chosenSnap = snap;
  let chosenTotal = totalUsdMicro;
  if (shouldEmail) {
    try {
      const confirmSnap = await fetchAllBalances(address);
      const confirmMicro = confirmSnap.reduce((acc, it) => acc + (it.error ? 0n : calcUsdMicro(it)), 0n);
      const confirmDelta = (confirmMicro >= last) ? (confirmMicro - last) : (last - confirmMicro);
      if (confirmDelta < thresholdMicro) {
        console.log(`[skip] ${prettyName(address)} change did not confirm.`);
        shouldEmail = false;
      } else {
        chosenSnap = confirmSnap;
        chosenTotal = confirmMicro;
      }
    } catch (_) { /* ignore confirm errors */ }
  }

  if (!shouldEmail) {
    console.log(`[tick] ${labelOf({ ...state, address })} (${shortAddr(address)}) ~$${fmtMicroUSD(totalUsdMicro)} (Δ ${fmtMicroUSD(deltaMicro)} < ${usdDelta})`);
    return null;
  }

  const lines = [
    `User: ${state.user ?? '-'}  Label: ${state.label ?? '-'}`,
    `Address: ${address}`,
    `Change: ~$${fmtMicroUSD(deltaMicro)}`,
    `Now: ~$${fmtMicroUSD(chosenTotal)}`,
    '',
    ...chosenSnap.map((it) => {
      if (it.error) return `- ${it.net.name}: ERROR ${it.error}`;
      const usdt = it.tokens.USDT && !it.tokens.USDT.error ? it.tokens.USDT.formatted : '0';
      const usdc = it.tokens.USDC && !it.tokens.USDC.error ? it.tokens.USDC.formatted : '0';
      return `- ${it.net.name}: USDT=${usdt}, USDC=${usdc}`;
    })
  ];

  return { address, deltaMicro, totalUsdMicro: chosenTotal, lines, email: state.email, user: state.user, label: state.label };
}

async function pMap(items, mapper, limit) {
  const ret = [];
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { ret[idx] = await mapper(items[idx], idx); } catch (e) { ret[idx] = e; }
    }
  });
  await Promise.all(workers);
  return ret;
}

async function runCycle(entries) {
  console.log(`Cycle start: ${entries.length} wallet(s), concurrency ${concurrency}`);
  const results = await pMap(entries, (e) => processWallet(e), concurrency);
  const changes = results.filter((r) => r && typeof r === 'object');
  if (changes.length > 0) {
    // group by recipient email (fallback to global if missing)
    const groups = new Map(); // email -> array of changes
    for (const c of changes) {
      const key = (c.email && c.email.includes('@')) ? c.email : (emailTo || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const [to, arr] of groups) {
      if (!to) { console.warn('No recipient email configured for some wallets; skipping email.'); continue; }
      const subject = `Wallet changes this cycle: ${arr.length} wallet(s)`;
      const body = arr.map((c) => {
        const header = `User: ${c.user ?? '-'}  Label: ${c.label ?? '-'}  (${shortAddr(c.address)})`;
        return [header, ...c.lines].join('\n');
      }).join('\n\n---\n\n');
      await sendEmail(subject, body, to);
      console.log(`[email] ${subject} -> ${to}`);
    }
    // Update state after emails
    for (const c of changes) {
      const st = walletState.get(c.address) || { lastUsdMicro: null };
      st.lastUsdMicro = c.totalUsdMicro;
      walletState.set(c.address, st);
    }
  }
  console.log(`Cycle end.`);
}

async function main() {
  const fromJson = await readAddressesFromJsonMaybe();
  const fromFile = await readAddressesFromFileMaybe();
  const all = normalizeAddresses([...positional, ...fromFile, ...fromJson]); // [{address,label,user?,email?}]
  if (all.length === 0) {
    usageAndExit();
    return;
  }
  console.log(`Watching ${all.length} wallet(s) across ${selected.length} networks (interval ${intervalMs}ms, threshold ~$${usdDelta})`);
  await runCycle(all);
  setInterval(() => { runCycle(all).catch(() => {}); }, intervalMs);
}

await main();
