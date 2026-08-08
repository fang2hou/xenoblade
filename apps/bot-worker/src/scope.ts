import { Message } from "chat";

/** Sentinel code carried by all scope-resolution failures. */
export const SCOPE_UNRESOLVED = "SCOPE_UNRESOLVED";

/** Scope id used for direct messages (no guild). */
const DM_SCOPE_ID = "dm";

/**
 * Thrown when a Discord message's scope (guild id / DM / channel) cannot be
 * resolved from its raw payload. Carries the stable {@link SCOPE_UNRESOLVED}
 * code for telemetry and tests.
 */
export class ScopeUnresolvedError extends Error {
  readonly code = SCOPE_UNRESOLVED;
  constructor(message: string = SCOPE_UNRESOLVED) {
    super(message);
    this.name = "ScopeUnresolvedError";
  }
}

/**
 * Narrow `message.raw` to a non-null record. Throws {@link ScopeUnresolvedError}
 * when raw is not a usable object, so callers can fail fast on malformed input.
 */
function narrowRaw(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new ScopeUnresolvedError();
  }
  return raw as Record<string, unknown>;
}

/**
 * Resolve the scope id for a Discord message from its raw payload.
 *
 * - A non-empty `guild_id` string → that guild id (Discord threads reuse their
 *   parent guild id).
 * - `guild_id: null` → the literal `"dm"` (direct message).
 * - Missing key, empty string, or wrong type → throws {@link ScopeUnresolvedError}.
 *
 * `channel_type` may only corroborate an existing `guild_id: null` DM; it can
 * never substitute for a missing `guild_id`. A non-empty `guild_id` paired with
 * a DM/group-DM `channel_type` (1 or 3) is treated as a conflicting payload and
 * throws.
 */
export function getScopeIdFromDiscordMessage(message: Message): string {
  const raw = narrowRaw(message.raw);

  // guild_id MUST exist as a key.
  if (!("guild_id" in raw)) {
    throw new ScopeUnresolvedError();
  }
  const guildId = raw.guild_id;

  if (guildId === null) {
    // Direct message. channel_type may corroborate but cannot override; a null
    // guild_id is authoritative for the DM scope.
    return DM_SCOPE_ID;
  }

  if (typeof guildId !== "string" || guildId === "") {
    throw new ScopeUnresolvedError();
  }

  // guild_id is a non-empty string: a DM/group-DM channel type is contradictory.
  const channelType = raw.channel_type;
  if (typeof channelType === "number" && (channelType === 1 || channelType === 3)) {
    throw new ScopeUnresolvedError();
  }

  return guildId;
}

/**
 * Resolve the Discord channel id from the raw payload. Throws
 * {@link ScopeUnresolvedError} when `channel_id` is missing or not a non-empty
 * string.
 */
export function getChannelIdFromDiscordMessage(message: Message): string {
  const raw = narrowRaw(message.raw);
  const channelId = raw.channel_id;
  if (typeof channelId !== "string" || channelId === "") {
    throw new ScopeUnresolvedError();
  }
  return channelId;
}

/**
 * Pure check: was this message sent as a reply to the Xenoblade bot?
 *
 * Returns true only when the raw payload carries a `message_reference.message_id`
 * (non-empty) AND a `referenced_message.author.id` that equals
 * `botApplicationId`. Never throws — any malformed payload returns false. A
 * reply to any other bot is NOT treated as a match.
 */
export function isReplyToBot(message: Message, botApplicationId: string): boolean {
  const raw = message.raw;
  if (typeof raw !== "object" || raw === null) {
    return false;
  }
  const rawRecord = raw as Record<string, unknown>;

  const reference = rawRecord.message_reference;
  if (typeof reference !== "object" || reference === null) {
    return false;
  }
  const refRecord = reference as Record<string, unknown>;
  const refMessageId = refRecord.message_id;
  if (typeof refMessageId !== "string" || refMessageId === "") {
    return false;
  }

  const referenced = rawRecord.referenced_message;
  if (typeof referenced !== "object" || referenced === null) {
    return false;
  }
  const referencedRecord = referenced as Record<string, unknown>;
  const author = referencedRecord.author;
  if (typeof author !== "object" || author === null) {
    return false;
  }
  const authorRecord = author as Record<string, unknown>;
  const authorId = authorRecord.id;
  if (typeof authorId !== "string") {
    return false;
  }
  return authorId === botApplicationId;
}

/**
 * Resolve whether a message replies to the Xenoblade bot, with a single REST
 * fallback when the referenced message is not already embedded in the payload.
 *
 * 1. If {@link isReplyToBot} is already true, return true without any network.
 * 2. If there is no `message_reference` at all, return false (never trigger on
 *    arbitrary messages).
 * 3. Otherwise perform one `GET /channels/{channel_id}/messages/{id}` call with
 *    a 5s timeout; any non-2xx, parse failure, thrown error, or author mismatch
 *    returns false.
 *
 * `fetchImpl` is an injection seam for unit tests only.
 */
export async function resolveReplyToBot(
  message: Message,
  botApplicationId: string,
  botToken: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  if (isReplyToBot(message, botApplicationId)) {
    return true;
  }

  const raw = message.raw;
  if (typeof raw !== "object" || raw === null) {
    return false;
  }
  const rawRecord = raw as Record<string, unknown>;
  const reference = rawRecord.message_reference;
  if (typeof reference !== "object" || reference === null) {
    return false;
  }
  const refRecord = reference as Record<string, unknown>;
  const refMessageId = refRecord.message_id;
  if (typeof refMessageId !== "string" || refMessageId === "") {
    return false;
  }

  let channelId: string;
  try {
    channelId = getChannelIdFromDiscordMessage(message);
  } catch {
    return false;
  }

  const doFetch = fetchImpl ?? fetch;
  const url = `https://discord.com/api/v10/channels/${channelId}/messages/${refMessageId}`;
  try {
    const response = await doFetch(url, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return false;
    }
    const json = (await response.json()) as unknown;
    if (typeof json !== "object" || json === null) {
      return false;
    }
    const jsonRecord = json as Record<string, unknown>;
    const author = jsonRecord.author;
    if (typeof author !== "object" || author === null) {
      return false;
    }
    const authorRecord = author as Record<string, unknown>;
    const authorId = authorRecord.id;
    return typeof authorId === "string" && authorId === botApplicationId;
  } catch {
    return false;
  }
}
