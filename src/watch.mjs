#!/usr/bin/env node
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { JsonRpcProvider, formatUnits, getAddress, isAddress, Contract } from 'ethers';
import { networks, getRpcUrl } from './networks.mjs';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

// cache: { [chainId]: { [tokenAddressLower]: { decimals, symbol } } }
const tokenMetaCache = new Map();

function usageAndExit() {
  console.error('Usage: npm run watch -- <EVM_ADDRESS> [--only=eth,polygon,...] [--interval=30000] [--usdDelta=0.1] [--emailTo=addr]');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length < 1) usageAndExit();

const addrInput = argv[0];
if (!isAddress(addrInput)) {
  console.error('Invalid EVM address:', addrInput);
  process.exit(2);
}
const address = getAddress(addrInput);

const opts = Object.fromEntries(
  argv.slice(1).map((a) => {
    const [k, v = 'true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
    return [k, v];
  })
);

const only = opts.only ? String(opts.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
const selected = only ? networks.filter((n) => only.includes(n.key)) : networks;
const intervalMs = Math.max(5000, Number(opts.interval || 30000));
const usdDelta = Number(opts.usdDelta || 0.1); // threshold in USD
const emailTo = opts.emailTo || process.env.EMAIL_TO;
const allowErrorsForEmail = (opts.allowErrors || process.env.ALLOW_ERRORS_FOR_EMAIL || 'false') === 'true';

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

async function getProvider(net) {
  const preferred = getRpcUrl(net);
  const candidates = Array.from(new Set([preferred, ...net.rpcs]));
  for (const url of candidates) {
    try {
      const provider = new JsonRpcProvider(url, net.chainId);
      await withTimeout(provider.getBlockNumber(), 6000, `${net.name}@${url}`);
      return { provider, url };
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

let lastUsdMicro = null; // BigInt micro-dollars

async function loop() {
  const snap = await fetchAllBalances(address);
  // Sum USD across chains (only stablecoins considered), micro-dollar integer
  const totalUsdMicro = snap.reduce((acc, it) => acc + (it.error ? 0n : calcUsdMicro(it)), 0n);
  const anyErrors = snap.some((it) => !!it.error);

  if (lastUsdMicro === null) {
    lastUsdMicro = totalUsdMicro;
    console.log(`[init] Total stablecoin USD ≈ ${fmtMicroUSD(totalUsdMicro)} for ${address}`);
  } else {
    const deltaMicro = (totalUsdMicro >= lastUsdMicro) ? (totalUsdMicro - lastUsdMicro) : (lastUsdMicro - totalUsdMicro);
    const thresholdMicro = BigInt(Math.round(usdDelta * 1e6));
    let shouldEmail = deltaMicro >= thresholdMicro;
    // Gating: require no RPC errors unless explicitly allowed
    if (shouldEmail && !allowErrorsForEmail && anyErrors) {
      console.log(`[skip] Change detected but some networks errored; skipping email to avoid false positives.`);
      shouldEmail = false;
    }
    // Confirm step: re-fetch once to avoid transient glitches
    if (shouldEmail) {
      try {
        const confirmSnap = await fetchAllBalances(address);
        const confirmMicro = confirmSnap.reduce((acc, it) => acc + (it.error ? 0n : calcUsdMicro(it)), 0n);
        const confirmDelta = (confirmMicro >= lastUsdMicro) ? (confirmMicro - lastUsdMicro) : (lastUsdMicro - confirmMicro);
        if (confirmDelta < thresholdMicro) {
          console.log(`[skip] Change did not confirm on recheck.`);
          shouldEmail = false;
        } else {
          // update to confirmed value
          Object.assign(snap, confirmSnap);
        }
      } catch (_) { /* ignore confirm errors */ }
    }
    if (shouldEmail) {
      const subject = `Wallet change: ~$${fmtMicroUSD(deltaMicro)} (now ~$${fmtMicroUSD(totalUsdMicro)})`;
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
      lastUsdMicro = totalUsdMicro;
      console.log(`[email] ${subject}`);
    } else {
      console.log(`[tick] ~$${fmtMicroUSD(totalUsdMicro)} (Δ ${fmtMicroUSD(deltaMicro)} < ${usdDelta})`);
    }
  }
}

console.log(`Watching ${address} across ${selected.length} networks (interval ${intervalMs}ms, threshold ~$${usdDelta})`);
await loop();
setInterval(loop, intervalMs);
