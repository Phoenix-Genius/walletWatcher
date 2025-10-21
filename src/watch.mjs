#!/usr/bin/env node
import 'dotenv/config';
import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import { JsonRpcProvider, formatEther, formatUnits, getAddress, isAddress, Contract, id, zeroPadValue, Interface } from 'ethers';
import { networks, getRpcUrl } from './networks.mjs';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

// cache: { [chainId]: { [tokenAddressLower]: { decimals, symbol } } }
const tokenMetaCache = new Map();

const lastBlockByChain = new Map(); // chainId -> last processed block (deprecated, replaced per-address state)
const blockTsCacheByChain = new Map(); // chainId -> Map(blockNumber -> timestamp)
const SAFE_CONFIRMATIONS = Number(process.env.SAFE_CONFIRMATIONS || 3);
const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
const erc20Iface = new Interface(ERC20_ABI);

function usageAndExit() {
  console.error('Usage: npm run watch -- <ADDR1> [ADDR2 ...] [--file=addresses.txt] [--only=eth,polygon,...] [--interval=30000] [--usdDelta=0.1] [--emailTo=addr] [--requireTransfer=true|false] [--allowErrors=true|false] [--once]');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length < 1) usageAndExit();

const posArgs = argv.filter(a => !a.startsWith('--'));
const optArgs = argv.filter(a => a.startsWith('--'));

const opts = Object.fromEntries(
  optArgs.map((a) => {
    const [k, v = 'true'] = a.slice(2).split('=');
    return [k, v];
  })
);

async function resolveAddresses() {
  const out = [];
  // from positional args
  for (const a of posArgs) {
    if (isAddress(a)) out.push(getAddress(a));
    else console.error('Skipping invalid address:', a);
  }
  // from file
  if (opts.file) {
    try {
      const raw = await fs.readFile(String(opts.file), 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        if (isAddress(t)) out.push(getAddress(t));
        else console.error('Skipping invalid address in file:', t);
      }
    } catch (e) {
      console.error('Failed to read --file:', e?.message || String(e));
      process.exit(2);
    }
  }
  return Array.from(new Set(out)); // dedup
}

const only = opts.only ? String(opts.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
const selected = only ? networks.filter((n) => only.includes(n.key)) : networks;
const intervalMs = Math.max(5000, Number(opts.interval || 30000));
const usdDelta = Number(opts.usdDelta || 0.1); // threshold in USD
const emailTo = opts.emailTo || process.env.EMAIL_TO;
const requireTransferForEmail = (opts.requireTransfer || process.env.REQUIRE_TRANSFER_FOR_EMAIL || 'false') === 'true';
const allowErrorsForEmail = (opts.allowErrors || process.env.ALLOW_ERRORS_FOR_EMAIL || 'false') === 'true';
const runOnce = opts.once === 'true' || opts.once === '' || opts.once === true;
const initialBlocks = Number(opts.initialBlocks || process.env.INITIAL_BLOCKS || 0); // scan last N blocks on first run
const backfillBlocks = Number(opts.backfillBlocks || process.env.BACKFILL_BLOCKS || 0); // if emailing without transfers, look back this many blocks
const includeTransfersInEmail = (opts.includeTransfers || process.env.INCLUDE_TRANSFERS_IN_EMAIL || 'true') === 'true';

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

async function fetchTransfersSince(net, provider, fromBlock, toBlock, watchAddress) {
  if (!net.tokens) return [];
  const addrPad = zeroPadValue(watchAddress, 32);
  const events = [];
  const chainCache = tokenMetaCache.get(net.chainId) || {};
  for (const [sym, tAddr] of Object.entries(net.tokens)) {
    const filterFrom = { address: tAddr, fromBlock, toBlock, topics: [TRANSFER_TOPIC, addrPad] };
    const filterTo = { address: tAddr, fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, addrPad] };
    const logs = [
      ...(await provider.getLogs(filterFrom)),
      ...(await provider.getLogs(filterTo))
    ];
    for (const log of logs) {
      let parsed;
      try { parsed = erc20Iface.parseLog(log); } catch { continue; }
      const from = parsed.args[0];
      const to = parsed.args[1];
      const value = parsed.args[2];
      const isIn = getAddress(to) === getAddress(watchAddress);
      const counterparty = isIn ? getAddress(from) : getAddress(to);
      // meta
      const key = tAddr.toLowerCase();
      let meta = chainCache[key];
      if (!meta) {
        try {
          const c = new Contract(tAddr, ERC20_ABI, provider);
          const [dec, rsym] = await Promise.all([
            withTimeout(c.decimals(), 8000, `${net.name}:${sym}:decimals`),
            withTimeout(c.symbol(), 8000, `${net.name}:${sym}:symbol`)
          ]);
          meta = { decimals: Number(dec), symbol: String(rsym) };
          chainCache[key] = meta;
          tokenMetaCache.set(net.chainId, chainCache);
        } catch {
          meta = { decimals: 18, symbol: sym };
        }
      }
      // timestamp
      let tsCache = blockTsCacheByChain.get(net.chainId);
      if (!tsCache) { tsCache = new Map(); blockTsCacheByChain.set(net.chainId, tsCache); }
      let ts = tsCache.get(log.blockNumber);
      if (!ts) {
        try {
          const blk = await provider.getBlock(log.blockNumber);
          ts = blk?.timestamp || 0;
          tsCache.set(log.blockNumber, ts);
        } catch { ts = 0; }
      }
      events.push({
        chainId: net.chainId,
        chain: net.name,
        token: sym,
        symbol: meta.symbol || sym,
        amount: formatUnits(value, meta.decimals),
        direction: isIn ? 'IN' : 'OUT',
        counterparty,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        timestamp: ts,
        timeISO: ts ? new Date(ts * 1000).toISOString() : ''
      });
    }
  }
  return events.sort((a, b) => (a.blockNumber - b.blockNumber));
}

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
// Per-address state
const stateByAddress = new Map(); // address -> { lastUsdMicro: BigInt|null, lastBlockByChain: Map(chainId->lastBlock) }

async function loopForAddress(address) {
  const snap = await fetchAllBalances(address);
  // Sum USD across chains (only stablecoins considered), micro-dollar integer
  const totalUsdMicro = snap.reduce((acc, it) => acc + (it.error ? 0n : calcUsdMicro(it)), 0n);
  const anyErrors = snap.some((it) => !!it.error);

  // Collect recent transfers since last tick
  const transfers = [];
  let st = stateByAddress.get(address);
  if (!st) { st = { lastUsdMicro: null, lastBlockByChain: new Map() }; stateByAddress.set(address, st); }
  for (const it of snap) {
    if (it.error) continue;
    try {
      const latest = await it.provider.getBlockNumber();
      const toBlock = Math.max(0, latest - SAFE_CONFIRMATIONS);
      let fromBlock = st.lastBlockByChain.get(it.net.chainId);
      if (fromBlock == null) {
        // initialize to current toBlock or back by initialBlocks to capture recent history
        const start = Math.max(0, toBlock - Math.max(0, initialBlocks));
        st.lastBlockByChain.set(it.net.chainId, start);
        fromBlock = start;
      }
      fromBlock = Math.min(fromBlock + 1, toBlock);
      if (fromBlock > toBlock) continue;
      const evts = await fetchTransfersSince(it.net, it.provider, fromBlock, toBlock, address);
      if (evts.length) transfers.push(...evts);
      st.lastBlockByChain.set(it.net.chainId, toBlock);
    } catch (e) {
      // ignore transfer fetch errors per chain
    }
  }

  if (st.lastUsdMicro === null) {
    st.lastUsdMicro = totalUsdMicro;
    console.log(`[init] ${address}: Total stablecoin USD ≈ ${fmtMicroUSD(totalUsdMicro)}`);
    if (transfers.length) {
      console.log(`[init] ${address}: Recent transfers (ignored for delta):`);
      for (const e of transfers) {
        console.log(`  - ${e.chain} ${e.token} ${e.direction} ${e.amount} with ${e.counterparty} @ ${e.timeISO} (${e.txHash.slice(0,10)}...)`);
      }
    }
  } else {
    const lastUsdMicro = st.lastUsdMicro;
    const deltaMicro = (totalUsdMicro >= lastUsdMicro) ? (totalUsdMicro - lastUsdMicro) : (lastUsdMicro - totalUsdMicro);
    const thresholdMicro = BigInt(Math.round(usdDelta * 1e6));
    let shouldEmail = deltaMicro >= thresholdMicro;
    // Gating: require no RPC errors unless explicitly allowed
    if (shouldEmail && !allowErrorsForEmail && anyErrors) {
      console.log(`[skip] ${address}: Change detected but some networks errored; skipping email to avoid false positives.`);
      shouldEmail = false;
    }
    // Gating: optionally require at least one transfer event
    if (shouldEmail && requireTransferForEmail && transfers.length === 0) {
      console.log(`[skip] ${address}: Change detected but no transfers observed; skipping due to requireTransfer.`);
      shouldEmail = false;
    }
    // Confirm step: re-fetch once to avoid transient glitches
    if (shouldEmail) {
      try {
        const confirmSnap = await fetchAllBalances(address);
        const confirmMicro = confirmSnap.reduce((acc, it) => acc + (it.error ? 0n : calcUsdMicro(it)), 0n);
        const confirmDelta = (confirmMicro >= lastUsdMicro) ? (confirmMicro - lastUsdMicro) : (lastUsdMicro - confirmMicro);
        if (confirmDelta < thresholdMicro) {
          console.log(`[skip] ${address}: Change did not confirm on recheck.`);
          shouldEmail = false;
        } else {
          // update to confirmed value
          Object.assign(snap, confirmSnap);
        }
      } catch (_) { /* ignore confirm errors */ }
    }
    // If still emailing but no transfers found, attempt a bounded backfill
    if (shouldEmail && transfers.length === 0 && backfillBlocks > 0) {
      try {
        let found = 0;
        for (const it of snap) {
          if (it.error) continue;
          const latest = await it.provider.getBlockNumber();
          const toBlock = Math.max(0, latest - SAFE_CONFIRMATIONS);
          const fromBlock = Math.max(0, toBlock - backfillBlocks);
          const evts = await fetchTransfersSince(it.net, it.provider, fromBlock, toBlock, address);
          if (evts.length) { transfers.push(...evts); found += evts.length; }
        }
        if (found) console.log(`[backfill] ${address}: added ${found} transfer(s) from last ${backfillBlocks} blocks.`);
      } catch (_) { /* ignore backfill errors */ }
    }
  if (shouldEmail) {
      const subject = `Wallet ${address} change: ~$${fmtMicroUSD(deltaMicro)} (now ~$${fmtMicroUSD(totalUsdMicro)})`;
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
        }),
        '',
        ...(includeTransfersInEmail ? ['Recent transfers:'] : []),
        ...(includeTransfersInEmail ? (transfers.length ? transfers.map((e) => `• ${e.chain} ${e.token} ${e.direction} ${e.amount} with ${e.counterparty} @ ${e.timeISO} (tx ${e.txHash})`) : ['• None in this interval']) : [])
      ];
      await sendEmail(subject, lines.join('\n'));
      st.lastUsdMicro = totalUsdMicro;
      console.log(`[email] ${subject}`);
      if (transfers.length) {
        for (const e of transfers) {
          console.log(`  - ${e.chain} ${e.token} ${e.direction} ${e.amount} with ${e.counterparty} @ ${e.timeISO} (${e.txHash.slice(0,10)}...)`);
        }
      }
    } else {
      console.log(`[tick] ${address}: ~$${fmtMicroUSD(totalUsdMicro)} (Δ ${fmtMicroUSD(deltaMicro)} < ${usdDelta})`);
      if (transfers.length) {
        console.log(`  ${address} transfers:`);
        for (const e of transfers) {
          console.log(`  - ${e.chain} ${e.token} ${e.direction} ${e.amount} with ${e.counterparty} @ ${e.timeISO} (${e.txHash.slice(0,10)}...)`);
        }
      }
    }
  }
}

async function loopAll(addresses) {
  for (const a of addresses) {
    try {
      await loopForAddress(a);
    } catch (e) {
      console.error(`[error] ${a}:`, e?.message || String(e));
    }
  }
}

const addresses = await resolveAddresses();
if (addresses.length === 0) {
  console.error('No valid EVM addresses provided.');
  process.exit(3);
}

console.log(`Watching ${addresses.length} wallet(s) across ${selected.length} networks (interval ${intervalMs}ms, threshold ~$${usdDelta})`);
await loopAll(addresses);
if (runOnce) {
  process.exit(0);
}
setInterval(() => loopAll(addresses), intervalMs);
