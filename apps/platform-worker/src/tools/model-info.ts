/**
 * Artificial Analysis tools (first-party, direct API).
 *
 * The official MCP server is stdio-only (npx artificial-analysis-mcp), which
 * cannot run in a Cloudflare Worker. These tools call the same API directly.
 */
import { jsonSchema, tool } from "ai";

const AA_BASE = "https://artificialanalysis.ai/api/v1";
const TIMEOUT_MS = 10_000;

async function aaFetch(path: string, apiKey: string): Promise<unknown> {
  const response = await fetch(`${AA_BASE}${path}`, {
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`AA API ${response.status}`);
  }
  return response.json();
}

export function createModelInfoTools(env: Env) {
  if (!env.ARTIFICIAL_ANALYSIS_API_KEY) {
    return {} as Record<string, never>;
  }

  const apiKey = env.ARTIFICIAL_ANALYSIS_API_KEY;

  return {
    model_list: tool({
      description:
        "List LLM models with pricing, speed metrics, and benchmark scores from Artificial Analysis. " +
        "Filter by creator (e.g. 'OpenAI', 'Anthropic') and sort by any metric. " +
        "Sort fields: price_input, price_output, price_blended, speed, ttft, " +
        "intelligence_index, coding_index, math_index, mmlu_pro, gpqa, release_date.",
      inputSchema: jsonSchema<{
        creator?: string;
        sort_by?: string;
        sort_order?: string;
        limit?: number;
      }>({
        type: "object",
        properties: {
          creator: { type: "string", description: "Filter by model creator" },
          sort_by: { type: "string", description: "Sort field" },
          sort_order: { type: "string", enum: ["asc", "desc"] },
          limit: { type: "number" },
        },
      }),
      execute: async (args) => {
        try {
          const params = new URLSearchParams();
          if (args.creator) params.set("creator", args.creator);
          if (args.sort_by) params.set("sort_by", args.sort_by);
          params.set("sort_order", args.sort_order ?? "desc");
          params.set("limit", String(args.limit ?? 10));
          const data = await aaFetch(`/models?${params}`, apiKey);
          return { models: data };
        } catch (error) {
          return { models: [], error: String(error) };
        }
      },
    }),

    model_info: tool({
      description:
        "Get detailed pricing, speed, and benchmark data for a specific LLM model. " +
        "Example: 'gpt-4o', 'claude-4.5-sonnet', 'gemini-2.0-flash'.",
      inputSchema: jsonSchema<{ model: string }>({
        type: "object",
        properties: {
          model: { type: "string", description: "Model name or slug" },
        },
        required: ["model"],
      }),
      execute: async (args) => {
        try {
          const data = await aaFetch(
            `/models/${encodeURIComponent(args.model)}`,
            apiKey,
          );
          return { model: data };
        } catch (error) {
          return { model: null, error: String(error) };
        }
      },
    }),
  };
}
