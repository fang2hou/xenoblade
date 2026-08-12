import type { Message } from "discord.js";

/** Sentinel scope id for direct messages (no guild). */
const DM_SCOPE_ID = "dm";
/** Placeholder used for the guild segment of DM container ids. */
const DM_GUILD_SEGMENT = "@me";

/**
 * Resolve the scope id for a Discord message: the guild id, or `"dm"` when the
 * message is a direct message (no guild). Mirrors the bot-worker encoding so D1
 * rows remain compatible across the hybrid split.
 */
export function scopeIdFromMessage(message: Message): string {
  return message.guild?.id ?? DM_SCOPE_ID;
}

/**
 * Resolve the container id for a Discord message.
 *
 * - Guild main channel → `discord:<guildId>:<channelId>`
 * - Real thread        → `discord:<guildId>:<parentChannelId>:<threadId>`
 * - Direct message     → `discord:@me:<channelId>`
 *
 * Four colon-separated segments encode a real thread; three encode a main
 * channel or DM. This must match the Chat SDK encoding the bot-worker writes.
 */
export function containerIdFromMessage(message: Message): string {
  const guildSegment = message.guild?.id ?? DM_GUILD_SEGMENT;
  if (message.channel.isThread()) {
    const parentChannelId = message.channel.parentId ?? message.channel.id;
    return `discord:${guildSegment}:${parentChannelId}:${message.channel.id}`;
  }
  return `discord:${guildSegment}:${message.channel.id}`;
}

/**
 * Returns true when the container id encodes a real Discord thread
 * (`discord:guild:parent:thread` — four segments). Three-segment ids represent
 * a main channel or DM.
 */
export function isRealDiscordThread(containerId: string): boolean {
  return containerId.split(":").length === 4;
}
