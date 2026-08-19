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

export function createAnthropicClient(options: AnthropicClientOptions = {}): ModelClient {
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
  };
}
