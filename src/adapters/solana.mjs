import 'dotenv/config'
import { Connection, PublicKey } from '@solana/web3.js'

// Basic Solana adapter: fetch native SOL balance and USDC/USDT SPL balances
// Env overrides:
//  - RPC_SOLANA: custom endpoint
//  - SOLANA_USDC: token mint (default: mainnet USDC)
//  - SOLANA_USDT: token mint (default: mainnet USDT)

const RPC = process.env.RPC_SOLANA || 'https://api.mainnet-beta.solana.com'
const USDC = process.env.SOLANA_USDC || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = process.env.SOLANA_USDT || 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

export async function fetchSolanaBalances(address) {
  const conn = new Connection(RPC, 'confirmed')
  const pub = new PublicKey(address)
  const lamports = await conn.getBalance(pub)
  const native = BigInt(lamports) // 1 SOL = 1e9 lamports (not used in usd calc)

  // Use getParsedTokenAccountsByOwner for SPL token balances
  const tokens = { USDT: { error: '0' }, USDC: { error: '0' } }
  try {
    const resp = await conn.getParsedTokenAccountsByOwner(pub, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })
    for (const { account } of resp.value) {
      const info = account.data?.parsed?.info
      const mint = info?.mint
      const raw = BigInt(info?.tokenAmount?.amount || '0')
      const decimals = Number(info?.tokenAmount?.decimals || 6)
      if (mint === USDC) tokens.USDC = { raw, decimals, symbol: 'USDC', formatted: (Number(raw) / 10 ** decimals).toString() }
      if (mint === USDT) tokens.USDT = { raw, decimals, symbol: 'USDT', formatted: (Number(raw) / 10 ** decimals).toString() }
    }
  } catch (e) {
    tokens.USDT = { error: e?.message || String(e) }
    tokens.USDC = { error: e?.message || String(e) }
  }
  return { net: { key: 'sol', name: 'Solana' }, native, tokens }
}
