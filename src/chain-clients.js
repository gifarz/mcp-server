/**
 * Shared on-chain read clients — used by:
 *  - wallet-bridge.js, to verify a payment's txHash actually moved the
 *    claimed funds before trusting it (see createEvmVerifier/createSolanaVerifier
 *    in @wyntraxyz/mcp-wallet)
 *  - oauth/routes.js, to verify a wallet-login signature
 *
 * All RPC URLs are overridable via env vars; public endpoints are used as
 * a fallback so the server runs out of the box, but a dedicated RPC
 * provider (Alchemy, Infura, Helius, etc.) is recommended for production.
 */
import { createPublicClient, http, defineChain } from "viem";
import { mainnet, base } from "viem/chains";
import { Connection } from "@solana/web3.js";

// Robinhood Chain — EVM-compatible L2 (Arbitrum Orbit stack), launched
// mainnet July 1, 2026. Not yet in viem/chains' built-in list, so defined
// manually here, mirroring the Wyntrax web app's src/lib/chains.ts.
// Native gas token is ETH; its headline stablecoin is USDG (Global
// Dollar, Paxos), not USDC.
const robinhoodChain = defineChain({
    id: 4663,
    name: "Robinhood",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
        default: { http: [process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"] },
    },
    blockExplorers: {
        default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
    },
});

export const evmClients = {
    ethereum: createPublicClient({
        chain: mainnet,
        transport: http(process.env.ETH_RPC_URL),
    }),
    base: createPublicClient({
        chain: base,
        transport: http(process.env.BASE_RPC_URL),
    }),
    robinhood: createPublicClient({
        chain: robinhoodChain,
        transport: http(), // RPC URL is baked into robinhoodChain above
    }),
};

export const solanaConnection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed"
);
