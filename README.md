# walletWatcher
Wallet Watcher – EVM balances CLI
=================================

Quick Node.js script to check an EVM wallet’s native coin balance across many EVM networks.

Features
- Uses ethers v6
- Parallel queries with a timeout per chain
- CSV output option
- Override public RPCs with your own endpoints via environment variables
 - ERC‑20 balances for USDT/USDC with proper decimal formatting
 - Wallet watcher with polling interval and email alerts
 - Noise protection: integer micro‑USD math + confirmation recheck to avoid false positives

Setup
1) Install Node.js 18+.
2) Install deps:
	 - bash
	 - npm install
3) (Optional) Create a .env file to override RPC URLs:
	 RPC_ETH=YOUR_ETH_RPC
	 RPC_POLYGON=YOUR_POLYGON_RPC
	 RPC_BSC=YOUR_BSC_RPC
	 RPC_ARBITRUM=YOUR_ARBITRUM_RPC
	 RPC_OPTIMISM=YOUR_OPTIMISM_RPC
	 RPC_BASE=YOUR_BASE_RPC
	 RPC_AVAX=YOUR_AVALANCHE_RPC
	 RPC_FANTOM=YOUR_FANTOM_RPC
	 RPC_GNOSIS=YOUR_GNOSIS_RPC
	 RPC_LINEA=YOUR_LINEA_RPC
	 RPC_ZKSYNC=YOUR_ZKSYNC_RPC
	 RPC_SCROLL=YOUR_SCROLL_RPC
	 RPC_MANTLE=YOUR_MANTLE_RPC
	 RPC_CELO=YOUR_CELO_RPC
	 RPC_OPBNB=YOUR_OPBNB_RPC
	 RPC_ZKEVM=YOUR_ZKEVM_RPC
	 RPC_MOONBEAM=YOUR_MOONBEAM_RPC

Run
- Basic:
	- bash
	- npm run start -- 0xYourAddress

- CSV output:
	- bash
	- npm run start -- 0xYourAddress --csv

- Only specific networks (keys):
	- bash
	- npm run start -- 0xYourAddress --only=eth,polygon,bsc

- Adjust timeout (ms):
	- bash
	- npm run start -- 0xYourAddress --timeout=12000

Watch wallets and email on ~$0.1 changes
- Configure SMTP (env or defaults):
	- .env keys: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, EMAIL_TO, EMAIL_FROM
- Run daemon watcher (JSON config only):
	- bash
	- Create `wallets.json` with structure:
	  [
	    {
	      "user": "alex",
	      "email": "alex@example.com",           # default email for this user's wallets
	      "wallets": [
	        { "label": "exodus", "address": "0x..." },
	        "0xabc...123 metamask",               # string format: address [label] [email]
	        "0xdef...456 exodus alex+alt@mail.com" # wallet-level email override
	      ]
	    }
	  ]
	  Then run: npm run watch -- --config=wallets.json --usdDelta=0.1 --interval=30000
	- Omit --only to watch all configured networks.

Watch multiple wallets
- `wallets.json` supports per-wallet labels and emails under each user; emails are grouped per recipient each cycle.
- String entry format allowed: `0xAddress [label words] [email@domain]`.
- The watcher maintains per-wallet state and sends a single aggregated email per cycle with all changed wallets.

Watcher details
- Polling: yes. Default interval 30000 ms. Change with --interval=MS.
- Threshold: default ~$0.1 stablecoin delta; change with --usdDelta.
- Stablecoins used: USDT, USDC (decimal‑aware formatting and math).
- Anti‑noise protections:
	- Sums balances using integer micro‑USD (no float drift)
	- Confirmation recheck before emailing
	- Optional gating to require transfers and to suppress emails on RPC errors

Email recipient examples
- Per run (overrides .env):
	- bash
	- npm run watch -- 0xYourAddress --usdDelta=0.1 --interval=30000 --emailTo=you@example.com
- Persistent via .env:
	- Set in .env: EMAIL_TO=you@example.com
	- bash
	- npm run watch -- 0xYourAddress --usdDelta=0.1 --interval=30000

Notes on multi-wallet mode
- Each wallet maintains its own state (last stablecoin total).
- Emails are aggregated per cycle; recipients are grouped by wallet-specific email (fallback to EMAIL_TO/--emailTo).
- Concurrency for polling can be tuned via `--concurrency=50` or env `CONCURRENCY`.

Advanced config (env)
- SAFE_CONFIRMATIONS=3               # confirmations to wait before reporting transfers
- REQUIRE_TRANSFER_FOR_EMAIL=false   # set true to only email when transfers observed
- ALLOW_ERRORS_FOR_EMAIL=false       # set true to allow emailing even if some chains error

Supported networks and keys
eth, polygon, bsc, arbitrum, optimism, base, avalanche, fantom, gnosis, linea, zksync, scroll, mantle, celo, opbnb, zkevm, moonbeam

Notes
- Public RPCs can be rate-limited or slow; prefer provider RPCs (Alchemy/Infura/QuickNode/etc.).
- Balances shown are native coin amounts (ETH, MATIC, BNB, etc.).

Web + Server (optional)
- Server (Express) in ./server:
	- API: GET/POST /api/wallets, GET /api/status, POST /api/watcher/start|stop
	- Start: from repo root, run the server with Node 18+
- Web (React + Vite) in ./web:
	- Dev: from ./web run npm install && npm run dev
