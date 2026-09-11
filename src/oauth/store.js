import crypto from "crypto";
import { prisma } from "../prisma.js";
// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function createClient({ clientName, redirectUris }) {
    const clientSecret = crypto.randomBytes(32).toString("hex");
    const client = await prisma.oAuthClient.create({
        data: { clientSecret, clientName, redirectUris },
    });
    return { clientId: client.id, clientSecret };
}

export async function getClient(clientId) {
    return prisma.oAuthClient.findUnique({ where: { id: clientId } });
}

export function isValidRedirectUri(client, redirectUri) {
    const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
    if (redirectUri === CLAUDE_CALLBACK) return true;
    return client.redirectUris.includes(redirectUri);
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export async function createAuthCode({ clientId, userId, redirectUri, codeChallenge }) {
    await prisma.oAuthCode.deleteMany({
        where: { clientId, userId, expiresAt: { lt: new Date() } },
    });

    const code = crypto.randomBytes(16).toString("hex");
    await prisma.oAuthCode.create({
        data: {
            code,
            clientId,
            userId,
            redirectUri,
            codeChallenge,
            codeChallengeMethod: "S256",
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
    });
    return code;
}

export async function consumeAuthCode(code) {
    const record = await prisma.oAuthCode.findUnique({ where: { code } });
    if (!record) return null;
    if (record.expiresAt < new Date()) {
        await prisma.oAuthCode.delete({ where: { code } });
        return null;
    }
    await prisma.oAuthCode.delete({ where: { code } });
    return record;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function createTokenPair({ clientId, userId }) {
    const accessToken = crypto.randomBytes(32).toString("hex");
    const refreshToken = crypto.randomBytes(40).toString("hex");

    await prisma.oAuthToken.create({
        data: {
            accessToken,
            refreshToken,
            clientId,
            userId,
            accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
            refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
    });

    return { accessToken, refreshToken };
}

export async function getTokenSession(accessToken) {
    const record = await prisma.oAuthToken.findUnique({ where: { accessToken } });
    if (!record) return null;
    if (record.revokedAt) return null;
    if (record.accessExpiresAt < new Date()) return null;
    return record;
}

export async function rotateRefreshToken(refreshToken) {
    const record = await prisma.oAuthToken.findUnique({ where: { refreshToken } });
    if (!record) return null;
    if (record.revokedAt) return null;
    if (!record.refreshExpiresAt || record.refreshExpiresAt < new Date()) return null;

    await prisma.oAuthToken.update({
        where: { id: record.id },
        data: { revokedAt: new Date() },
    });

    return createTokenPair({ clientId: record.clientId, userId: record.userId });
}

export async function revokeToken(accessToken) {
    await prisma.oAuthToken.updateMany({
        where: { accessToken },
        data: { revokedAt: new Date() },
    });
}

// ---------------------------------------------------------------------------
// Cleanup job
// ---------------------------------------------------------------------------

export async function cleanupExpiredRecords() {
    const now = new Date();
    const [codes, tokens] = await Promise.all([
        prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.oAuthToken.deleteMany({
            where: {
                OR: [
                    { refreshExpiresAt: { lt: now } },
                    { revokedAt: { lt: new Date(now - 7 * 24 * 60 * 60 * 1000) } },
                ],
            },
        }),
    ]);
    console.log(`[oauth:cleanup] Deleted ${codes.count} expired codes, ${tokens.count} expired tokens`);
}

setInterval(cleanupExpiredRecords, 60 * 60 * 1000);