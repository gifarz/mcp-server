// Smoke-tests the @wyntraxyz/mcp-wallet bridge wiring in wallet-bridge.js
import "dotenv/config";
import { bridge } from "./src/wallet-bridge.js";

const pending = await bridge.requestSignature({
    sessionId: "test-session-123",
    transaction: {
        type: "transfer",
        chain: "base",
        to: "0x0000000000000000000000000000000000000001",
        value: "0.001",
        metadata: {
            action: "buy_product",
            productId: "test-product",
        },
    },
});

console.log(pending);
