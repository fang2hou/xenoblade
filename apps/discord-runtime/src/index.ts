import { createServer, type Server } from "node:http";
import process from "node:process";

import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";

import { loadEnv } from "./env";
import { AskPromptRegistry } from "./ask-confirm";
import { MemoryConfirmRegistry } from "./memory-confirm";
import { SoulConfirmRegistry } from "./soul-confirm";
import { ThreadSessions } from "./thread-manager";
import { INGEST_TIMEOUT_MS } from "./ai-client";
import { HistoryIngestBuffer } from "./history-ingest";
import { ConversationQueue } from "./conversation-queue";
import { registerSlashCommands } from "./slash-commands";
import { handleLanguageCommand } from "./language";
import { handleStatusCommand } from "./status";
import { handleContextCommand } from "./context";
import { handleControlCommand } from "./control-commands";
import { handleUsageCommand } from "./usage";
import type { EnvConfig } from "./env";
import { handleMessageCreate, handleComponentInteraction, type Runtime } from "./generation-flow";

async function main(): Promise<void> {
  const env = loadEnv();
  const runtime: Runtime = {
    env,
    queue: new ConversationQueue(),
    askCards: new AskPromptRegistry(),
    memoryConfirms: new MemoryConfirmRegistry(),
    soulConfirms: new SoulConfirmRegistry(),
    threadSessions: new ThreadSessions({
      workerUrl: env.workerUrl,
      token: env.internalApiToken,
    }),
  };
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Partials.Channel is required to receive MESSAGE_CREATE in DM channels
    // that are not yet in the cache. Every affordance the bot offers —
    // question cards, soul and memory confirmations — is a button and arrives
    // as an interaction, so no reaction intent or partial is needed.
    partials: [Partials.Channel, Partials.Message, Partials.User],
  });
  // Every public channel message enters the 90-day history index, triggered
  // or not. The bot's own id is read per event: `client.user` exists only
  // once the gateway is up.
  const historyIngest = new HistoryIngestBuffer({
    workerUrl: env.workerUrl,
    token: env.internalApiToken,
    botId: () => client.user?.id ?? env.discordApplicationId,
  });

  client.once("ready", () => {
    console.log(
      JSON.stringify({
        event: "ready",
        tag: client.user?.tag ?? "unknown",
        applicationId: client.user?.id ?? env.discordApplicationId,
      }),
    );
    // Best-effort registration on ready: the helper swallows its own
    // failures so a Discord API outage never breaks startup.
    void registerSlashCommands(env);
  });

  client.on("messageCreate", (message) => {
    // Before any trigger check, so chat the bot was not summoned for is
    // indexed too. Never throws: indexing is best-effort.
    historyIngest.add(message);
    // Fire-and-forget: the handler catches and logs internally; awaiting
    // would block the gateway's event dispatch.
    void handleMessageCreate(message, client, runtime);
  });

  // Edits and deletions keep the history index in step with Discord. A
  // deleted message is often partial; its ids are all the buffer needs.
  client.on("messageUpdate", (oldMessage, newMessage) => {
    // Fire-and-forget: an edit of an uncached message may fetch it first.
    void historyIngest.edit(oldMessage, newMessage);
  });
  client.on("messageDelete", (message) => {
    historyIngest.remove(message);
  });
  client.on("messageDeleteBulk", (deleted) => {
    for (const message of deleted.values()) historyIngest.remove(message);
  });

  client.on("interactionCreate", (interaction) => {
    // Receipt log: without it, an interaction that is dropped here (wrong
    // type, unrouted command or component) fails silently as "did not
    // respond" in Discord.
    const command =
      interaction.isChatInputCommand() || interaction.isContextMenuCommand()
        ? interaction.commandName
        : null;
    const customId = interaction.isMessageComponent() ? interaction.customId : null;
    console.log(
      JSON.stringify({ event: "interaction_received", type: interaction.type, command, customId }),
    );
    if (interaction.isMessageComponent()) {
      // Fire-and-forget: the handler catches and logs internally; awaiting
      // would block the gateway's event dispatch.
      void handleComponentInteraction(interaction, client, runtime);
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    // Fire-and-forget: the handler catches and logs internally; awaiting
    // would block the gateway's event dispatch.
    void handleInteraction(interaction, env);
  });

  const healthServer = startHealthServer(env.healthPort);
  registerShutdown(client, healthServer, historyIngest);

  await client.login(env.discordBotToken);
  console.log(JSON.stringify({ event: "login" }));
}

/** interactionCreate entry point for slash commands. */
async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  try {
    if (interaction.commandName === "status") {
      await handleStatusCommand(interaction, env);
      return;
    }
    if (interaction.commandName === "context") {
      await handleContextCommand(interaction, env);
      return;
    }
    if (interaction.commandName === "usage") {
      await handleUsageCommand(interaction, env);
      return;
    }
    if (interaction.commandName === "language") {
      await handleLanguageCommand(interaction, env);
      return;
    }
    if (
      interaction.commandName === "persona" ||
      interaction.commandName === "preference" ||
      interaction.commandName === "memory" ||
      interaction.commandName === "chat" ||
      interaction.commandName === "learn" ||
      interaction.commandName === "help"
    ) {
      await handleControlCommand(interaction, env);
      return;
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "interaction_error",
        command: interaction.commandName,
        error: String(error),
      }),
    );
  }
}

/** Start the health HTTP server: GET /health → { status, timestamp }. */
function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });
  server.listen(port, () => {
    console.log(JSON.stringify({ event: "health_listening", port }));
  });
  return server;
}

/**
 * Backstop for a shutdown. It outlasts one history ingest request
 * ({@link INGEST_TIMEOUT_MS}), so the final flush in `registerShutdown` is
 * never cut off by this timer.
 */
const SHUTDOWN_GRACE_MS = INGEST_TIMEOUT_MS + 5_000;

/**
 * Tear down the client and health server on SIGTERM / SIGINT: stop the
 * gateway, deliver the history index changes still buffered, then exit once
 * the health server is closed.
 */
function registerShutdown(
  client: Client,
  server: Server,
  historyIngest: HistoryIngestBuffer,
): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "shutdown", signal }));
    // Fire-and-forget: process exit below is driven by server.close (with a
    // 5s failsafe), not by awaiting the gateway teardown. The gateway goes
    // first so no message arrives behind the final history flush, which is
    // best-effort: the failsafe below still bounds the exit.
    void client.destroy();
    void historyIngest
      .stop()
      .catch((error) => {
        console.log(
          JSON.stringify({
            event: "history_ingest_stop_error",
            error: error instanceof Error ? error.name : typeof error,
          }),
        );
      })
      .finally(() => {
        server.close(() => {
          console.log(JSON.stringify({ event: "health_closed" }));
          process.exit(0);
        });
      });
    // The backstop for the exit: longer than an ingest request can take, so
    // it never cuts off the flush above. A container runtime's own stop grace
    // may still end the process sooner.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.log(JSON.stringify({ event: "fatal", error: String(error) }));
  process.exit(1);
});
