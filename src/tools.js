/**
 * Wyntrax MCP Tool Definitions
 *
 * Auth strategy:
 * - Local/dev: pass walletAddress directly, resolved to userId via /api/mcp/v1/users/resolve
 * - Production: OAuth flow — sessionId here is the caller's userId, set by
 *   index.http.js after the OAuth bearer token (or trusted internal proxy
 *   header) is validated.
 */

import { z } from "zod";
import * as api from "./wyntrax-client.js";
import { formatBridgeResult } from "@wyntraxyz/mcp-wallet";
import { bridge } from "./wallet-bridge.js";

function ok(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
    return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

async function pollConfirmation(txHash) {
    const MAX_ATTEMPTS = 24;
    const INTERVAL_MS = 5000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, INTERVAL_MS));
        const result = await api.getTransactionStatus(txHash);
        if (result.status === "CONFIRMED") return { confirmed: true };
        if (result.status === "FAILED") return { confirmed: false, failed: true };
    }
    return { confirmed: false, timeout: true };
}

function getExplorerUrl(txHash, chain) {
    if (chain === "solana") return `https://solscan.io/tx/${txHash}`;
    if (chain === "base") return `https://basescan.org/tx/${txHash}`;
    if (chain === "robinhood") return `https://robinhoodchain.blockscout.com/tx/${txHash}`; // Blockscout, not Etherscan
    return `https://etherscan.io/tx/${txHash}`;
}

// Wyntrax's User model exposes ethAddress / baseAddress / solAddress —
// pick the right one for the chain the payment is going out on. Robinhood
// is EVM-compatible and reuses the same address as ethAddress/baseAddress
// (Wyntrax stores it under both on signup — see validate-wallet.ts).
function walletForChain(entity, chain) {
    if (chain === "solana") return entity?.solAddress;
    if (chain === "base" || chain === "robinhood") return entity?.baseAddress ?? entity?.ethAddress;
    return entity?.ethAddress;
}

// ─── Tool registry ────────────────────────────────────────────────────────────

export function registerTools(server, sessionId) {

    // ── 1. search_creators ──────────────────────────────────────────────────────
    server.tool(
        "search_creators",
        "Search and discover creators on Wyntrax. Filter by keyword, blockchain, or content category.",
        {
            query: z.string().describe("Search term, e.g. 'web3 developer', 'music producer'"),
            chain: z.enum(["ethereum", "base", "robinhood", "solana"]).optional().describe("Filter by chain"),
            category: z.string().optional().describe("Content category e.g. 'music', 'dev', 'art'"),
            limit: z.number().min(1).max(50).default(10).describe("Number of results"),
        },
        async ({ query, chain, category, limit }) => {
            try {
                const results = await api.searchCreators({ query, chain, category, limit });
                return ok(results);
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 2. get_creator ──────────────────────────────────────────────────────────
    server.tool(
        "get_creator",
        "Get a creator's full profile: bio, earnings, products, and membership tiers.",
        {
            username: z.string().describe("Wyntrax username or slug, e.g. 'alexbuilds'"),
        },
        async ({ username }) => {
            try {
                const profile = await api.getCreator({ username });
                return ok(profile);
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 3. send_donation ────────────────────────────────────────────────────────
    server.tool(
        "send_donation",
        "Register a confirmed crypto donation to a creator on Wyntrax.",
        {
            username: z.string().describe("Creator's Wyntrax username or slug"),
            amount: z.number().describe("Token amount e.g. 5 for 5 USDC"),
            currency: z.enum(["ETH", "USDC", "USDG"]).describe("Token to send — USDG is Robinhood's stablecoin, used instead of USDC there"),
            chain: z.enum(["ethereum", "base", "robinhood", "solana"]).describe("Blockchain used"),
            txHash: z.string().describe("On-chain transaction hash"),
            senderAddress: z.string().describe("Sender wallet address"),
            usdAmount: z.number().optional().describe("USD equivalent at time of tx"),
            message: z.string().max(280).optional().describe("Optional on-chain message"),
            donorAddress: z.string().optional().describe("Donor wallet address to resolve their Wyntrax account"),
        },
        async ({ username, amount, currency, chain, txHash, senderAddress, usdAmount, message, donorAddress }) => {
            try {
                // Optionally resolve donor
                let donorUserId = null;
                if (donorAddress) {
                    const wallet = await api.resolveUser(donorAddress, chain);
                    donorUserId = wallet.user?.id ?? null;
                }

                const pending = await api.registerDonation({
                    creatorSlug: username,
                    donorUserId,
                    amount,
                    usdAmount: usdAmount ?? 0,
                    currency,
                    chain: chain.toUpperCase(),
                    txHash,
                    message,
                    senderAddress,
                });

                if (pending.duplicate) {
                    return ok({ status: "already_recorded", txHash });
                }

                const result = await pollConfirmation(txHash);
                if (result.confirmed) {
                    return ok({
                        status: "success",
                        message: `Donation of ${amount} ${currency} to @${username} confirmed!`,
                        txHash,
                        explorerUrl: getExplorerUrl(txHash, chain),
                    });
                }
                if (result.failed) return ok({ status: "failed", message: "Transaction reverted on-chain.", txHash });
                if (result.timeout) return ok({ status: "pending", message: "Transaction submitted but not yet confirmed.", txHash, explorerUrl: getExplorerUrl(txHash, chain) });
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 4. buy_product ──────────────────────────────────────────────────────────
    server.tool(
        "buy_product",
        "Register a confirmed on-chain product purchase on Wyntrax and get the download link.",
        {
            product_id: z.string().describe("Product ID from get_creator"),
            amount: z.number().describe("Amount paid"),
            currency: z.enum(["ETH", "USDC", "USDG"]),
            chain: z.enum(["ethereum", "base", "robinhood", "solana"]),
            txHash: z.string().describe("On-chain transaction hash"),
            senderAddress: z.string().describe("Buyer wallet address"),
            usdAmount: z.number().optional(),
        },
        async ({ product_id, amount, currency, chain, txHash, senderAddress, usdAmount }) => {
            try {
                // Resolve buyer
                const wallet = await api.resolveUser(senderAddress, chain);
                const buyerUserId = wallet.user?.id ?? null;

                const pending = await api.registerPurchase({
                    productId: product_id,
                    buyerUserId,
                    amount,
                    usdAmount: usdAmount ?? 0,
                    currency,
                    chain: chain.toUpperCase(),
                    txHash,
                    senderAddress,
                });

                if (pending.duplicate) {
                    return ok({ status: "already_recorded", txHash, downloadUrl: pending.downloadUrl });
                }

                const result = await pollConfirmation(txHash);
                if (result.confirmed) {
                    return ok({
                        status: "success",
                        message: "Purchase confirmed! Your download is ready.",
                        downloadUrl: pending.downloadUrl,
                        txHash,
                    });
                }
                if (result.failed) return ok({ status: "failed", message: "Transaction reverted.", txHash });
                if (result.timeout) return ok({ status: "pending", message: "Not yet confirmed. Download ready once confirmed.", downloadUrl: pending.downloadUrl, txHash });
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 5. manage_membership ────────────────────────────────────────────────────
    server.tool(
        "manage_membership",
        "Subscribe to or cancel a creator's membership tier on Wyntrax.",
        {
            action: z.enum(["subscribe", "cancel"]).describe("subscribe or cancel"),
            tier_id: z.string().optional().describe("Membership tier ID — required for subscribe"),
            subscription_id: z.string().optional().describe("Subscription ID — required for cancel"),
            chain: z.enum(["ethereum", "base", "robinhood", "solana"]).optional(),
            txHash: z.string().optional().describe("On-chain tx hash — required for subscribe"),
            amount: z.number().optional(),
            usdAmount: z.number().optional(),
            currency: z.enum(["ETH", "USDC", "USDG"]).optional(),
            senderAddress: z.string().optional().describe("Subscriber wallet address"),
        },
        async ({ action, tier_id, subscription_id, chain, txHash, amount, usdAmount, currency, senderAddress }) => {
            try {
                if (action === "subscribe") {
                    if (!tier_id || !txHash || !chain || !amount || !currency || !senderAddress) {
                        return err("subscribe requires: tier_id, txHash, chain, amount, currency, senderAddress");
                    }

                    const wallet = await api.resolveUser(senderAddress, chain);
                    const subscriberId = wallet.user?.id ?? null;

                    const pending = await api.registerSubscription({
                        membershipId: tier_id,
                        subscriberId,
                        chain: chain.toUpperCase(),
                        txHash,
                        amount,
                        usdAmount: usdAmount ?? 0,
                        currency,
                        senderAddress,
                    });

                    if (pending.duplicate) {
                        return ok({ status: "already_subscribed", message: pending.message });
                    }

                    const result = await pollConfirmation(txHash);
                    if (result.confirmed) return ok({ status: "success", message: "Subscription confirmed!", txHash });
                    if (result.failed) return ok({ status: "failed", message: "Transaction reverted.", txHash });
                    if (result.timeout) return ok({ status: "pending", txHash });
                }

                if (action === "cancel") {
                    if (!subscription_id || !senderAddress || !chain) {
                        return err("cancel requires: subscription_id, senderAddress, chain");
                    }
                    const wallet = await api.resolveUser(senderAddress, chain);
                    const result = await api.cancelSubscription({
                        subscriptionId: subscription_id,
                        subscriberId: wallet.user?.id,
                    });
                    return ok(result);
                }
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 6. get_analytics ────────────────────────────────────────────────────────
    server.tool(
        "get_analytics",
        "Get earnings analytics for a Wyntrax creator: revenue, top products, supporter stats.",
        {
            wallet_address: z.string().describe("Creator's wallet address"),
            chain: z.enum(["ethereum", "base", "robinhood", "solana"]).default("ethereum").describe("Chain the wallet is on"),
            period: z.enum(["7d", "30d", "90d", "1y"]).default("30d").describe("Time period"),
        },
        async ({ wallet_address, chain, period }) => {
            try {
                const wallet = await api.resolveUser(wallet_address, chain);

                if (!wallet.user) {
                    return err("No Wyntrax account found for this wallet address");
                }
                if (!wallet.user.isCreator) {
                    return err("This wallet belongs to a user but they are not a creator on Wyntrax");
                }

                const analytics = await api.getAnalytics({ userId: wallet.user.id, period });
                return ok(analytics);
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 7. get_product ──────────────────────────────────────────────────────────
    server.tool(
        "get_product",
        "Get a product's details by ID: title, price, description, and creator info.",
        {
            product_id: z.string().describe("Product ID from get_creator or buy_product"),
        },
        async ({ product_id }) => {
            try {
                const product = await api.getProduct({ productId: product_id });
                return ok(product);
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 8. search_products ──────────────────────────────────────────────────────
    server.tool(
        "search_products",
        "Search for products on Wyntrax by name or description. Filter by file type.",
        {
            query: z.string().describe("Search term e.g. 'tutorial', 'web3 guide', 'music'"),
            type: z.enum(["PDF", "VIDEO", "AUDIO", "IMAGE", "OTHER"])
                .optional()
                .describe("Filter by file type"),
            limit: z.number().min(1).max(50).default(10).describe("Number of results"),
        },
        async ({ query, type, limit }) => {
            try {
                const results = await api.searchProducts({ query, type, limit });
                return ok(results);
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 9. get_my_purchases ─────────────────────────────────────────────────────
    server.tool(
        "get_my_purchases",
        "Get a buyer's confirmed purchases and download URLs by wallet address.",
        {
            wallet_address: z.string().describe("Buyer wallet address"),
            chain: z.enum(["ethereum", "base", "robinhood", "solana"])
                .optional()
                .describe("Filter by chain. Omit to return purchases across all chains."),
        },
        async ({ wallet_address, chain }) => {
            try {
                const result = await api.getMyPurchases({ address: wallet_address, chain });
                return ok(result);
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 10. get_pro_info ─────────────────────────────────────────────────────
    server.tool(
        "get_pro_info",
        "Get Wyntrax Pro plan pricing and the wallet address to send payment to.",
        {},
        async () => {
            try {
                const data = await api.getProInfo();
                return ok(data);
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 11. upgrade_to_pro ─────────────────────────────────────────────────────
    server.tool(
        "upgrade_to_pro",
        "Upgrade a user to Wyntrax Pro plan. Send crypto to the pro wallet first, then call this with the txHash.",
        {
            plan: z.enum(["monthly", "yearly"]),
            buyerUserId: z.string(),
            amount: z.number(),
            usdAmount: z.number().optional(),
            currency: z.enum(["ETH", "USDC", "USDG"]),
            chain: z.enum(["ethereum", "base", "robinhood", "solana"]),
            txHash: z.string(),
            senderAddress: z.string(),
        },
        async (args) => {
            try {
                const pending = await api.registerProUpgrade(args);

                if (pending.duplicate) {
                    return ok({ status: "already_recorded", txHash: args.txHash });
                }

                const result = await pollConfirmation(args.txHash);
                if (result.confirmed) {
                    return ok({
                        success: true,
                        plan: args.plan,
                        message: `Pro plan (${args.plan}) activated successfully!`,
                    });
                }
                if (result.failed) return err("Transaction failed on-chain");
                return err("Confirmation timeout — check txHash manually");
            } catch (e) {
                return err(e.message);
            }
        }
    );

    // ── 12. request_payment ─────────────────────────────────────────────────────
    server.tool(
        "request_payment",
        "Request wallet approval to pay on Wyntrax. Supports product purchases, donations to creators, and Pro plan upgrades.",
        {
            type: z.enum(["product", "donation", "pro"]).describe(
                "Payment type: 'product' to buy a product, 'donation' to tip a creator, 'pro' to upgrade the user's Wyntrax account"
            ),
            chain: z.enum(["ethereum", "base", "robinhood", "solana"]),
            currency: z.enum(["ETH", "USDC", "USDG", "SOL"]).describe("Token to pay with — USDG is Robinhood's stablecoin, used instead of USDC there"),

            // product
            product_id: z.string().optional().describe("Required for type='product'"),

            // donation
            creator_username: z.string().optional().describe("Required for type='donation'"),
            donation_amount: z.number().optional().describe("Required for type='donation'. USD equivalent amount to donate."),

            // pro
            plan: z.enum(["monthly", "yearly"]).optional().describe("Required for type='pro'"),
        },
        async ({ type, chain, currency, product_id, creator_username, donation_amount, plan }) => {
            try {
                // ── shared: fetch live exchange rate for native-currency payments ──
                // Only used for ETH/SOL. USDC/USDG are USD-pegged 1:1 and are built
                // as an ERC-20 token_transfer below, never through this path.
                async function toNativeAmount(usdAmount) {
                    const coinId = currency === "ETH" ? "ethereum" : "solana";
                    const rateRes = await fetch(
                        `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`
                    );
                    const rateData = await rateRes.json();
                    const usdPerToken = rateData[coinId].usd;
                    return (usdAmount / usdPerToken).toFixed(6);
                }

                // ── shared: build the right transaction shape for the chosen currency ──
                // CRITICAL: USDC/USDG must never be sent as a plain `transfer` with
                // `value: <usd amount>` — the bridge/wallet-approval UI would sign that
                // as that many units of the chain's *native* currency (e.g. "100" would
                // become 100 ETH, worth ~$250k, instead of 100 USDC/USDG). Stablecoins on
                // EVM chains have to go through an explicit ERC-20 `token_transfer`
                // (contract address + 6 decimals), which @wyntraxyz/mcp-wallet already
                // supports — this just wasn't wired up for any of the three payment types.
                async function buildTransaction(usdAmount, to, metadata) {
                    if (currency === "USDC" || currency === "USDG") {
                        if (chain === "solana") {
                            // SPL-token USDC on Solana is a different transfer mechanism
                            // (associated token accounts, not an EVM contract call) and
                            // isn't wired up yet — fail loudly rather than silently
                            // mis-building a transfer.
                            throw new Error(`${currency} on Solana isn't supported yet — use SOL instead`);
                        }
                        const tokenAddress = await api.getTokenAddress({ chain });
                        return {
                            type: "token_transfer",
                            chain,
                            to,
                            tokenAddress,
                            amount: usdAmount.toString(), // USD-pegged 1:1
                            decimals: 6,
                            metadata,
                        };
                    }

                    // ETH or SOL — native currency, needs live conversion from USD.
                    const finalPrice = await toNativeAmount(usdAmount);
                    return {
                        type: "transfer",
                        chain,
                        to,
                        value: finalPrice,
                        metadata,
                    };
                }

                // ── product ───────────────────────────────────────────────────────
                if (type === "product") {
                    if (!product_id) return err("product_id is required for type='product'");

                    const product = await api.getProduct({ productId: product_id });
                    const creatorWallet = walletForChain(product.creator, chain);

                    if (!creatorWallet) {
                        return err(`This creator has no wallet connected on ${chain}`);
                    }

                    const transaction = await buildTransaction(product.price, creatorWallet, {
                        action: "buy_product",
                        productId: product_id,
                        productName: product.title,
                        currency,
                        originalPrice: `${product.price} USDC`,
                    });

                    const pending = await bridge.requestSignature({ sessionId, transaction });

                    return ok(formatBridgeResult(pending));
                }

                // ── donation ──────────────────────────────────────────────────────
                if (type === "donation") {
                    if (!creator_username) return err("creator_username is required for type='donation'");
                    if (!donation_amount || donation_amount <= 0) return err("donation_amount must be a positive number for type='donation'");

                    const creator = await api.getCreator({ username: creator_username });
                    const creatorWallet = walletForChain(creator, chain);

                    if (!creatorWallet) {
                        return err(`Creator @${creator_username} has no wallet on ${chain}`);
                    }

                    const transaction = await buildTransaction(donation_amount, creatorWallet, {
                        action: "donation",
                        creatorUsername: creator_username,
                        currency,
                        originalAmount: `${donation_amount} USD`,
                    });

                    const pending = await bridge.requestSignature({ sessionId, transaction });

                    return ok(formatBridgeResult(pending));
                }

                // ── pro ───────────────────────────────────────────────────────────
                if (type === "pro") {
                    if (!plan) return err("plan ('monthly' or 'yearly') is required for type='pro'");

                    // Fetch canonical Pro pricing and destination wallet from the platform.
                    // GET /api/mcp/v1/pro → { monthly: { usdPrice, wallet }, yearly: { usdPrice, wallet } }
                    const proData = await api.getProInfo();
                    const planInfo = proData[plan];

                    if (!planInfo?.wallet) {
                        return err(`Pro plan payments are not configured for '${plan}'`);
                    }

                    const transaction = await buildTransaction(planInfo.usdPrice, planInfo.wallet, {
                        action: "upgrade_to_pro",
                        plan,
                        currency,
                        originalPrice: `${planInfo.usdPrice} USD`,
                    });

                    const pending = await bridge.requestSignature({ sessionId, transaction });

                    return ok(formatBridgeResult(pending));
                }

                return err(`Unknown payment type: ${type}`);
            } catch (e) {
                return err(e.message);
            }
        }
    );
}