/**
 * Wallet bridge — lets an MCP tool ask the connected wallet (MetaMask,
 * Phantom, etc.) to sign/send a transaction before the server records a
 * payment. The approval page itself is a React page (built with
 * `<WalletApproval />` from @wyntraxyz/mcp-wallet-ui) hosted by the
 * Wyntrax *web app*, not by this server — this server only creates the
 * pending request and gets back an approvalUrl to hand to the user.
 *
 * `verify` is configured so resolve() checks the claimed txHash/signature
 * against on-chain reality (see @wyntraxyz/mcp-wallet's verify.js) rather
 * than trusting whatever a caller of /resolve sends.
 */
import {
    createWalletBridge,
    PrismaAdapter,
    createEvmVerifier,
    createSolanaVerifier,
    isEvmChain,
    isSolanaChain,
} from "@wyntraxyz/mcp-wallet";

import { prisma } from "./prisma.js";
import { evmClients, solanaConnection } from "./chain-clients.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "https://mcp.wyntrax.xyz";

// Storage: Redis (via @wyntraxyz/mcp-wallet-adapters) when REDIS_URL is
// set — recommended once this runs as more than one process — otherwise
// Prisma against the same DB the Wyntrax app uses.
let storage = new PrismaAdapter(prisma);
if (process.env.REDIS_URL) {
    const { RedisAdapter } = await import("@wyntraxyz/mcp-wallet-adapters");
    const { default: Redis } = await import("ioredis");
    storage = new RedisAdapter(new Redis(process.env.REDIS_URL));
}

const verifyEvm = createEvmVerifier({ publicClient: evmClients, amountTolerance: 0.001 });
const verifySolana = createSolanaVerifier({ connection: solanaConnection });

async function verify(request, result) {
    const { chain } = request.transaction;
    if (isEvmChain(chain)) return verifyEvm(request, result);
    if (isSolanaChain(chain)) return verifySolana(request, result);
    return { ok: false, reason: `Unsupported chain: ${chain}` };
}

export const bridge = createWalletBridge({
    approvalBaseUrl: process.env.WALLET_APPROVAL_URL || "https://wyntrax.xyz/wallet/approve",
    storage,
    ttl: 600,
    verify,
    onResolved: async (req) => {
        console.log(`[wallet-bridge] ${req.id} → ${req.status}`);
    },
});
