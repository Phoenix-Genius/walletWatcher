import 'dotenv/config'
import TronWeb from 'tronweb'

// Basic Tron adapter: fetch native TRX balance and TRC20 USDT (and USDC if present)
// Env overrides:
//  - RPC_TRON_FULLNODE / RPC_TRON_SOLIDITY / RPC_TRON_EVENT: endpoints
//  - TRON_USDT: default mainnet USDT contract
//  - TRON_USDC: optional USDC contract on Tron

const fullNode = process.env.RPC_TRON_FULLNODE || 'https://api.trongrid.io'
const solidityNode = process.env.RPC_TRON_SOLIDITY || fullNode
const eventServer = process.env.RPC_TRON_EVENT || fullNode

const tronWeb = new TronWeb({ fullHost: fullNode, solidityNode, eventServer })

const USDT = process.env.TRON_USDT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' // Tether USD (TRC20)
const USDC = process.env.TRON_USDC || ''

const TRC20_ABI = [{
  constant: true,
  inputs: [{ name: 'owner', type: 'address' }],
  name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }],
  stateMutability: 'view', type: 'function'
}, {
  constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function'
}, {
  constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function'
}]

async function readTrc20(contractAddr, owner) {
  const c = await tronWeb.contract(TRC20_ABI, contractAddr)
  const [bal, dec, sym] = await Promise.all([c.balanceOf(owner).call(), c.decimals().call(), c.symbol().call()])
  const raw = BigInt(bal)
  const decimals = Number(dec)
  return { raw, decimals, symbol: String(sym), formatted: (Number(raw) / 10 ** decimals).toString() }
}

export async function fetchTronBalances(address) {
  const nativeSun = await tronWeb.trx.getBalance(address)
  const native = BigInt(nativeSun)
  const tokens = {}
  try { tokens.USDT = await readTrc20(USDT, address) } catch (e) { tokens.USDT = { error: e?.message || String(e) } }
  if (USDC) {
    try { tokens.USDC = await readTrc20(USDC, address) } catch (e) { tokens.USDC = { error: e?.message || String(e) } }
  }
  return { net: { key: 'tron', name: 'Tron' }, native, tokens }
}
