import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "wyntrax",
  version: "1.0.0",
  description: "Wyntrax – Web3 creator monetization. Search creators, tip in crypto, buy digital products, manage memberships.",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
