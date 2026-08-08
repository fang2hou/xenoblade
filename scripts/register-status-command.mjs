#!/usr/bin/env node
// Registers the global `/status` slash command for the Xenoblade dev app.
// Run manually AFTER Discord credentials are configured (Checkpoint B).
// Requires env: DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN.
// Never paste tokens into chat; load them from your local environment.
import assert from "node:assert";

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
assert.ok(appId, "DISCORD_APPLICATION_ID is required");
assert.ok(token, "DISCORD_BOT_TOKEN is required");

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify([
    {
      name: "status",
      description: "Check Xenoblade gateway status",
    },
  ]),
});

const body = await res.text();
if (!res.ok) {
  console.error(`Discord command registration failed: HTTP ${res.status}`);
  console.error(body);
  process.exit(1);
}

console.log("Registered global /status command:");
console.log(body);
