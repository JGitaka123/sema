import { AppError } from "@sema/shared";

import type {
  Channel,
  DownloadedMedia,
  OutboundInteractive,
  OutboundLocation,
  OutboundMessage,
  OutboundTemplate,
  OutboundText,
  SendResult,
} from "../types.js";
import { toTransportError, toWhatsAppError, WhatsAppError } from "./errors.js";
import {
  buildInteractivePayload,
  buildLocationPayload,
  buildMarkReadPayload,
  buildTemplatePayload,
  buildTextPayload,
} from "./payloads.js";

/**
 * WhatsApp Cloud API adapter (Graph v20+, INTEGRATIONS.md §1).
 *
 * One instance per clinic sender: it holds the `phone_number_id` and the
 * access token for that number, and nothing else. Constructing one is free, so
 * the outbox worker builds one per job rather than caching credentials in
 * module state.
 *
 * `fetch` is injected. Node 20 has a global one, and that is the default, but
 * every test in this package drives the adapter through a fake — asserting on
 * the URL, headers and body we *would* have sent is the whole contract, and it
 * needs no network and no nock-style interception.
 */

/** The bits of `Response` this adapter uses. Keeps DOM lib out of tsconfig. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: { get(name: string): string | null };
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

export interface WhatsAppChannelOptions {
  /** Meta's sender id: `POST /{phone_number_id}/messages`. */
  phoneNumberId: string;
  /** System-user access token, already decrypted. Never logged. */
  accessToken: string;
  /** Graph version, e.g. `v20.0`. */
  graphVersion?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Per-request timeout. The outbox retries, so failing fast is correct. */
  timeoutMs?: number;
}

const DEFAULT_GRAPH_VERSION = "v20.0";
const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Media Meta will not have deleted yet, but big enough to be a DoS. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

interface SendResponse {
  messages?: { id?: unknown }[];
}

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp" as const;

  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly graphVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: WhatsAppChannelOptions) {
    if (!options.phoneNumberId.trim()) {
      throw new AppError("INTERNAL", "WhatsApp channel needs a phone_number_id.", {
        expose: false,
      });
    }
    if (!options.accessToken.trim()) {
      throw new AppError("INTERNAL", "WhatsApp channel needs an access token.", { expose: false });
    }

    this.phoneNumberId = options.phoneNumberId.trim();
    this.accessToken = options.accessToken;
    this.graphVersion = options.graphVersion ?? DEFAULT_GRAPH_VERSION;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // `globalThis.fetch` is structurally compatible; the cast is the price of
    // not pulling the DOM lib into a Node-only package.
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private url(path: string): string {
    return `${this.baseUrl}/${this.graphVersion}/${path}`;
  }

  /**
   * One Graph call. Returns parsed JSON, or throws a classified
   * `WhatsAppError`. Nothing here logs: the caller has the context (clinic,
   * outbox row) and the redaction rules.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    operation: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: HttpResponse;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw toTransportError(operation, error);
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text().catch(() => "");
    let body: unknown;
    try {
      body = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      body = undefined;
    }

    if (!response.ok) throw toWhatsAppError(response.status, body, operation);
    return body;
  }

  private async post(
    path: string,
    operation: string,
    payload: Record<string, unknown>,
  ): Promise<SendResult> {
    const body = (await this.request("POST", path, operation, payload)) as SendResponse | undefined;
    const id = body?.messages?.[0]?.id;
    if (typeof id !== "string" || id === "") {
      // A 200 with no wamid means we cannot correlate the delivery status
      // webhook later. Treat it as a failure rather than storing a null id.
      throw new WhatsAppError("unknown", `WhatsApp ${operation} returned no message id.`, {
        status: 200,
      });
    }
    return { externalMessageId: id };
  }

  private messagesPath(): string {
    return `${encodeURIComponent(this.phoneNumberId)}/messages`;
  }

  sendText(message: OutboundText): Promise<SendResult> {
    return this.post(this.messagesPath(), "sendText", {
      ...buildTextPayload(message),
    });
  }

  sendInteractive(message: OutboundInteractive): Promise<SendResult> {
    return this.post(this.messagesPath(), "sendInteractive", {
      ...buildInteractivePayload(message),
    });
  }

  sendTemplate(message: OutboundTemplate): Promise<SendResult> {
    return this.post(this.messagesPath(), "sendTemplate", {
      ...buildTemplatePayload(message),
    });
  }

  sendLocation(message: OutboundLocation): Promise<SendResult> {
    return this.post(this.messagesPath(), "sendLocation", {
      ...buildLocationPayload(message),
    });
  }

  send(message: OutboundMessage): Promise<SendResult> {
    switch (message.kind) {
      case "text":
        return this.sendText(message);
      case "interactive":
        return this.sendInteractive(message);
      case "template":
        return this.sendTemplate(message);
      case "location":
        return this.sendLocation(message);
    }
  }

  /**
   * Two hops, as Meta requires: `GET /{media_id}` returns a short-lived URL,
   * which must then be fetched *with the bearer token* (a plain GET 401s).
   */
  async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    const id = mediaId.trim();
    if (id === "") {
      throw new AppError("VALIDATION_FAILED", "A media id is required.", { expose: false });
    }

    const meta = (await this.request("GET", encodeURIComponent(id), "downloadMedia")) as
      | { url?: unknown; mime_type?: unknown; sha256?: unknown; file_size?: unknown }
      | undefined;

    const url = typeof meta?.url === "string" ? meta.url : undefined;
    if (!url) {
      throw new WhatsAppError("unknown", "WhatsApp downloadMedia returned no url.", { status: 200 });
    }

    const fileSize = typeof meta?.file_size === "number" ? meta.file_size : undefined;
    if (fileSize !== undefined && fileSize > MAX_MEDIA_BYTES) {
      throw new AppError("VALIDATION_FAILED", "Media is larger than we accept.", {
        expose: false,
        meta: { fileSize },
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: HttpResponse;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        // The CDN url is signed *and* still requires the token.
        headers: { authorization: `Bearer ${this.accessToken}` },
        signal: controller.signal,
      });
    } catch (error) {
      throw toTransportError("downloadMedia", error);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw toWhatsAppError(response.status, undefined, "downloadMedia");

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_MEDIA_BYTES) {
      throw new AppError("VALIDATION_FAILED", "Media is larger than we accept.", {
        expose: false,
        meta: { fileSize: buffer.byteLength },
      });
    }

    const mime =
      (typeof meta?.mime_type === "string" ? meta.mime_type : undefined) ??
      response.headers.get("content-type") ??
      "application/octet-stream";

    return {
      mediaId: id,
      // Meta appends the charset; the DB column stores the bare type.
      mime: mime.split(";")[0]?.trim() ?? mime,
      bytes: buffer,
      ...(typeof meta?.sha256 === "string" ? { sha256: meta.sha256 } : {}),
      ...(fileSize === undefined ? {} : { fileSize }),
    };
  }

  /**
   * Blue ticks on an inbound message.
   *
   * Deliberately swallows failures: a patient's message is already stored and
   * queued by the time we get here, and failing the inbound job over a cosmetic
   * receipt would replay the whole message. Returns without throwing.
   */
  async markRead(externalMessageId: string): Promise<void> {
    try {
      await this.request(
        "POST",
        this.messagesPath(),
        "markRead",
        buildMarkReadPayload(externalMessageId) as unknown as Record<string, unknown>,
      );
    } catch {
      // Intentionally ignored — see the doc comment.
    }
  }
}
