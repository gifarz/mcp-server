# Wyntrax MCP Server

Connect Claude to Wyntrax and interact with your favorite creators using natural language — tip them, buy their digital products, manage memberships, and more. All on-chain, no forms, no copy-pasting wallet addresses.

---

## What you can do

Once connected, just tell Claude what you want:

> _"Tip @alexbuilds 5 USDC on Base"_
> _"Buy the Web3 Dev Guide from @alexbuilds"_
> _"Show me all my purchases"_
> _"Find creators selling video courses about web3"_
> _"What products does @demo have? How big are the files?"_
> _"Subscribe to @alexbuilds Builder tier"_
> _"Show me my earnings for the last 30 days"_
> _"Send 10 USDG to @alexbuilds on Robinhood"_

---

## Getting started

### 1. Connect Wyntrax to Claude

1. Open **Claude.ai** and go to **Settings → Integrations**
2. Click **Add custom connector**
3. Enter the server URL:
   ```
   https://mcp.wyntrax.xyz
   ```
4. Click **Add** — you're connected!

### 2. Start chatting

That's it. Just start talking to Claude naturally. For actions that require your account (buying, tipping, memberships), Claude will prompt you to connect your wallet to Wyntrax the first time — sign a message with MetaMask or Phantom, no password needed.

---

## What you can ask Claude

### Discover creators

- _"Find web3 developers on Wyntrax"_
- _"Show me creators on Base selling PDF guides"_
- _"Tell me about @alexbuilds"_

### Browse products

- _"What products does @demo sell?"_
- _"Find tutorial PDFs on Wyntrax"_
- _"Show me free products from @alexbuilds"_
- _"How big is the Wyntrax Docs file?"_

### Buy & download

- _"Buy the Wyntrax product from @demo for 0.5 ETH"_
- _"Show me my purchases and download links"_

### Tip creators

- _"Send 10 USDC to @alexbuilds on Ethereum"_
- _"Tip @demo 0.01 ETH with the message 'great content!'"_
- _"Send 5 USDG to @alexbuilds on Robinhood"_

### Memberships

- _"Subscribe to @alexbuilds Builder tier"_
- _"Cancel my subscription to @demo"_

### Analytics (creators only)

- _"Show me my earnings for the last 30 days"_
- _"What are my top selling products this month?"_

---

## How purchases work

1. Claude finds the product and shows you the details
2. Claude requests wallet approval via `request_payment` — a signing prompt goes to your connected wallet (powered by `@wyntraxyz/mcp-wallet`)
3. Once you approve, the transaction is submitted on-chain
4. Claude registers the purchase and confirms it on-chain
5. Your download link is ready instantly once confirmed

> Confirmations typically take 15–60 seconds depending on the network.

---

## Available tools

| Tool                | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `search_creators`   | Find creators by keyword, blockchain, or category                      |
| `get_creator`       | View a creator's full profile, products, and membership tiers          |
| `get_product`       | Get product details including title, price, description, and file size |
| `search_products`   | Search products by name or type (PDF, video, audio, etc.)              |
| `get_my_purchases`  | View your confirmed purchases and download links                       |
| `send_donation`     | Tip a creator in ETH, USDC, or USDG                                     |
| `buy_product`       | Purchase a digital download                                            |
| `manage_membership` | Subscribe to or cancel a creator's membership tier                     |
| `get_analytics`     | View your earnings and supporter stats (creators only)                 |
| `get_pro_info`      | View Wyntrax Pro plan pricing and the destination wallet               |
| `upgrade_to_pro`    | Upgrade an account to Wyntrax Pro after sending payment                |
| `request_payment`   | Ask the connected wallet to approve a product, donation, or Pro payment |

---

## Supported blockchains

- **Ethereum**
- **Base**
- **Robinhood** — pay with ETH or USDG (Robinhood's stablecoin — USDC is not used there)
- **Solana**

---

## Architecture

- `src/index.js` — stdio MCP entrypoint (local/dev use with Claude Desktop)
- `src/index.http.js` — StreamableHTTP MCP entrypoint, deployed behind `mcp.wyntrax.xyz`
- `src/wyntrax-client.js` — REST client for the Wyntrax app's `/api/mcp/v1/*` routes
- `src/wallet-bridge.js` — wraps `@wyntraxyz/mcp-wallet` to request wallet signatures for payments, with on-chain verification (`createEvmVerifier`/`createSolanaVerifier`) so a payment can't be marked confirmed without a real, matching transaction
- `src/chain-clients.js` — shared viem (EVM) and `@solana/web3.js` (Solana) read clients, used by the payment verifier above and by OAuth login-signature verification
- `src/oauth/*` — OAuth 2.0 authorization server (PKCE, dynamic client registration) with wallet-signature login rendered via `@wyntraxyz/mcp-wallet-ui`
- `src/tools.js` — the MCP tool definitions Claude calls

In production, `mcp.wyntrax.xyz` is served by the main Wyntrax Next.js app, which rewrites requests to this server (`MCP_INTERNAL_URL`) and forwards an already-verified `X-User-Id` header — see `src/oauth/middleware.js`. This server also works standalone (its own OAuth + bearer-token validation) for local development.

### Wallet packages

| Package                          | Role                                                                 | Used here? |
| --------------------------------- | --------------------------------------------------------------------- | ---------- |
| `@wyntraxyz/mcp-wallet`            | Core wallet-bridge (`createWalletBridge`, `PrismaAdapter`, `createEvmVerifier`, `createSolanaVerifier`, `formatBridgeResult`) | Yes — `wallet-bridge.js` |
| `@wyntraxyz/mcp-wallet-adapters`   | Extra storage adapter for the bridge (`RedisAdapter`, via `ioredis`) — an alternative to `PrismaAdapter` for multi-process deployments | Yes, optional — set `REDIS_URL` to use it instead of Prisma |
| `@wyntraxyz/mcp-wallet-ui`         | React `<WalletApproval />` component + hooks, for the page a user lands on to approve a pending payment | No — this is a frontend package. It's rendered by the **Wyntrax web app** at `/wallet/approve/[id]` (`WALLET_APPROVAL_URL`), not by this Express server, which never renders React |

The OAuth wallet-connect/login page (`GET /oauth/authorize`) is separate from all of the above — it's hand-rolled HTML in `src/oauth/routes.js`, since there's no prebuilt "connect + sign in" UI in `@wyntraxyz/mcp-wallet-ui` (its `<WalletApproval />` is specifically for approving one pending *payment* request, not for logging in). Signature verification for login uses `viem` (EVM) and `tweetnacl`/`bs58` (Solana) directly.

---

## Need help?

Visit [wyntrax.xyz](https://wyntrax.xyz) or reach out through the Wyntrax community.
