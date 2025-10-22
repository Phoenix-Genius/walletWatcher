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
  console.error('Usage: npm run watch -- [<EVM_ADDRESS> ...] [--file=wallet-addresses] [--only=eth,polygon,...] [--interval=30000] [--usdDelta=0.1] [--emailTo=addr] [--concurrency=50]');
  console.error('Tip: Put one address per line in a file named "wallet-addresses" and run with no positional args.');
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

// Resolve addresses: positional + optional file (default: ./wallet-addresses)
const filePath = resolvePath(process.cwd(), String(opts.file || 'wallet-addresses'));
async function readAddressesFromFileMaybe() {
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) continue;
    if (!isAddress(t)) { console.warn('Skipping invalid address in file:', t); continue; }
    out.push(getAddress(t));
  }
  return out;
}

function normalizeAddresses(arr) {
  const set = new Set();
  for (const a of arr) {
    if (!isAddress(a)) { console.warn('Skipping invalid address:', a); continue; }
    set.add(getAddress(a));
  }
  return Array.from(set);
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

async function sendEmail(subject, text) {
  if (!emailTo) return;
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || (process.env.SMTP_USER || 'watcher@example.com'),
      to: emailTo,
      subject,
      text
    });
  } catch (e) {
    console.error('Email send failed:', e?.message || e);
  }
}

// Per-wallet state
const walletState = new Map(); // address -> { lastUsdMicro: BigInt | null }

function shortAddr(a) { return a.slice(0, 6) + '...' + a.slice(-4); }

async function processWallet(address) {
  const state = walletState.get(address) || { lastUsdMicro: null };
  const snap = await fetchAllBalances(address);
  const totalUsdMicro = snap.reduce((acc, it) => acc + (it.error ? 0n : calcUsdMicro(it)), 0n);
  const anyErrors = snap.some((it) => !!it.error);

  if (state.lastUsdMicro === null) {
    state.lastUsdMicro = totalUsdMicro;
    walletState.set(address, state);
    console.log(`[init] ${shortAddr(address)} ≈ ~$${fmtMicroUSD(totalUsdMicro)}`);
    return;
  }

  const last = state.lastUsdMicro;
  const deltaMicro = (totalUsdMicro >= last) ? (totalUsdMicro - last) : (last - totalUsdMicro);
  const thresholdMicro = BigInt(Math.round(usdDelta * 1e6));
  let shouldEmail = deltaMicro >= thresholdMicro;
  if (shouldEmail && !allowErrorsForEmail && anyErrors) {
    console.log(`[skip] ${shortAddr(address)} change but some networks errored.`);
    shouldEmail = false;
  }
  if (shouldEmail) {
    try {
      const confirmSnap = await fetchAllBalances(address);
      const confirmMicro = confirmSnap.reduce((acc, it) => acc + (it.error ? 0n : calcUsdMicro(it)), 0n);
      const confirmDelta = (confirmMicro >= last) ? (confirmMicro - last) : (last - confirmMicro);
      if (confirmDelta < thresholdMicro) {
        console.log(`[skip] ${shortAddr(address)} change did not confirm.`);
        shouldEmail = false;
      } else {
        Object.assign(snap, confirmSnap);
        // update total to confirmed value for email text
        Object.assign({});
      }
    } catch (_) { /* ignore confirm errors */ }
  }
  if (shouldEmail) {
    const subject = `${shortAddr(address)}: ~$${fmtMicroUSD(deltaMicro)} (now ~$${fmtMicroUSD(totalUsdMicro)})`;
    const lines = [
      `Address: ${address}`,
      `Change: ~$${fmtMicroUSD(deltaMicro)}`,
      `Now: ~$${fmtMicroUSD(totalUsdMicro)}`,
      '',
      ...snap.map((it) => {
        if (it.error) return `- ${it.net.name}: ERROR ${it.error}`;
        const usdt = it.tokens.USDT && !it.tokens.USDT.error ? it.tokens.USDT.formatted : '0';
        const usdc = it.tokens.USDC && !it.tokens.USDC.error ? it.tokens.USDC.formatted : '0';
        return `- ${it.net.name}: USDT=${usdt}, USDC=${usdc}`;
      })
    ];
    await sendEmail(subject, lines.join('\n'));
    state.lastUsdMicro = totalUsdMicro;
    walletState.set(address, state);
    console.log(`[email] ${subject}`);
  } else {
    console.log(`[tick] ${shortAddr(address)} ~$${fmtMicroUSD(totalUsdMicro)} (Δ ${fmtMicroUSD(deltaMicro)} < ${usdDelta})`);
  }
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

async function runCycle(addresses) {
  console.log(`Cycle start: ${addresses.length} wallet(s), concurrency ${concurrency}`);
  await pMap(addresses, (a) => processWallet(a), concurrency);
  console.log(`Cycle end.`);
}

async function main() {
  const fromFile = await readAddressesFromFileMaybe();
  const allAddrs = normalizeAddresses([...positional, ...fromFile]);
  if (allAddrs.length === 0) {
    usageAndExit();
    return;
  }
  console.log(`Watching ${allAddrs.length} wallet(s) across ${selected.length} networks (interval ${intervalMs}ms, threshold ~$${usdDelta})`);
  await runCycle(allAddrs);
  setInterval(() => { runCycle(allAddrs).catch(() => {}); }, intervalMs);
}

await main();
