import { jsonSchema, tool } from "ai";
import type { StopCondition, ToolSet } from "ai";

import type {
  AskUserOption,
  AskUserPrompt,
  GenerationRequest,
  HistoryMessage,
} from "@xenoblade/contracts";

import { isWithinContext, threadOf } from "../context";
import { DM_SCOPE } from "../db";
import { isRecord } from "../guards";
import { getLastTurn, setThreadActive, type ThreadSessionKey } from "../thread-sessions";

/**
 * What the interaction tools act on: the generation being run — whose request
 * it answers, and where — and the read bounds its history is subject to.
 */
export interface InteractionToolContext {
  db: D1Database;
  req: GenerationRequest;
  /**
   * The triggering user's context watermark for the conversation (ADR-014):
   * a turn older than it was truncated away, and no tool brings it back.
   */
  resetAt: number;
}

/**
 * Cut `text` to at most `max` UTF-16 code units — the unit Discord and its
 * builders count — without ever splitting a surrogate pair.
 */
function clamp(text: string, max: number): string {
  let result = "";
  for (const char of text) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result;
}

// ── ask_user ──────────────────────────────────────────────────────────────

/** Longest question and context note a card carries. */
const MAX_QUESTION_CHARS = 500;
const MAX_CONTEXT_NOTE_CHARS = 500;
/** A question offers at least two answers, and at most one row of buttons holds. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
/** Longest option id, and the only characters it may use. */
const MAX_OPTION_ID_CHARS = 24;
const OPTION_ID_PATTERN = new RegExp(`^[A-Za-z0-9-]{1,${MAX_OPTION_ID_CHARS}}$`);
/** Discord's own limit on a button label. */
const MAX_OPTION_LABEL_CHARS = 80;

type AskUserInput = { question: string; options: AskUserOption[]; context_note?: string };

/** Why an `ask_user` call was refused; the model may ask again or answer in text. */
export type AskUserInvalidReason =
  | "empty_question"
  | "options_count"
  | "option_id"
  | "option_label"
  | "context_note";

export type AskUserOutput =
  | { status: "waiting_for_user"; prompt: AskUserPrompt }
  | { status: "error"; code: "invalid_input"; reason: AskUserInvalidReason };

/**
 * A model does not have to honor the input schema, so the call is checked
 * before anything is shown to the user. Text that is merely too long is cut
 * to size rather than refused; a call with nothing to ask or to click is.
 */
function parseAskUserInput(value: unknown): AskUserInput | AskUserInvalidReason {
  if (!isRecord(value)) return "empty_question";
  if (typeof value.question !== "string" || value.question.trim() === "") {
    return "empty_question";
  }
  if (!Array.isArray(value.options) || value.options.length < MIN_OPTIONS) {
    return "options_count";
  }
  if (value.options.length > MAX_OPTIONS) return "options_count";

  const options: AskUserOption[] = [];
  const ids = new Set<string>();
  for (const option of value.options) {
    if (!isRecord(option) || typeof option.id !== "string") return "option_id";
    if (!OPTION_ID_PATTERN.test(option.id) || ids.has(option.id)) return "option_id";
    if (typeof option.label !== "string" || option.label.trim() === "") return "option_label";
    ids.add(option.id);
    options.push({ id: option.id, label: clamp(option.label.trim(), MAX_OPTION_LABEL_CHARS) });
  }

  const contextNote = value.context_note;
  if (contextNote !== undefined && typeof contextNote !== "string") return "context_note";
  return {
    question: clamp(value.question.trim(), MAX_QUESTION_CHARS),
    options,
    ...(contextNote === undefined ? {} : { context_note: contextNote }),
  };
}

/** An `ask_user` output that carries the question the run stopped on. */
function isAwaitingAnswer(output: unknown): output is { prompt: AskUserPrompt } {
  return (
    typeof output === "object" &&
    output !== null &&
    "status" in output &&
    output.status === "waiting_for_user" &&
    "prompt" in output
  );
}

/**
 * Ends the tool loop as soon as `ask_user` has produced a question: the user
 * answers it in their next turn, so no later step of this one can build on
 * it. A refused call does not end the loop — the model reads why and asks
 * again, or answers in text.
 */
export const stoppedOnAskUser: StopCondition<ToolSet> = ({ steps }) => {
  const last = steps.at(-1);
  return (
    last?.toolResults.some(
      (result) => result.toolName === "ask_user" && isAwaitingAnswer(result.output),
    ) ?? false
  );
};

/**
 * `ask_user`: stop the turn on a question for the triggering user. Stateless —
 * the question travels back inside the generation result, the Runtime shows it
 * as a card with one button per option, and the choice returns as the user's
 * next message.
 */
function createAskUserTool() {
  return tool({
    description:
      "Ask the triggering user to settle something before you answer, and end your turn there: they get a card with `question` (and the optional `context_note`) and one button per option, and their choice comes back as their next message. " +
      "Use it only when the answer truly depends on their decision — a request with distinct readings, a choice of approach, or a detail you cannot infer — and never for something you can reasonably assume or confirm inside the answer itself. " +
      "`question` is one clear question in the user's language (at most 500 characters). `options` is 2 to 4 answers, each `{ id, label }`: `id` is a short unique id of ASCII letters, digits, and hyphens (at most 24 characters), `label` is the button text in the user's language (at most 80 characters), and the first option is your recommended one. `context_note` (at most 500 characters) is optional detail that helps them decide. " +
      "Anything you write in this turn only leads into the question, so do not answer it here.",
    inputSchema: jsonSchema<AskUserInput>({
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question the user answers, in their language.",
        },
        options: {
          type: "array",
          minItems: MIN_OPTIONS,
          maxItems: MAX_OPTIONS,
          description: "The answers offered as buttons; the first is the recommended one.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: `Unique id: ASCII letters, digits, and hyphens, at most ${MAX_OPTION_ID_CHARS} characters.`,
              },
              label: {
                type: "string",
                description: `Button text in the user's language, at most ${MAX_OPTION_LABEL_CHARS} characters.`,
              },
            },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
        context_note: {
          type: "string",
          description: "Optional detail shown under the question that helps the user decide.",
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    }),
    execute: async (args: unknown): Promise<AskUserOutput> => {
      const input = parseAskUserInput(args);
      if (typeof input === "string")
        return { status: "error", code: "invalid_input", reason: input };
      const contextNote = input.context_note?.trim() ?? "";
      return {
        status: "waiting_for_user",
        prompt: {
          id: crypto.randomUUID(),
          question: input.question,
          options: input.options,
          ...(contextNote === ""
            ? {}
            : { contextNote: clamp(contextNote, MAX_CONTEXT_NOTE_CHARS) }),
        },
      };
    },
  });
}

/** The question a run stopped on: its latest valid `ask_user` result. */
export function extractAskPrompt(
  toolResults: readonly { toolName: string; output: unknown }[],
): AskUserPrompt | undefined {
  let prompt: AskUserPrompt | undefined;
  for (const result of toolResults) {
    if (result.toolName === "ask_user" && isAwaitingAnswer(result.output)) {
      prompt = result.output.prompt;
    }
  }
  return prompt;
}

// ── retry_last_reply ──────────────────────────────────────────────────────

/** Longest instruction a retry may carry. */
const MAX_INSTRUCTION_CHARS = 1000;

type RetryInput = { instruction?: string };

export type RetryLastReplyOutput =
  | {
      status: "ok";
      previousUserPrompt: string;
      previousAssistantReply: string;
      /** What to change about the answer; empty when the user gave no detail. */
      instruction: string;
    }
  | { status: "no_previous_turn" }
  | { status: "error"; code: "invalid_input" };

/** One completed turn as the retry tool reads it: the prompt, and the reply to improve. */
export interface PreviousTurn {
  userPrompt: string;
  assistantReply: string;
}

/**
 * True when a call of `toolName` in the run took effect — its output reports
 * `status`. A call refused as invalid input did not, and neither did one that
 * found nothing to act on.
 */
function tookEffect(
  toolResults: readonly { toolName: string; output?: unknown }[],
  toolName: string,
  status: string,
): boolean {
  return toolResults.some((result) => {
    if (
      result.toolName !== toolName ||
      typeof result.output !== "object" ||
      result.output === null
    ) {
      return false;
    }
    return "status" in result.output && result.output.status === status;
  });
}

/**
 * True when the run redid the conversation's last turn: `retry_last_reply`
 * found one. A run that only learned there was nothing to redo answered the
 * current message like any other.
 */
export function hasRetry(toolResults: readonly { toolName: string; output?: unknown }[]): boolean {
  return tookEffect(toolResults, "retry_last_reply", "ok");
}

/** True when the run asked to pause the thread it answered in. */
export function hasThreadPause(
  toolResults: readonly { toolName: string; output?: unknown }[],
): boolean {
  return tookEffect(toolResults, "thread_pause", "paused");
}

/**
 * The latest exchange of the conversation as its history shows it: the bot's
 * newest reply, and the message before it that prompted it. Read backwards
 * from the end, so it is the turn just before the current message.
 */
function lastExchangedTurn(
  req: GenerationRequest,
  history: readonly HistoryMessage[],
  resetAt: number,
): PreviousTurn | null {
  let reply: HistoryMessage | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined || !isWithinContext(req, message, resetAt)) continue;
    if (reply === undefined) {
      if (message.isBot) reply = message;
      continue;
    }
    if (!message.isBot) return { userPrompt: message.text, assistantReply: reply.text };
  }
  return null;
}

/**
 * `retry_last_reply`: show the model the conversation's latest turn — the
 * user's prompt and the bot's reply — so it can answer that prompt again, as
 * a new message. In a guild the turn comes from `container_last_turns`, and
 * from the request's history when none is stored. A DM has no stored turns
 * (ADR-011): its history is the only source, and nothing is ever written.
 */
function createRetryLastReplyTool(context: InteractionToolContext) {
  const { db, req, resetAt } = context;
  return tool({
    description:
      "Answer the previous question again, better, when the triggering user asks you to redo your last reply — e.g. '重新回答', '再试一次', '说简单点', 'try again but shorter'. " +
      "It returns { status: 'ok', previousUserPrompt, previousAssistantReply, instruction }, or { status: 'no_previous_turn' } when this conversation has no earlier reply to redo — then just say so. " +
      "Write a complete new answer to `previousUserPrompt`, improving on `previousAssistantReply` and applying `instruction` when it says what to change. Post it as your normal reply to this turn: the earlier reply stays as it is, so do not refer to 'the answer above' as if you were editing it. " +
      "`instruction` is optional: what the user wants different this time, in a few words; leave it out when they said nothing beyond asking again.",
    inputSchema: jsonSchema<RetryInput>({
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "What should be different about the new answer; omit when unspecified.",
        },
      },
      additionalProperties: false,
    }),
    execute: async (args: unknown): Promise<RetryLastReplyOutput> => {
      if (args !== undefined && !isRecord(args)) return { status: "error", code: "invalid_input" };
      const rawInstruction = isRecord(args) ? args.instruction : undefined;
      if (rawInstruction !== undefined && typeof rawInstruction !== "string") {
        return { status: "error", code: "invalid_input" };
      }
      const instruction = clamp(rawInstruction?.trim() ?? "", MAX_INSTRUCTION_CHARS);

      let turn: PreviousTurn | null = null;
      if (req.scopeId !== DM_SCOPE) {
        try {
          const stored = await getLastTurn(db, req.containerId);
          // A turn stored before the user's context watermark was truncated
          // away: it is theirs to forget, and this tool does not bring it back.
          if (
            stored !== null &&
            stored.triggerContent.trim() !== "" &&
            (resetAt <= 0 || stored.updatedAt >= resetAt)
          ) {
            turn = { userPrompt: stored.triggerContent, assistantReply: stored.assistantReply };
          }
        } catch (error) {
          // The history below still holds the latest turns of the conversation.
          console.log(JSON.stringify({ event: "last_turn_read_error", error: String(error) }));
        }
      }
      turn ??= lastExchangedTurn(req, req.history, resetAt);
      if (turn === null) return { status: "no_previous_turn" };
      return {
        status: "ok",
        previousUserPrompt: turn.userPrompt,
        previousAssistantReply: turn.assistantReply,
        instruction,
      };
    },
  });
}

// ── thread_pause ──────────────────────────────────────────────────────────

type ThreadPauseOutput = { status: "paused" };

/**
 * Store a run's `thread_pause` where it was asked — the thread it answered in
 * — and report whether the conversation is one the bot can stop following.
 * Throws when the write fails; the caller decides what that means for the run.
 */
export async function pauseThread(
  db: D1Database,
  req: GenerationRequest,
  now: number,
): Promise<boolean> {
  const thread = threadOf(req);
  if (thread === null) return false;
  const key: ThreadSessionKey = {
    threadId: thread.threadId,
    guildId: req.scopeId,
    parentChannelId: thread.parentChannelId,
    createdBy: req.userId,
  };
  await setThreadActive(db, key, false, now);
  return true;
}

/**
 * `thread_pause`: stop following the thread once this reply is sent — from
 * then on the bot answers here only when summoned, until someone summons it
 * again. Stateless: the pipeline stores the pause when the reply it belongs
 * to is the one that gets posted.
 */
function createThreadPauseTool() {
  return tool({
    description:
      "Stop following this thread once your reply is sent: from then on the bot answers here only when summoned with an @mention, until someone summons it again. " +
      "Call it when the triggering user says the discussion is over or tells you to stop following the thread — e.g. '先到这', '结束讨论', '先不用跟了'. " +
      "When they only sound done, or ending would cut off something they still need, answer first and ask (ask_user); a pause asked in the same turn as a question is not applied, so call this again in the turn where they confirm.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async (): Promise<ThreadPauseOutput> => ({ status: "paused" }),
  });
}

// ── Tool set ──────────────────────────────────────────────────────────────

/**
 * The interaction tools of one generation. `ask_user` and `retry_last_reply`
 * exist everywhere; `thread_pause` only in a server's thread, which is the
 * only conversation the bot follows.
 */
export function createInteractionTools(context: InteractionToolContext): ToolSet {
  return {
    ask_user: createAskUserTool(),
    retry_last_reply: createRetryLastReplyTool(context),
    ...(threadOf(context.req) === null ? {} : { thread_pause: createThreadPauseTool() }),
  };
}
