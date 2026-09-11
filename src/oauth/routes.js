import crypto from "crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { evmClients } from "../chain-clients.js";
import {
    createClient,
    getClient,
    isValidRedirectUri,
    createAuthCode,
    consumeAuthCode,
    createTokenPair,
    rotateRefreshToken,
} from "./store.js";
import { prisma } from "../prisma.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "https://mcp.wyntrax.xyz";

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too_many_requests", error_description: "Too many attempts, try again later" },
});

const tokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too_many_requests", error_description: "Too many attempts, try again later" },
});

// ---------------------------------------------------------------------------
// Wallet-signature login
//
// Wyntrax authenticates by wallet signature, not username/password — the
// user picks MetaMask or Phantom, signs a one-time challenge message, and
// that proves ownership of the wallet tied to their Wyntrax account.
// ---------------------------------------------------------------------------

// nonce → { address, message, expiresAt }. In production, back this with
// Redis (or the DB, like store.js does for codes/tokens) if this server
// runs on more than one instance.
const nonceStore = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000;

function issueChallenge(address) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const message = `Sign this message to authorize Claude to access your Wyntrax account.\n\nAddress: ${address}\nNonce: ${nonce}`;
    nonceStore.set(nonce, { address, message, expiresAt: Date.now() + NONCE_TTL_MS });
    setTimeout(() => nonceStore.delete(nonce), NONCE_TTL_MS);
    return { nonce, message };
}

function consumeChallenge(nonce, address) {
    const entry = nonceStore.get(nonce);
    if (!entry) return null;
    nonceStore.delete(nonce);
    if (entry.expiresAt < Date.now()) return null;
    if (entry.address !== address) return null;
    return entry.message;
}

/**
 * Verify a signed login challenge. @wyntraxyz/mcp-wallet's verify helpers
 * (createEvmVerifier/createSolanaVerifier) are built for the payment bridge's
 * resolve() flow (PendingRequest/PendingResult shapes) — for a plain login
 * signature we verify directly: viem's verifyMessage for EVM (ECDSA/ERC-1271),
 * tweetnacl for Solana (ed25519), same as Wyntrax's own wallet-login route.
 */
async function verifySignature({ chain, address, message, signature }) {
    try {
        if (chain === "solana") {
            const messageBytes = new TextEncoder().encode(message);
            const signatureBytes = Buffer.from(signature, "base64"); // client sends base64 — see renderConnectWalletPage
            const pubKeyBytes = bs58.decode(address); // Solana addresses are base58
            return nacl.sign.detached.verify(messageBytes, signatureBytes, pubKeyBytes);
        }

        const client = evmClients[chain] || evmClients.ethereum;
        return await client.verifyMessage({ address, message, signature });
    } catch (err) {
        console.error("[oauth] signature verification error:", err);
        return false;
    }
}

/**
 * Verify a signed challenge and find (or create) the matching Wyntrax user.
 */
async function findOrCreateUserByWallet({ chain, address, message, signature }) {
    const valid = await verifySignature({ chain, address, message, signature });
    if (!valid) return null;

    // Ethereum, Base, and Robinhood are all EVM — same signature works for
    // all three, so Wyntrax stores/looks these up as one address across
    // ethAddress + baseAddress rather than a field per chain (see the web
    // app's validate-wallet.ts). Solana is its own address space.
    const isEvm = chain !== "solana";

    let user = await prisma.user.findFirst({
        where: isEvm
            ? { OR: [{ ethAddress: { equals: address, mode: "insensitive" } }, { baseAddress: { equals: address, mode: "insensitive" } }] }
            : { solAddress: address },
    });

    if (!user) {
        user = await prisma.user.create({
            data: {
                username: `wallet_${address.replace("0x", "").slice(0, 6).toLowerCase()}_${crypto.randomBytes(3).toString("hex")}`,
                ...(isEvm ? { ethAddress: address, baseAddress: address } : { solAddress: address }),
            },
        });
    }

    return user;
}

/**
 * Minimal wallet-connect page: pick MetaMask or Phantom, sign the
 * one-time challenge, POST the result back here to get an auth code.
 * (There's no prebuilt "connect + login" UI in @wyntraxyz/mcp-wallet-ui —
 * that package's <WalletApproval /> is for approving a specific pending
 * payment on the Wyntrax web app, not for OAuth login — so this page is
 * hand-rolled, same as Wyntrax's own /api/mcp/oauth/authorize page.)
 */
function renderConnectWalletPage({ clientId, clientName, redirectUri, state, codeChallenge, error }) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Connect wallet — Wyntrax</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #141414; border: 1px solid #262626; border-radius: 16px; padding: 32px; width: 360px; text-align: center; }
    h1 { font-size: 18px; margin-bottom: 4px; }
    p.sub { color: #999; font-size: 14px; margin-bottom: 24px; }
    button { width: 100%; padding: 12px; margin-bottom: 10px; border-radius: 10px; border: 1px solid #333; background: #1c1c1c; color: #fff; font-size: 15px; cursor: pointer; }
    button:hover { background: #262626; }
    .error { background: #2a1414; border: 1px solid #522; color: #f88; padding: 10px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
    .status { color: #999; font-size: 13px; margin-top: 16px; min-height: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect your wallet</h1>
    <p class="sub">${clientName || "An app"} wants to access your Wyntrax account</p>
    ${error ? `<div class="error">Signature verification failed — please try again.</div>` : ""}
    <button id="btn-metamask">Continue with MetaMask</button>
    <button id="btn-phantom">Continue with Phantom</button>
    <div class="status" id="status"></div>
  </div>

  <script>
    const params = ${JSON.stringify({ clientId, redirectUri, state, codeChallenge })};
    const statusEl = document.getElementById("status");

    async function getChallenge(address) {
      const res = await fetch("/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) throw new Error("Failed to get challenge");
      return res.json();
    }

    async function submit(chain, address, message, signature) {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/oauth/authorize";
      const fields = {
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        state: params.state,
        code_challenge: params.codeChallenge,
        chain, address, message, signature,
        nonce: message.match(/Nonce: (\\w+)/)[1],
      };
      for (const [k, v] of Object.entries(fields)) {
        const input = document.createElement("input");
        input.type = "hidden"; input.name = k; input.value = v;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    }

    document.getElementById("btn-metamask").onclick = async () => {
      try {
        if (!window.ethereum) return (statusEl.textContent = "MetaMask not found — install it first.");
        statusEl.textContent = "Connecting...";
        const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
        const { message } = await getChallenge(address);
        statusEl.textContent = "Sign the message in your wallet...";
        const signature = await window.ethereum.request({
          method: "personal_sign",
          params: [message, address],
        });
        statusEl.textContent = "Verifying...";
        await submit("ethereum", address, message, signature);
      } catch (err) {
        statusEl.textContent = err.message || "Something went wrong.";
      }
    };

    document.getElementById("btn-phantom").onclick = async () => {
      try {
        const provider = window.phantom?.solana;
        if (!provider) return (statusEl.textContent = "Phantom not found — install it first.");
        statusEl.textContent = "Connecting...";
        const resp = await provider.connect();
        const address = resp.publicKey.toString();
        const { message } = await getChallenge(address);
        statusEl.textContent = "Sign the message in your wallet...";
        const encoded = new TextEncoder().encode(message);
        const { signature } = await provider.signMessage(encoded, "utf8");
        const base64Sig = btoa(String.fromCharCode(...signature));
        statusEl.textContent = "Verifying...";
        await submit("solana", address, message, base64Sig);
      } catch (err) {
        statusEl.textContent = err.message || "Something went wrong.";
      }
    };
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createOAuthRouter() {
    const router = express.Router();

    // HTTPS enforcement
    router.use((req, res, next) => {
        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        if (proto !== "https" && process.env.NODE_ENV === "production") {
            return res.redirect(301, `https://${req.headers.host}${req.url}`);
        }
        next();
    });

    // -- Protected Resource Metadata (RFC 9728) --------------------------------
    router.get("/.well-known/oauth-protected-resource", (req, res) => {
        res.json({
            resource: MCP_SERVER_URL,
            authorization_servers: [MCP_SERVER_URL],
            scopes_supported: ["mcp:access"],
            bearer_methods_supported: ["header"],
        });
    });

    // -- Authorization Server Metadata (RFC 8414) ------------------------------
    router.get("/.well-known/oauth-authorization-server", (req, res) => {
        res.json({
            issuer: MCP_SERVER_URL,
            authorization_endpoint: `${MCP_SERVER_URL}/oauth/authorize`,
            token_endpoint: `${MCP_SERVER_URL}/oauth/token`,
            registration_endpoint: `${MCP_SERVER_URL}/oauth/register`,
            scopes_supported: ["mcp:access"],
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
        });
    });

    // -- Dynamic Client Registration (RFC 7591) --------------------------------
    router.post("/oauth/register", express.json(), async (req, res) => {
        try {
            const { clientId, clientSecret } = await createClient({
                clientName: req.body.client_name,
                redirectUris: req.body.redirect_uris || [],
            });

            console.log(`[oauth] Registered client: ${clientId} (${req.body.client_name})`);

            res.status(201).json({
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uris: req.body.redirect_uris || [],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "client_secret_basic",
            });
        } catch (err) {
            console.error("[oauth:register] Error:", err);
            res.status(500).json({ error: "server_error" });
        }
    });

    // -- Wallet challenge — issues a nonce + message for the wallet to sign ----
    router.post("/challenge", express.json(), authLimiter, (req, res) => {
        const { address } = req.body;
        if (!address) return res.status(400).json({ error: "address required" });
        const { nonce, message } = issueChallenge(address);
        res.json({ nonce, message });
    });

    // -- Authorization endpoint — GET: show wallet-connect page ----------------
    router.get("/oauth/authorize", authLimiter, async (req, res) => {
        const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;

        const client = await getClient(client_id);
        if (!client) return res.status(400).send("Unknown client_id");

        if (!isValidRedirectUri(client, redirect_uri)) {
            return res.status(400).send("Invalid redirect_uri");
        }

        if (!code_challenge || code_challenge_method !== "S256") {
            return res.status(400).send("PKCE with S256 is required");
        }

        res.send(renderConnectWalletPage({
            clientId: client_id,
            clientName: client.clientName,
            redirectUri: redirect_uri,
            state: state || "",
            codeChallenge: code_challenge,
            error: req.query.error || null,
        }));
    });

    // -- Authorization endpoint — POST: verify wallet signature, issue code ----
    router.post("/oauth/authorize", authLimiter, express.urlencoded({ extended: true }), async (req, res) => {
        const { client_id, redirect_uri, state, code_challenge, chain, address, message, signature, nonce } = req.body;

        const errorParams = () => new URLSearchParams({
            client_id,
            redirect_uri,
            state: state || "",
            code_challenge,
            code_challenge_method: "S256",
            error: "invalid_signature",
        });

        const expectedMessage = consumeChallenge(nonce, address);
        if (!expectedMessage || expectedMessage !== message) {
            return res.redirect(`/oauth/authorize?${errorParams()}`);
        }

        const user = await findOrCreateUserByWallet({ chain, address, message, signature });

        if (!user) {
            return res.redirect(`/oauth/authorize?${errorParams()}`);
        }

        try {
            const code = await createAuthCode({
                clientId: client_id,
                userId: user.id,
                redirectUri: redirect_uri,
                codeChallenge: code_challenge,
            });

            const redirectUrl = new URL(redirect_uri);
            redirectUrl.searchParams.set("code", code);
            if (state) redirectUrl.searchParams.set("state", state);

            console.log(`[oauth] Auth code issued for wallet ${address} (user: ${user.username})`);
            res.redirect(redirectUrl.toString());
        } catch (err) {
            console.error("[oauth:authorize POST] Error:", err);
            res.status(500).send("Server error — please try again");
        }
    });

    // -- Token endpoint --------------------------------------------------------
    router.post("/oauth/token", tokenLimiter, express.urlencoded({ extended: true }), async (req, res) => {
        const { grant_type, code, redirect_uri, code_verifier, client_id, refresh_token } = req.body;

        try {
            // ── Refresh token grant ──────────────────────────────────────────────
            if (grant_type === "refresh_token") {
                if (!refresh_token) {
                    return res.status(400).json({ error: "invalid_request", error_description: "refresh_token required" });
                }

                const tokens = await rotateRefreshToken(refresh_token);
                if (!tokens) {
                    return res.status(400).json({ error: "invalid_grant", error_description: "Refresh token invalid or expired" });
                }

                return res.json({
                    access_token: tokens.accessToken,
                    refresh_token: tokens.refreshToken,
                    token_type: "Bearer",
                    expires_in: 3600,
                });
            }

            // ── Authorization code grant ─────────────────────────────────────────
            if (grant_type !== "authorization_code") {
                return res.status(400).json({ error: "unsupported_grant_type" });
            }

            const stored = await consumeAuthCode(code);
            if (!stored) {
                return res.status(400).json({ error: "invalid_grant", error_description: "Code not found or expired" });
            }

            if (stored.redirectUri !== redirect_uri) {
                return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
            }

            if (!verifyPKCE(code_verifier, stored.codeChallenge)) {
                return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
            }

            const tokens = await createTokenPair({ clientId: stored.clientId, userId: stored.userId });

            console.log(`[oauth] Tokens issued for userId: ${stored.userId}`);

            res.json({
                access_token: tokens.accessToken,
                refresh_token: tokens.refreshToken,
                token_type: "Bearer",
                expires_in: 3600,
            });
        } catch (err) {
            console.error("[oauth:token] Error:", err);
            res.status(500).json({ error: "server_error" });
        }
    });

    return router;
}

function verifyPKCE(codeVerifier, codeChallenge) {
    const digest = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
    return digest === codeChallenge;
}
