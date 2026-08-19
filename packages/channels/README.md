# @sema/channels

How Sema talks to patients. The `Channel` interface from ARCHITECTURE.md §6,
plus the WhatsApp Cloud API adapter (INTEGRATIONS.md §1).

Nothing in here knows about clinics, Postgres or queues. It turns a Sema
message into an HTTP call, and a Meta webhook into events. That is the whole
job — which is what makes the payload builders and the webhook parser testable
as pure functions, with no network anywhere in the suite.

## What's here

| Module | Responsibility |
| --- | --- |
| `types.ts` | The `Channel` interface and the outbound message shapes. |
| `whatsapp/payloads.ts` | Pure `input → JSON` builders, with Meta's limits enforced. |
| `whatsapp/adapter.ts` | `WhatsAppChannel`: Graph calls, media download, mark-read. |
| `whatsapp/errors.ts` | Meta error codes → `needs_template` / `undeliverable` / `rate_limited` / … |
| `whatsapp/signature.ts` | `X-Hub-Signature-256` verification and the GET handshake. |
| `whatsapp/webhook.ts` | Meta's nested envelope → a flat list of events. |
| `whatsapp/jobs.ts` | What travels on the queue between `apps/api` and `apps/worker`. |

## Rules

- **Nothing outside the outbox worker may call a channel.** Request handlers
  and the engine write to `outbox`; `apps/worker/src/jobs/outbox.ts` delivers
  (CLAUDE.md §Conventions).
- **Signature verification runs on the raw request bytes.** `verifySignature`
  takes a `Buffer`, never a parsed object — see the long comment in
  `signature.ts` for why this is the bug worth designing around.
- **No secrets or PHI in errors.** `WhatsAppError` carries Meta's numeric code,
  status and trace id, and deliberately does not repeat Meta's prose, which
  sometimes echoes the recipient's number back.
- **Buttons up to three options, list beyond that.** Callers pass options and
  intent; the adapter picks the wire format.

## Interactive messages

`sendInteractive` takes options, not a wire format:

```ts
await channel.sendInteractive({
  kind: "interactive",
  to: "+254712345678",
  body: "Which time suits you?",
  options: [
    { id: "slot_2026-08-20T09:00:00Z", title: "Thu 9:00 AM" },
    { id: "slot_2026-08-20T14:30:00Z", title: "Thu 2:30 PM" },
  ],
});
```

Three or fewer options become WhatsApp reply buttons; four or more become a
list message. Option ids must be unique — they come back on the patient's
reply, and an ambiguous one would book the wrong slot.

## Testing

`pnpm --filter @sema/channels test` — all unit and fixture tests, no network,
no database. The recorded Meta payloads live in `fixtures/whatsapp/` at the
repo root; see the README there for what each one covers.
