# WhatsApp webhook fixtures

Recorded-shape Meta Cloud API payloads (Graph v20), used by the contract tests
in `docs/TESTING.md` layer 3.

They are *shaped* like real deliveries — same nesting, same field names, same
`wamid.` / `timestamp`-as-unix-seconds conventions — but every value is
invented. The phone numbers are the seeded Afyanex demo range (`+254712000…`),
the `phone_number_id` is the one `pnpm db:seed` writes to `clinic_whatsapp`, and
no real person or business appears here. Nothing in this directory may ever be
replaced with a genuine capture: a real payload contains a real patient's
message body and number, which is PHI (CLAUDE.md hard rule 4).

| File | What it exercises |
| --- | --- |
| `inbound-text.json` | The common case: one Swahili text message with a contact profile. |
| `inbound-audio.json` | Voice note. Records an attachment; the content is never interpreted in Phase 3. |
| `inbound-image.json` | Image with a caption. |
| `inbound-interactive.json` | A tapped reply button, with `context` pointing at our own outbound message. |
| `status-update.json` | `delivered` receipt for a message we sent. |
| `status-failed.json` | `failed` receipt carrying Meta error 131026 (undeliverable). |
| `malformed.json` | Two changes we must survive: one with no `metadata` (unroutable) and a `message_template_status_update` we do not subscribe to logic for in Phase 3. Both are counted as ignored, and the request still acks 200 — anything else puts Meta into a redelivery loop. |

Replay/duplicate delivery is not a separate file: it is `inbound-text.json`
posted twice, which is exactly what Meta does.
