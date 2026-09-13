/**
 * Wyntrax API Client
 * Calls the /api/mcp/v1/* routes in the Wyntrax Next.js app.
 * Every request is authenticated with X-MCP-Secret (server-to-server,
 * see mcpGuard on the Wyntrax side). Protected routes additionally pass
 * the user's OAuth access token so the app can attribute the action.
 */

const BASE_URL = process.env.NODE_ENV === "development"
    ? process.env.BASE_URL_DEV || "http://localhost:3000/api/mcp/v1"
    : process.env.BASE_URL || "https://wyntrax.xyz/api/mcp/v1";

// The on-chain confirmation poller lives outside /api/mcp — same host, different path.
const STATUS_URL = BASE_URL.replace(/\/api\/mcp\/v1$/, "/api/transactions/status");

// Same for the token-contract lookup — same route the web app's checkout uses,
// so the MCP server and the storefront always agree on which address to pay.
const CONTRACT_URL = BASE_URL.replace(/\/api\/mcp\/v1$/, "/api/contract/usdc");

async function request(path, options = {}, userToken = null) {
    const headers = {
        "Content-Type": "application/json",
        "x-mcp-secret": process.env.MCP_SECRET,
    };

    if (userToken) {
        headers["Authorization"] = `Bearer ${userToken}`;
    }

    const res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: { ...headers, ...options.headers },
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || err.message || `Wyntrax API error: ${res.status}`);
    }

    return res.json();
}

// ─── Creator / discovery (no auth needed) ────────────────────────────────────

/**
 * Search creators by keyword, chain, or category.
 * Maps to: GET /api/mcp/v1/creators?q=...
 */
export async function searchCreators({ query, chain, category, limit = 10 }) {
    const params = new URLSearchParams({ limit });
    if (query) params.set("q", query);
    if (chain) params.set("chain", chain.toUpperCase());
    if (category) params.set("category", category);
    return request(`/creators?${params}`);
}

/**
 * Get a single creator's full profile, products, memberships, goals.
 * Maps to: GET /api/mcp/v1/creators/[slug]
 */
export async function getCreator({ username }) {
    const profile = await request(`/creators/${username}`);

    // Robinhood is EVM-compatible and Wyntrax pays it out through the same
    // wallet as base/eth (see tools.js walletForChain) — but /creators/[slug]
    // never surfaces that as an explicit "robinhood" key, so callers reading
    // this raw profile (rather than re-deriving it themselves) wrongly
    // conclude the creator has no Robinhood wallet. Alias it here.
    if (profile?.wallets) {
        profile.wallets.robinhood =
            profile.wallets.robinhood ?? profile.wallets.base ?? profile.wallets.eth ?? null;
    }

    // /creators/[slug] returns each product's *list* price, not its live
    // discounted price — /products/[id] is the source of truth (it's what
    // request_payment actually charges). Re-fetch each product so anyone
    // quoting a price off get_creator alone doesn't show a stale,
    // non-discounted number.
    if (Array.isArray(profile?.products) && profile.products.length) {
        profile.products = await Promise.all(
            profile.products.map(async (product) => {
                try {
                    const fresh = await getProduct({ productId: product.id });
                    return {
                        ...product,
                        price: fresh.price,
                        ...(fresh.originalPrice != null ? { originalPrice: fresh.originalPrice } : {}),
                        ...(fresh.discountPct != null ? { discountPct: fresh.discountPct } : {}),
                    };
                } catch {
                    return product; // fall back to the stale value rather than dropping the product
                }
            })
        );
    }

    return profile;
}

// ─── User resolution (protected) ─────────────────────────────────────────────

/**
 * Resolve a wallet address → Wyntrax userId.
 * Used before any payment to get the buyer/donor's userId.
 * Maps to: GET /api/mcp/v1/users/resolve?address=...&chain=...
 */
export async function resolveUser(address, chain, userToken) {
    const params = new URLSearchParams({
        address,
        chain: chain.toLowerCase(),
    });
    return request(`/users/resolve?${params}`, {}, userToken);
}

// ─── Donations (protected) ────────────────────────────────────────────────────

/**
 * Register a pending donation after the wallet has signed and submitted.
 * Returns a statusUrl to poll for confirmation.
 * Maps to: POST /api/mcp/v1/donations
 */
export async function registerDonation({
    creatorSlug,
    donorUserId,
    amount,
    usdAmount,
    currency,
    chain,
    txHash,
    message,
    senderAddress,
}, userToken) {
    return request(
        "/donations",
        {
            method: "POST",
            body: JSON.stringify({
                creatorSlug,
                donorUserId: donorUserId ?? null,
                amount,
                usdAmount: usdAmount ?? 0,
                currency,
                chain: chain.toUpperCase(),
                txHash,
                message: message ?? null,
                senderAddress,
            }),
        },
        userToken
    );
}

// ─── Product purchases (protected) ───────────────────────────────────────────

/**
 * Register a pending product purchase after wallet signs.
 * Returns a pre-generated downloadUrl (active once confirmed) + statusUrl.
 * Maps to: POST /api/mcp/v1/transactions
 */
export async function registerPurchase({
    productId,
    buyerUserId,
    amount,
    usdAmount,
    currency,
    chain,
    txHash,
    senderAddress,
}, userToken) {
    return request(
        "/transactions",
        {
            method: "POST",
            body: JSON.stringify({
                productId,
                buyerUserId,
                amount,
                usdAmount: usdAmount ?? 0,
                currency,
                chain: chain.toUpperCase(),
                txHash,
                senderAddress,
            }),
        },
        userToken
    );
}

// ─── Memberships (protected) ──────────────────────────────────────────────────

/**
 * Register a pending membership subscription after wallet signs.
 * Maps to: POST /api/mcp/v1/subscriptions
 */
export async function registerSubscription({
    membershipId,
    subscriberId,
    chain,
    txHash,
    amount,
    usdAmount,
    currency,
    senderAddress,
}, userToken) {
    return request(
        "/subscriptions",
        {
            method: "POST",
            body: JSON.stringify({
                membershipId,
                subscriberId,
                chain: chain.toUpperCase(),
                txHash,
                amount,
                usdAmount: usdAmount ?? 0,
                currency,
                senderAddress,
            }),
        },
        userToken
    );
}

/**
 * Cancel an active subscription.
 * Maps to: DELETE /api/mcp/v1/subscriptions
 */
export async function cancelSubscription({ subscriptionId, subscriberId }, userToken) {
    return request(
        "/subscriptions",
        {
            method: "DELETE",
            body: JSON.stringify({ subscriptionId, subscriberId }),
        },
        userToken
    );
}

// ─── Transaction status polling ───────────────────────────────────────────────

/**
 * Poll the Wyntrax transaction status endpoint.
 * Returns { status: "PENDING" | "CONFIRMING" | "CONFIRMED" | "FAILED" }
 *
 * Note: this calls the main /api/transactions/status route (not /api/mcp/),
 * since that route handles the actual on-chain verification via viem/Solana.
 */
export async function getTransactionStatus(txHash, userToken) {
    const res = await fetch(`${STATUS_URL}?txHash=${txHash}`, {
        headers: {
            "x-mcp-secret": process.env.MCP_SECRET,
            ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}),
        },
    });

    if (!res.ok) return { status: "PENDING" }; // treat errors as still pending
    return res.json();
}

// ─── Analytics (protected, creator only) ─────────────────────────────────────

/**
 * Get earnings analytics for a creator.
 * Maps to: GET /api/mcp/v1/analytics?userId=...&period=...
 */
export async function getAnalytics({ userId, period = "30d" }, userToken) {
    const params = new URLSearchParams({ userId, period });
    return request(`/analytics?${params}`, {}, userToken);
}

/**
 * Get a single product by ID.
 * Maps to: GET /api/mcp/v1/products/[id]
 */
export async function getProduct({ productId }) {
    const product = await request(`/products/${productId}`);

    // Same Robinhood-alias gap as getCreator() above, on the embedded
    // creator object this endpoint returns (ethAddress/baseAddress/solAddress,
    // no robinhoodAddress) — alias it so walletForChain() isn't the only
    // place that knows Robinhood reuses the base wallet.
    if (product?.creator) {
        product.creator.robinhoodAddress =
            product.creator.robinhoodAddress ?? product.creator.baseAddress ?? product.creator.ethAddress ?? null;
    }

    return product;
}

/**
 * Resolve the ERC-20 contract address to pay for a given EVM chain
 * (USDC on ethereum/base, USDG on robinhood). Not an /api/mcp/v1 route —
 * it's the same public endpoint the web checkout (TransactionModal) calls,
 * so this server and the storefront never disagree on where a "USDC"/"USDG"
 * payment actually goes.
 * Maps to: GET /api/contract/usdc?chain=...
 */
export async function getTokenAddress({ chain }) {
    const res = await fetch(`${CONTRACT_URL}?chain=${chain}`);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to resolve token address for ${chain}`);
    }
    const data = await res.json();
    if (!data.address) throw new Error(`No token contract configured for ${chain}`);
    return data.address;
}

/**
 * Search products by name, description, or file type.
 * Maps to: GET /api/mcp/v1/products?q=...&type=...
 */
export async function searchProducts({ query, type, limit = 10 }) {
    const params = new URLSearchParams({ limit });
    if (query) params.set('q', query);
    if (type) params.set('type', type.toUpperCase());
    return request(`/products?${params}`);
}

/**
 * Get a user's purchase history.
 * Maps to: GET /api/mcp/v1/purchases?address=...&chain=...
 */
export async function getMyPurchases({ address, chain }) {
    const params = new URLSearchParams({ address });
    if (chain) params.set('chain', chain.toUpperCase());
    return request(`/purchases?${params}`);
}

// ─── Pro plan (protected) ─────────────────────────────────────────────────────

/**
 * Get Pro plan pricing and the destination wallet address.
 * Maps to: GET /api/mcp/v1/pro
 * Returns: { monthly: { usdPrice, wallet }, yearly: { usdPrice, wallet } }
 * (same wallet is used for both plans on Wyntrax).
 */
export async function getProInfo() {
    return request("/pro");
}

/**
 * Register a pending Pro plan upgrade after wallet signs.
 * Returns a statusUrl to poll for confirmation.
 * Maps to: POST /api/mcp/v1/pro
 */
export async function registerProUpgrade({
    plan,
    buyerUserId,
    amount,
    usdAmount,
    currency,
    chain,
    txHash,
    senderAddress,
}, userToken) {
    return request(
        "/pro",
        {
            method: "POST",
            body: JSON.stringify({
                plan,
                buyerUserId,
                amount,
                usdAmount: usdAmount ?? 0,
                currency,
                chain: chain.toUpperCase(),
                txHash,
                senderAddress,
            }),
        },
        userToken
    );
}