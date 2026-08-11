/**
 * Parse Discord message links from text and fetch linked messages' content.
 *
 * Images are downloaded and returned as base64 data URLs — matching the format
 * that `toAiMessages` / `attachmentToPart` uses, which is proven to work with
 * the OpenRouter provider. URL-based image parts had inconsistent provider
 * support.
 */

const DISCORD_MSG_LINK_PATTERN =
  /https?:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/(?:@me\/|\d+\/)(\d+)\/(\d+)/g;

export interface DiscordMessageLink {
  channelId: string;
  messageId: string;
  url: string;
}

interface DiscordAttachment {
  url: string;
  content_type?: string;
  filename?: string;
}

interface DiscordMessageResponse {
  content?: string;
  attachments?: DiscordAttachment[];
  embeds?: Array<{ image?: { url?: string }; type?: string }>;
}

export interface LinkedMessageContent {
  text: string;
  images: Array<{ dataUrl: string; mimeType?: string }>;
}

/** Extract Discord message links from arbitrary text. Max 3 links. */
export function parseDiscordMessageLinks(text: string): DiscordMessageLink[] {
  const links: DiscordMessageLink[] = [];
  let match: RegExpExecArray | null;
  DISCORD_MSG_LINK_PATTERN.lastIndex = 0;
  while ((match = DISCORD_MSG_LINK_PATTERN.exec(text)) !== null) {
    links.push({
      channelId: match[1],
      messageId: match[2],
      url: match[0],
    });
  }
  return links.slice(0, 3);
}

/** Convert an ArrayBuffer to a base64 string (chunk-based, avoids stack overflow). */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function isImageUrl(url: string, contentType?: string): boolean {
  if (contentType?.startsWith("image/")) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp)$/i.test(url);
}

/**
 * Fetch linked Discord messages via the REST API. Downloads image attachments
 * as base64 data URLs. Silent on failure — returns partial results.
 */
export async function fetchLinkedMessages(
  links: readonly DiscordMessageLink[],
  botToken: string,
): Promise<LinkedMessageContent[]> {
  const results: LinkedMessageContent[] = [];

  for (const link of links) {
    try {
      // 1. Fetch the linked message
      const response = await fetch(
        `https://discord.com/api/v10/channels/${link.channelId}/messages/${link.messageId}`,
        {
          headers: { Authorization: `Bot ${botToken}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) {
        continue;
      }

      const msg = (await response.json()) as DiscordMessageResponse;
      const images: LinkedMessageContent["images"] = [];

      // 2. Collect image URLs from attachments and embeds
      const imageUrls: Array<{ url: string; mimeType?: string }> = [];

      for (const att of msg.attachments ?? []) {
        if (isImageUrl(att.url, att.content_type)) {
          imageUrls.push({ url: att.url, mimeType: att.content_type });
        }
      }

      for (const embed of msg.embeds ?? []) {
        if (embed.image?.url) {
          imageUrls.push({ url: embed.image.url });
        }
      }

      // 3. Download each image as base64
      for (const { url, mimeType } of imageUrls.slice(0, 4)) {
        try {
          const imgResponse = await fetch(url, {
            signal: AbortSignal.timeout(8_000),
          });
          if (!imgResponse.ok) {
            continue;
          }
          const ct = mimeType ?? imgResponse.headers.get("content-type") ?? "image/png";
          const buf = await imgResponse.arrayBuffer();
          // Skip images larger than 8MB to avoid memory issues
          if (buf.byteLength > 8 * 1024 * 1024) {
            continue;
          }
          images.push({
            dataUrl: `data:${ct};base64,${toBase64(buf)}`,
            mimeType: ct,
          });
        } catch {
          // Image download failed — skip
        }
      }

      results.push({
        text: msg.content?.trim() ?? "",
        images,
      });
    } catch {
      // Network error, rate limit, or parse failure — skip this link.
    }
  }

  return results;
}
