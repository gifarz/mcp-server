import { getTokenSession } from "./store.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "https://mcp.wyntrax.xyz";

/**
 * In production, mcp.wyntrax.xyz is served by the Wyntrax Next.js app
 * (see its middleware.ts), which already validates the OAuth bearer
 * token itself and proxies the request here (MCP_INTERNAL_URL) with
 * X-User-Id / X-Client-Id headers already resolved. Trust that forwarded
 * identity — but only when it's paired with the shared internal secret,
 * so this endpoint can't be spoofed by anything outside the private
 * network the Next.js app calls in on.
 *
 * Falls back to validating the bearer token directly, which keeps this
 * server usable standalone (local dev, or a deployment that talks to it
 * directly instead of through the Next.js proxy).
 */
export async function requireAuth(req, res, next) {
    const internalSecret = req.headers["x-internal-secret"];
    const forwardedUserId = req.headers["x-user-id"];

    if (
        process.env.MCP_INTERNAL_SECRET &&
        internalSecret === process.env.MCP_INTERNAL_SECRET &&
        forwardedUserId
    ) {
        req.userId = forwardedUserId;
        req.clientId = req.headers["x-client-id"] || null;
        return next();
    }

    const auth = req.headers.authorization;

    if (!auth?.startsWith("Bearer ")) {
        return res
            .status(401)
            .set(
                "WWW-Authenticate",
                `Bearer resource_metadata="${MCP_SERVER_URL}/.well-known/oauth-protected-resource"`
            )
            .json({ error: "unauthorized", error_description: "Bearer token required" });
    }

    const token = auth.slice(7);

    try {
        const session = await getTokenSession(token);

        if (!session) {
            return res
                .status(401)
                .set(
                    "WWW-Authenticate",
                    `Bearer resource_metadata="${MCP_SERVER_URL}/.well-known/oauth-protected-resource", error="invalid_token"`
                )
                .json({ error: "invalid_token", error_description: "Token not found, expired, or revoked" });
        }

        req.userId = session.userId;
        req.clientId = session.clientId;
        next();
    } catch (err) {
        console.error("[oauth:middleware] DB error:", err);
        res.status(500).json({ error: "server_error" });
    }
}
