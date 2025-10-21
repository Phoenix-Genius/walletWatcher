// Curated list of public RPC endpoints for popular EVM networks.
// Prefer using your own RPC endpoints via env (e.g., ALCHEMY/INFURA etc.) for reliability and rate limits.

export const networks = [
  // Ethereum family
  { key: 'eth', name: 'Ethereum Mainnet', chainId: 1, symbol: 'ETH', rpcEnv: 'RPC_ETH', rpcs: ['https://eth.llamarpc.com', 'https://cloudflare-eth.com', 'https://rpc.ankr.com/eth', 'https://mainnet.infura.io/v3/e37245be6d6f4cde9fdfcdb0ad372d58'], tokens: { USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7', USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' } },
  { key: 'polygon', name: 'Polygon', chainId: 137, symbol: 'MATIC', rpcEnv: 'RPC_POLYGON', rpcs: ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon', 'https://polygon-mainnet.infura.io/v3/e37245be6d6f4cde9fdfcdb0ad372d58'], tokens: { USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' } },
  { key: 'bsc', name: 'BNB Smart Chain', chainId: 56, symbol: 'BNB', rpcEnv: 'RPC_BSC', rpcs: ['https://bsc-dataseed.binance.org', 'https://rpc.ankr.com/bsc', 'https://bsc-mainnet.infura.io/v3/e37245be6d6f4cde9fdfcdb0ad372d58'], tokens: { USDT: '0x55d398326f99059ff775485246999027b3197955', USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' } },
  { key: 'arbitrum', name: 'Arbitrum One', chainId: 42161, symbol: 'ETH', rpcEnv: 'RPC_ARBITRUM', rpcs: ['https://arb1.arbitrum.io/rpc', 'https://rpc.ankr.com/arbitrum', 'https://arbitrum-mainnet.infura.io/v3/e37245be6d6f4cde9fdfcdb0ad372d58'], tokens: { USDT: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', USDC: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8' } },
  { key: 'optimism', name: 'Optimism', chainId: 10, symbol: 'ETH', rpcEnv: 'RPC_OPTIMISM', rpcs: ['https://mainnet.optimism.io', 'https://optimism.meowrpc.com', 'https://rpc.ankr.com/optimism', 'https://optimism-mainnet.infura.io/v3/e37245be6d6f4cde9fdfcdb0ad372d58'], tokens: { USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' } },
  { key: 'base', name: 'Base', chainId: 8453, symbol: 'ETH', rpcEnv: 'RPC_BASE', rpcs: ['https://mainnet.base.org', 'https://rpc.ankr.com/base', 'https://base-mainnet.infura.io/v3/e37245be6d6f4cde9fdfcdb0ad372d58'], tokens: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } },
  { key: 'avalanche', name: 'Avalanche C-Chain', chainId: 43114, symbol: 'AVAX', rpcEnv: 'RPC_AVAX', rpcs: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.public-rpc.com', 'https://rpc.ankr.com/avalanche', 'https://avalanche-mainnet.infura.io/v3/e37245be6d6f4cde9fdfcdb0ad372d58'], tokens: { USDT: '0xde3A24028580884448a5397872046a019649b084', USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' } },
  { key: 'fantom', name: 'Fantom Opera', chainId: 250, symbol: 'FTM', rpcEnv: 'RPC_FANTOM', rpcs: ['https://rpc.ftm.tools', 'https://rpc.ankr.com/fantom'] },
  { key: 'gnosis', name: 'Gnosis', chainId: 100, symbol: 'xDAI', rpcEnv: 'RPC_GNOSIS', rpcs: ['https://rpc.gnosischain.com', 'https://rpc.ankr.com/gnosis'] },
  { key: 'linea', name: 'Linea', chainId: 59144, symbol: 'ETH', rpcEnv: 'RPC_LINEA', rpcs: ['https://rpc.linea.build'] },
  { key: 'zksync', name: 'zkSync Era', chainId: 324, symbol: 'ETH', rpcEnv: 'RPC_ZKSYNC', rpcs: ['https://mainnet.era.zksync.io'] },
  { key: 'scroll', name: 'Scroll', chainId: 534352, symbol: 'ETH', rpcEnv: 'RPC_SCROLL', rpcs: ['https://rpc.scroll.io'] },
  { key: 'mantle', name: 'Mantle', chainId: 5000, symbol: 'MNT', rpcEnv: 'RPC_MANTLE', rpcs: ['https://rpc.mantle.xyz'] },
  { key: 'celo', name: 'Celo', chainId: 42220, symbol: 'CELO', rpcEnv: 'RPC_CELO', rpcs: ['https://forno.celo.org'] },
  { key: 'opbnb', name: 'opBNB', chainId: 204, symbol: 'BNB', rpcEnv: 'RPC_OPBNB', rpcs: ['https://opbnb-mainnet-rpc.bnbchain.org'] },
  { key: 'zkevm', name: 'Polygon zkEVM', chainId: 1101, symbol: 'ETH', rpcEnv: 'RPC_ZKEVM', rpcs: ['https://zkevm-rpc.com'] },
  { key: 'moonbeam', name: 'Moonbeam', chainId: 1284, symbol: 'GLMR', rpcEnv: 'RPC_MOONBEAM', rpcs: ['https://rpc.api.moonbeam.network'] }
];

export function getRpcUrl(spec) {
  const fromEnv = process.env[spec.rpcEnv];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return spec.rpcs[0];
}
