import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { createOAuthRouter } from "./oauth/routes.js";
import { requireAuth } from "./oauth/middleware.js";

const PORT = process.env.HTTP_PORT || 3001;
const app = express();

// ---------------------------------------------------------------------------
// 1. OAuth routes (no auth needed — these are public discovery + flow endpoints)
//    In production these are also reachable via mcp.wyntrax.xyz, rewritten
//    to this server's internal URL by the Wyntrax Next.js app's middleware.
// ---------------------------------------------------------------------------
app.use(createOAuthRouter());

// ---------------------------------------------------------------------------
// 2. MCP endpoint — protected by OAuth Bearer token (or the trusted
//    X-User-Id header forwarded by the Wyntrax app's internal proxy)
// ---------------------------------------------------------------------------
app.all("/", requireAuth, async (req, res) => {
    const server = new McpServer({
        name: "wyntrax",
        version: "1.0.0",
        description: "Wyntrax – Web3 creator monetization. Search creators, tip in crypto, buy digital products, manage memberships.",
    });

    registerTools(server, req.userId); // ← pass userId here

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

// ---------------------------------------------------------------------------
// 3. Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`[wyntrax-mcp] HTTP server listening on port ${PORT}`);
    console.log(`[wyntrax-mcp] MCP endpoint: ${process.env.MCP_SERVER_URL || "https://mcp.wyntrax.xyz"}`);
});
