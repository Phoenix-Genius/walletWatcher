#!/usr/bin/env node
import 'dotenv/config';
import { JsonRpcProvider, formatEther, formatUnits, getAddress, isAddress, Contract } from 'ethers';
import { networks, getRpcUrl } from './networks.mjs';

function usageAndExit() {
  console.error('Usage: node src/check-balances.mjs <EVM_ADDRESS> [--csv] [--only=eth,polygon,...] [--timeout=8000]');
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

const timeoutMs = Number(opts.timeout || 8000);
const only = opts.only ? String(opts.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
const asCsv = opts.csv === 'true' || opts.csv === true;

const selected = only ? networks.filter((n) => only.includes(n.key)) : networks;

function withTimeout(promise, ms, label) {
  const to = new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms: ${label}`)), ms));
  return Promise.race([promise, to]);
}

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

// cache: { [chainId]: { [tokenAddressLower]: { decimals, symbol } } }
const tokenMetaCache = new Map();

async function fetchBalance(net) {
  const preferred = getRpcUrl(net);
  const candidates = Array.from(new Set([preferred, ...net.rpcs]));
  let lastErr = null;
  for (const url of candidates) {
    try {
      const provider = new JsonRpcProvider(url, net.chainId);
      const nativeBal = await withTimeout(provider.getBalance(address), timeoutMs, `${net.name}@${url}`);

      const tokenBalances = {};
      if (net.tokens) {
        for (const [tSym, tAddr] of Object.entries(net.tokens)) {
          try {
            const c = new Contract(tAddr, ERC20_ABI, provider);
            const tBal = await withTimeout(c.balanceOf(address), timeoutMs, `${net.name}:${tSym}@${url}`);
            // get metadata with cache
            let chainCache = tokenMetaCache.get(net.chainId);
            if (!chainCache) { chainCache = {}; tokenMetaCache.set(net.chainId, chainCache); }
            const key = tAddr.toLowerCase();
            if (!chainCache[key]) {
              const [dec, sym] = await Promise.all([
                withTimeout(c.decimals(), timeoutMs, `${net.name}:${tSym}:decimals`),
                withTimeout(c.symbol(), timeoutMs, `${net.name}:${tSym}:symbol`)
              ]);
              chainCache[key] = { decimals: Number(dec), symbol: String(sym) };
            }
            const meta = chainCache[key];
            tokenBalances[tSym] = { raw: tBal, decimals: meta.decimals, symbol: meta.symbol, formatted: formatUnits(tBal, meta.decimals) };
          } catch (e) {
            tokenBalances[tSym] = { error: e?.message || String(e) };
          }
        }
      }
      return { key: net.key, name: net.name, symbol: net.symbol, chainId: net.chainId, balance: nativeBal, tokens: tokenBalances, rpc: url };
    } catch (err) {
      lastErr = err;
      continue;
    }
  }
  return { key: net.key, name: net.name, symbol: net.symbol, chainId: net.chainId, error: lastErr?.message || String(lastErr), rpc: candidates[0] };
}

(async () => {
  const start = Date.now();
  const results = await Promise.allSettled(selected.map(fetchBalance));
  const rows = results.map((r, i) => (r.status === 'fulfilled' ? r.value : { ...selected[i], error: r.reason?.message || String(r.reason) }));

  if (asCsv) {
  console.log('network,chainId,symbol,balance,wei,USDT,USDC,rpc,status');
    for (const r of rows) {
      if (r.error) {
        console.log(`${r.name},${r.chainId},${r.symbol},,,,${r.rpc},ERROR: ${r.error.replaceAll(',', ';')}`);
      } else {
        const ether = formatEther(r.balance);
    const usdt = r.tokens?.USDT && !r.tokens.USDT.error ? r.tokens.USDT.formatted : '';
    const usdc = r.tokens?.USDC && !r.tokens.USDC.error ? r.tokens.USDC.formatted : '';
        console.log(`${r.name},${r.chainId},${r.symbol},${ether},${r.balance.toString()},${usdt},${usdc},${r.rpc},OK`);
      }
    }
    return;
  }

  console.log(`Address: ${address}`);
  for (const r of rows) {
    if (r.error) {
      console.log(`- ${r.name} [${r.chainId}] ${r.symbol}: ERROR -> ${r.error}`);
    } else {
      const ether = formatEther(r.balance);
      console.log(`- ${r.name} [${r.chainId}] ${r.symbol}: ${ether}`);
      if (r.tokens && Object.keys(r.tokens).length) {
        const usdtStr = r.tokens.USDT ? (r.tokens.USDT.error ? `USDT ERROR: ${r.tokens.USDT.error}` : `USDT: ${r.tokens.USDT.formatted}`) : null;
        const usdcStr = r.tokens.USDC ? (r.tokens.USDC.error ? `USDC ERROR: ${r.tokens.USDC.error}` : `USDC: ${r.tokens.USDC.formatted}`) : null;
        const parts = [usdtStr, usdcStr].filter(Boolean);
        if (parts.length) console.log(`  • ${parts.join(' | ')}`);
      }
    }
  }
  const dur = Date.now() - start;
  console.log(`Checked ${rows.length} networks in ${dur}ms`);
})();
