import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "@sema/shared";

import { MODEL_PRIVACY_POSTURE } from "./models.js";

/**
 * The only module in the repo that imports the Anthropic SDK.
 *
 * CONVERSATION_ENGINE.md, first line: "All model calls live here. Nothing else
 * in the repo imports the Anthropic SDK." Everything above this file talks to
 * the `ModelClient` interface, which means the classifier and (in Phase 5) the
 * agent can be unit-tested with a fake, and swapping providers or adding a
 * gateway is one file.
 */

export interface ModelMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface StructuredRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  /** JSON Schema for the response. See structured outputs. */
  readonly jsonSchema: Record<string, unknown>;
  readonly maxTokens: number;
  /** Hard wall-clock deadline for the whole call, including connect time. */
  readonly timeoutMs: number;
  /** Caller cancellation, composed with the deadline above. */
  readonly signal?: AbortSignal;
}

export interface StructuredResponse {
  /** Raw text of the response. Still untrusted — validate it with Zod. */
  readonly text: string;
  readonly stopReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelClient {
  structured(request: StructuredRequest): Promise<StructuredResponse>;
}

// ── Tool use (Phase 5: the agent) ───────────────────────────────────────────

/**
 * A tool as the model sees it. The `inputSchema` is JSON Schema, not Zod: the
 * model needs a description of the shape, and the *validation* is done again on
 * our side with Zod before anything executes (CLAUDE.md §AI: "Every tool call
 * is validated with Zod before execution").
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

/** `input` is deliberately `unknown`: it is model output, i.e. untrusted. */
export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export type AssistantBlock = TextBlock | ToolUseBlock;

export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  /** Serialised structured result. The agent never fabricates one of these. */
  readonly content: string;
  readonly isError?: boolean;
}

export type AgentTurn =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "user"; readonly content: readonly ToolResultBlock[] }
  | { readonly role: "assistant"; readonly content: readonly AssistantBlock[] };

export interface ConverseRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly AgentTurn[];
  readonly tools: readonly ToolSpec[];
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ConverseResponse {
  readonly blocks: readonly AssistantBlock[];
  readonly stopReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * The tool-use half of the model surface, kept separate from `ModelClient` so
 * the classifier's fakes (and anything that only needs structured output) are
 * not forced to implement a conversation loop they never run.
 */
export interface AgentClient {
  converse(request: ConverseRequest): Promise<ConverseResponse>;
}

/** Everything the engine needs: classifier + guardrail checks + the agent. */
export type EngineClient = ModelClient & AgentClient;

/** Concatenate the text blocks of an assistant turn. */
export function textOf(blocks: readonly AssistantBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** The tool calls in an assistant turn, in order. */
export function toolUsesOf(blocks: readonly AssistantBlock[]): readonly ToolUseBlock[] {
  return blocks.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

/** Why a model call did not produce usable text. Maps to `ClassifierFallbackReason`. */
export type ModelCallFailure = "timeout" | "transport_error" | "refusal" | "empty_output";

/**
 * A model call that failed. Never `expose`d to a patient: the reply they see
 * comes from the i18n catalogue (CLAUDE.md §Conventions on errors).
 */
export class ModelCallError extends AppError {
  readonly reason: ModelCallFailure;

  constructor(reason: ModelCallFailure, message: string, cause?: unknown) {
    super("UPSTREAM_UNAVAILABLE", message, { cause, meta: { reason } });
    this.name = "ModelCallError";
    this.reason = reason;
  }
}

export interface AnthropicClientOptions {
  /** Defaults to `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  baseURL?: string;
}

/** True when a model call could succeed. Used by the eval runner to skip cleanly. */
export function hasModelCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env["ANTHROPIC_API_KEY"] === "string" && env["ANTHROPIC_API_KEY"].length > 0;
}

/**
 * Compose the caller's signal with our own deadline so whichever fires first
 * aborts the request. `AbortSignal.any` is Node 20+.
 */
function deadlineSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, deadline]) : deadline;
}

function isTimeout(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return true;
  if (error instanceof Anthropic.APIUserAbortError) return true;
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createAnthropicClient(options: AnthropicClientOptions = {}): EngineClient {
  const client = new Anthropic({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    // A retried classifier call would blow the 1.5s budget, and the fail-safe
    // path is safe by construction — so never retry (MODEL_PRIVACY_POSTURE
    // also records that a timed-out prompt is not silently re-sent).
    maxRetries: MODEL_PRIVACY_POSTURE.maxRetries,
  });

  return {
    async structured(request: StructuredRequest): Promise<StructuredResponse> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            output_config: { format: { type: "json_schema", schema: request.jsonSchema } },
            // No `metadata.user_id`: nothing tenant- or patient-correlatable
            // leaves the boundary (COMPLIANCE.md §2).
          },
          {
            timeout: request.timeoutMs,
            signal: deadlineSignal(request.timeoutMs, request.signal),
            maxRetries: MODEL_PRIVACY_POSTURE.maxRetries,
          },
        );
      } catch (error) {
        if (isTimeout(error)) {
          throw new ModelCallError("timeout", "Model call exceeded its deadline.", error);
        }
        // The message deliberately carries no prompt text — a transport error
        // string is a log line, and log lines must be PHI-free (hard rule 4).
        throw new ModelCallError("transport_error", "Model call failed.", error);
      }

      if (message.stop_reason === "refusal") {
        throw new ModelCallError("refusal", "Model declined to classify the message.");
      }

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      if (text === "") {
        throw new ModelCallError("empty_output", "Model returned no text.");
      }

      return {
        text,
        stopReason: message.stop_reason,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      };
    },

    async converse(request: ConverseRequest): Promise<ConverseResponse> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: request.messages.map(toWireTurn),
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            })),
          },
          {
            timeout: request.timeoutMs,
            signal: deadlineSignal(request.timeoutMs, request.signal),
            maxRetries: MODEL_PRIVACY_POSTURE.maxRetries,
          },
        );
      } catch (error) {
        if (isTimeout(error)) {
          throw new ModelCallError("timeout", "Agent call exceeded its deadline.", error);
        }
        throw new ModelCallError("transport_error", "Agent call failed.", error);
      }

      if (message.stop_reason === "refusal") {
        throw new ModelCallError("refusal", "Model declined to answer.");
      }

      const blocks: AssistantBlock[] = [];
      for (const block of message.content) {
        if (block.type === "text") blocks.push({ type: "text", text: block.text });
        // Any other block type (thinking, server tool use) is ignored rather
        // than surfaced: the agent loop only knows how to act on these two, and
        // silently dropping is safer than half-understanding.
        else if (block.type === "tool_use") {
          blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      }

      if (blocks.length === 0) {
        throw new ModelCallError("empty_output", "Model returned no usable content.");
      }

      return {
        blocks,
        stopReason: message.stop_reason,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      };
    },
  };
}

/** Translate our provider-neutral turn into the Anthropic wire shape. */
function toWireTurn(turn: AgentTurn): Anthropic.MessageParam {
  if (turn.role === "user") {
    if (typeof turn.content === "string") return { role: "user", content: turn.content };
    return {
      role: "user",
      content: turn.content.map((block) => ({
        type: "tool_result" as const,
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError === true ? { is_error: true } : {}),
      })),
    };
  }

  return {
    role: "assistant",
    content: turn.content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : { type: "tool_use" as const, id: block.id, name: block.name, input: block.input },
    ),
  };
}
