/**
 * `pnpm wa:simulate` — post a realistic, correctly signed WhatsApp webhook at
 * the local API, so the whole inbound pipeline can be exercised without Meta.
 *
 * ```
 * pnpm wa:simulate                          # a text message
 * pnpm wa:simulate --text "niko na homa"    # your own words
 * pnpm wa:simulate --audio                  # a voice note
 * pnpm wa:simulate --image                  # an image with a caption
 * pnpm wa:simulate --interactive            # a tapped reply button
 * pnpm wa:simulate --status delivered       # a delivery receipt
 * pnpm wa:simulate --replay                 # send the same message twice
 * pnpm wa:simulate --from 0722123456        # a different patient
 * pnpm wa:simulate --unsigned               # prove the endpoint rejects it
 * ```
 *
 * Defaults match `pnpm db:seed`: the Afyanex fixture's `phone_number_id` and a
 * seeded demo patient, so a freshly seeded database routes the message and
 * creates a conversation.
 *
 * This talks to *our* API only — it never calls Meta, and it needs no Meta
 * credentials beyond the local `WHATSAPP_APP_SECRET`, which it uses to sign
 * exactly as Meta would.
 */
import { signPayload } from "@sema/channels";
import { maskPhone, tryNormalisePhone } from "@sema/shared";

interface Options {
  url: string;
  secret: string;
  phoneNumberId: string;
  from: string;
  text: string;
  kind: "text" | "audio" | "image" | "interactive" | "status";
  status: string;
  replay: boolean;
  signed: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    url: process.env["WA_SIMULATE_URL"] ?? "http://localhost:3001/webhooks/whatsapp",
    secret: process.env["WHATSAPP_APP_SECRET"] ?? "",
    // The `phone_number_id` written by `pnpm db:seed` for Afyanex.
    phoneNumberId: process.env["WA_SIMULATE_PHONE_NUMBER_ID"] ?? "100000000000002",
    from: "+254712000001",
    text: "Habari, naomba appointment kesho asubuhi",
    kind: "text",
    status: "delivered",
    replay: false,
    signed: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      // pnpm passes a bare `--` through to the script; ignore it.
      case "--":
        break;
      case "--url":
        options.url = next();
        break;
      case "--secret":
        options.secret = next();
        break;
      case "--phone-number-id":
        options.phoneNumberId = next();
        break;
      case "--from":
        options.from = next();
        break;
      case "--text":
        options.text = next();
        break;
      case "--audio":
        options.kind = "audio";
        break;
      case "--image":
        options.kind = "image";
        break;
      case "--interactive":
        options.kind = "interactive";
        break;
      case "--status":
        options.kind = "status";
        options.status = next();
        break;
      case "--replay":
        options.replay = true;
        break;
      case "--unsigned":
        options.signed = false;
        break;
      case "--help":
      case "-h":
        console.log(helpText());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }

  return options;
}

function helpText(): string {
  return [
    "pnpm wa:simulate [flags]",
    "",
    "  --text <body>          send a text message (default)",
    "  --audio                send a voice note",
    "  --image                send an image with a caption",
    "  --interactive          send a tapped reply button",
    "  --status <status>      send a delivery receipt (sent|delivered|read|failed)",
    "  --from <phone>         sender, any Kenyan format (default +254712000001)",
    "  --replay               post the same payload twice, to show dedup",
    "  --unsigned             omit the signature, to show it is rejected",
    "  --url <url>            target (default http://localhost:3001/webhooks/whatsapp)",
    "  --phone-number-id <id> the clinic's Meta sender (default: the seeded one)",
  ].join("\n");
}

/** A `wamid`-shaped id. Meta's are base64-ish; this only has to be unique. */
function waMessageId(): string {
  const random = Buffer.from(`${Date.now()}-${Math.random()}`).toString("base64url");
  return `wamid.SIM${random.slice(0, 24).toUpperCase()}`;
}

function buildPayload(options: Options, waId: string, messageId: string): unknown {
  const metadata = {
    display_phone_number: "254709000100",
    phone_number_id: options.phoneNumberId,
  };
  const timestamp = String(Math.floor(Date.now() / 1000));

  if (options.kind === "status") {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "100000000000001",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata,
                statuses: [
                  {
                    id: messageId,
                    status: options.status,
                    timestamp,
                    recipient_id: waId,
                    ...(options.status === "failed"
                      ? { errors: [{ code: 131026, title: "Message undeliverable" }] }
                      : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  const base = { from: waId, id: messageId, timestamp };
  const message = ((): Record<string, unknown> => {
    switch (options.kind) {
      case "audio":
        return {
          ...base,
          type: "audio",
          audio: { id: "980000000000001", mime_type: "audio/ogg; codecs=opus", voice: true },
        };
      case "image":
        return {
          ...base,
          type: "image",
          image: { id: "980000000000002", mime_type: "image/jpeg", caption: options.text },
        };
      case "interactive":
        return {
          ...base,
          type: "interactive",
          interactive: {
            type: "button_reply",
            button_reply: { id: "slot_2026-08-20T09:00:00Z", title: "Thu 9:00 AM" },
          },
        };
      case "text":
      default:
        return { ...base, type: "text", text: { body: options.text } };
    }
  })();

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "100000000000001",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata,
              contacts: [{ profile: { name: "Sim Patient" }, wa_id: waId }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

async function post(options: Options, body: string): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.signed) {
    headers["x-hub-signature-256"] = signPayload(body, options.secret);
  }

  const response = await fetch(options.url, { method: "POST", headers, body });
  const text = await response.text();
  console.log(`  → ${response.status} ${text}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.signed && options.secret === "") {
    console.error(
      [
        "[sema] WHATSAPP_APP_SECRET is not set, so the payload cannot be signed.",
        "       Set it in .env (any string will do locally — it just has to match",
        "       what the API is running with), or pass --secret, or use --unsigned",
        "       to check that the endpoint rejects unsigned deliveries.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const normalised = tryNormalisePhone(options.from);
  if (!normalised) {
    console.error(`[sema] --from is not a phone number we can parse.`);
    process.exit(1);
  }
  const waId = normalised.slice(1);

  const messageId = waMessageId();
  const body = JSON.stringify(buildPayload(options, waId, messageId), null, 2);

  // Masked even here: a simulated number is still rendered like a real one,
  // and this output gets pasted into issues (hard rule 4).
  console.log(
    `[sema] POST ${options.url}` +
      `\n       kind=${options.kind} from=${maskPhone(normalised)} signed=${options.signed}`,
  );

  await post(options, body);

  if (options.replay) {
    console.log("[sema] replaying the identical delivery, as Meta does:");
    await post(options, body);
    console.log("       the second should report duplicates=1 and enqueue nothing.");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sema] wa:simulate failed: ${message}`);
  console.error("       Is the API running? `pnpm dev` (or `pnpm --filter @sema/api dev`).");
  process.exit(1);
});
