/**
 * Vision tool — lets text-only models (e.g. DeepSeek) "see" images by
 * delegating to a vision model (Xiaomi MiMo V2.5) on OpenRouter.
 *
 * Primary model (Luna) sees images natively; this tool is still available
 * to it as an optional analytical aid. Fallback models (DeepSeek) rely on
 * this tool entirely for image understanding.
 */
import { generateText, jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import { getModelChain, resolveMaxOutputTokens, selectModel } from "@xenoblade/ai";

/** Output token budget for `vision_describe` (includes thinking tokens on reasoning vision models). */
const VISION_MAX_OUTPUT_TOKENS = 20_480;

export function createVisionTool(env: Env): ToolSet {
  return {
    vision_describe: tool({
      description:
        "Describe or analyze an image from a URL. " +
        "Use this when a message contains an image you cannot see directly, " +
        "or when you need detailed visual analysis. " +
        "Returns a text description of the image content.",
      inputSchema: jsonSchema<{ url: string; question?: string }>({
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The image URL to analyze",
          },
          question: {
            type: "string",
            description: "Specific question about the image (default: describe everything you see)",
          },
        },
        required: ["url"],
      }),
      execute: async ({ url, question }) => {
        const started = Date.now();
        try {
          const model = selectModel(env, { role: "vision" });
          const visionConfig = getModelChain(env, "vision")[0];

          const result = await generateText({
            model,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text:
                      question ??
                      "Describe this image in detail. Note any text, objects, people, scenes, charts, or code visible.",
                  },
                  { type: "image", image: url },
                ],
              },
            ],
            maxOutputTokens: resolveMaxOutputTokens(visionConfig, VISION_MAX_OUTPUT_TOKENS),
            timeout: 30_000,
          });

          console.log(
            JSON.stringify({
              event: "vision_call",
              url: url.slice(0, 80),
              durationMs: Date.now() - started,
              replyLength: result.text.length,
            }),
          );

          return { description: result.text };
        } catch (error) {
          console.log(
            JSON.stringify({
              event: "vision_error",
              url: url.slice(0, 80),
              error: String(error),
              durationMs: Date.now() - started,
            }),
          );
          return { description: null, error: String(error) };
        }
      },
    }),
  };
}
