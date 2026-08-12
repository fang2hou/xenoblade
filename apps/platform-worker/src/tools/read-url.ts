import { generateText, jsonSchema, tool } from "ai";

import { selectModel } from "@xenoblade/ai";

import { isUrlSafe } from "./ssrf";

/** Content longer than this is compressed via the summarization model. */
const READ_URL_CONTENT_THRESHOLD = 2000;

/** Maximum characters of raw page text kept before compression/truncation. */
const READ_URL_MAX_CONTENT = 8000;

/**
 * Strip HTML to readable text: remove script/style/nav boilerplate, drop all
 * tags, decode common entities, and collapse whitespace.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Create the `read_url` tool: fetch a web page, strip it to text, and compress
 * long content (> 2000 chars) via the summarization model so the context
 * window stays lean.
 *
 * SSRF-unsafe URLs are rejected before any network call. All failures return a
 * structured error — the tool never throws.
 */
export function createReadUrlTool(env: Env) {
  return tool({
    description:
      "Read the text content of a web page at a given URL. " +
      "Use this to get details from a specific page found via web_search. " +
      "Long pages are automatically summarized to key facts.",
    inputSchema: jsonSchema<{ url: string }>({
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full HTTP(S) URL to read.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    }),
    execute: async ({ url }) => {
      // SSRF gate — reject before any network call.
      if (!isUrlSafe(url)) {
        return { content: null, error: "blocked" };
      }

      // Fetch + strip.
      let raw: string;
      try {
        const response = await fetch(url, {
          headers: { Accept: "text/html, text/plain, */*" },
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          return {
            content: null,
            sourceUrl: url,
            originalLength: 0,
            compressed: false,
            error: `HTTP ${response.status}`,
          };
        }
        raw = stripHtml(await response.text());
      } catch (error) {
        console.log(JSON.stringify({ event: "read_url_fetch_error", url, error: String(error) }));
        return {
          content: null,
          sourceUrl: url,
          originalLength: 0,
          compressed: false,
          error: "Fetch failed",
        };
      }

      const originalLength = raw.length;
      const truncated = raw.slice(0, READ_URL_MAX_CONTENT);

      // Compress long content via the summarization model.
      if (truncated.length > READ_URL_CONTENT_THRESHOLD) {
        try {
          const summary = await generateText({
            model: selectModel(env, { role: "summarization" }),
            prompt:
              "Extract key facts from this page. Preserve numbers, dates, names. " +
              "Remove ads/navigation. Output markdown.\n\n" +
              truncated,
            maxOutputTokens: 512,
            timeout: 30_000,
          });
          if (summary.text.trim()) {
            return {
              content: summary.text.trim(),
              sourceUrl: url,
              originalLength,
              compressed: true,
            };
          }
        } catch (error) {
          console.log(
            JSON.stringify({
              event: "read_url_compress_error",
              url,
              error: String(error),
            }),
          );
          // Fall through — return raw truncated content.
        }
      }

      return {
        content: truncated,
        sourceUrl: url,
        originalLength,
        compressed: false,
      };
    },
  });
}
