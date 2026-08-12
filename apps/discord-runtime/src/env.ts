/**
 * Typed environment configuration for the Discord Runtime.
 *
 * Reads required and optional variables from `process.env`, validates that all
 * required keys are present and non-empty, and returns a normalized config
 * object. Call once at startup; a missing required variable throws and halts
 * the process.
 */

export interface EnvConfig {
  readonly discordBotToken: string;
  readonly discordApplicationId: string;
  readonly workerUrl: string;
  readonly internalApiToken: string;
  readonly mentionRoleIds: readonly string[];
  readonly healthPort: number;
}

const REQUIRED_VARS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "WORKER_URL",
  "INTERNAL_API_TOKEN",
] as const;

const DEFAULT_HEALTH_PORT = 3000;

/**
 * Load and validate the runtime environment. Throws when a required variable
 * is missing/blank or `HEALTH_PORT` is not a usable port number.
 */
export function loadEnv(): EnvConfig {
  const missing = REQUIRED_VARS.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  // Normalize the Worker base URL by stripping any trailing slashes so endpoint
  // paths can be concatenated without producing `//`.
  const workerUrl = (process.env.WORKER_URL as string).replace(/\/+$/, "");

  const mentionRoleIds = (process.env.MENTION_ROLE_IDS ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);

  const rawPort = process.env.HEALTH_PORT?.trim();
  const healthPort = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_HEALTH_PORT;
  if (!Number.isInteger(healthPort) || healthPort <= 0 || healthPort > 65535) {
    throw new Error(`Invalid HEALTH_PORT: ${String(process.env.HEALTH_PORT)}`);
  }

  return {
    discordBotToken: process.env.DISCORD_BOT_TOKEN as string,
    discordApplicationId: process.env.DISCORD_APPLICATION_ID as string,
    workerUrl,
    internalApiToken: process.env.INTERNAL_API_TOKEN as string,
    mentionRoleIds,
    healthPort,
  };
}
