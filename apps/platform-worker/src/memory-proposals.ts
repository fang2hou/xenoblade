import type { MemoryProposal } from "@xenoblade/contracts";

/** Structural slice of the AI SDK tool-result shape this extraction reads. */
interface ToolResultLike {
  toolName: string;
  output?: unknown;
}

/** First-party tools whose outputs carry memory proposals (ADR-013). */
const MEMORY_TOOL_NAMES = new Set(["remember", "forget"]);

function isProposalOutput(value: unknown): value is { proposal: MemoryProposal } {
  if (typeof value !== "object" || value === null) return false;
  if (!("proposal" in value)) return false;
  const proposal: unknown = value.proposal;
  if (typeof proposal !== "object" || proposal === null) return false;
  return "id" in proposal && "action" in proposal && "key" in proposal;
}

/**
 * Extract memory proposals from a generation's tool results, in the order the
 * model proposed them. Only `remember`/`forget` outputs carry proposals; every
 * other tool result is ignored. Malformed outputs are dropped rather than
 * fatal — the confirmation flow simply never sees them.
 */
export function extractMemoryProposals(toolResults: readonly ToolResultLike[]): MemoryProposal[] {
  const proposals: MemoryProposal[] = [];
  for (const toolResult of toolResults) {
    if (!MEMORY_TOOL_NAMES.has(toolResult.toolName)) continue;
    if (!isProposalOutput(toolResult.output)) continue;
    proposals.push(toolResult.output.proposal);
  }
  return proposals;
}
