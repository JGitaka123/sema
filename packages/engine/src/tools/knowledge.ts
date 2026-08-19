import { formatMoney, money, type CurrencyCode } from "@sema/shared";
import type { z } from "zod";

import type { KnowledgeFact, ServiceFact } from "../context.js";
import {
  getClinicInfoSchema,
  JSON_SCHEMAS,
  listServicesSchema,
  sendLocationSchema,
} from "./schemas.js";
import { defineTool, type AnyToolDefinition, type ToolOutcome } from "./types.js";

/**
 * The read-only tools: what the clinic says about itself.
 *
 * All three answer from the context the loop already loaded inside a tenant
 * transaction, so they perform no further I/O. That is not an optimisation —
 * it is what makes "the agent's world is exactly the clinic facts block" true.
 * A tool that went back to the database could return something the system
 * prompt never mentioned, and the guardrail's grounding check would then be
 * checking against the wrong corpus.
 */

/**
 * Which knowledge categories a free-text topic maps to.
 *
 * Categories are the clinic's own (`knowledge_item.category`: hours, location,
 * services, pricing, insurance, policies, faq, prep, staff). A patient asking
 * "how much" and a staff member filing something under "pricing" have to meet
 * somewhere, and that somewhere is here rather than in the model's head.
 */
const TOPIC_ALIASES: Readonly<Record<string, readonly string[]>> = {
  hours: ["hours", "open", "opening", "close", "closing", "time", "saa", "masaa", "weekend", "sunday", "saturday"],
  location: ["location", "where", "address", "directions", "parking", "map", "mahali", "wapi", "getting"],
  pricing: ["price", "pricing", "cost", "fee", "charge", "how much", "bei", "pesa", "deposit", "ngapi"],
  insurance: ["insurance", "sha", "nhif", "cover", "bima", "claim", "card"],
  policies: ["policy", "policies", "cancel", "cancellation", "reschedule", "refund", "late", "rules"],
  prep: ["prep", "prepare", "preparation", "fasting", "fast", "before", "bring", "instructions"],
  faq: ["faq", "question", "children", "kids", "walk", "walkin", "walk-in", "appointment needed"],
  staff: ["staff", "doctor", "doctors", "clinician", "provider", "who", "daktari", "nurse", "dentist"],
  services: ["service", "services", "offer", "treatment", "procedure", "do you"],
};

/** Score a knowledge item against the topic. Higher is a better match. */
function scoreItem(item: KnowledgeFact, topic: string, categories: readonly string[]): number {
  let score = 0;
  if (categories.includes(item.category)) score += 10;
  const haystack = `${item.category} ${item.title ?? ""} ${item.body}`.toLowerCase();
  for (const word of topic.split(/\W+/).filter((w) => w.length > 3)) {
    if (haystack.includes(word)) score += 2;
  }
  return score;
}

export function matchTopic(topic: string): readonly string[] {
  const lowered = topic.toLowerCase();
  const matched = Object.entries(TOPIC_ALIASES)
    .filter(([category, aliases]) =>
      category === lowered || aliases.some((alias) => lowered.includes(alias)),
    )
    .map(([category]) => category);
  return matched;
}

/** How many knowledge items one lookup may return. Keeps the reply short. */
export const MAX_KNOWLEDGE_ITEMS = 6;

export const getClinicInfoTool: AnyToolDefinition = defineTool<
  z.infer<typeof getClinicInfoSchema>
>({
  name: "get_clinic_info",
  description:
    "Look up what the clinic has written about a topic: hours, location, pricing, insurance, policies, preparation, common questions, or the clinicians. Use it whenever the patient asks a factual question about the clinic. If it returns nothing, you do not know the answer — say you will check with the team and escalate with kind low_confidence.",
  schema: getClinicInfoSchema,
  jsonSchema: JSON_SCHEMAS["get_clinic_info"] ?? {},
  mutating: false,

  async execute(input, runtime): Promise<ToolOutcome> {
    const categories = matchTopic(input.topic);
    const scored = runtime.context.knowledge
      .map((item) => ({ item, score: scoreItem(item, input.topic, categories) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_KNOWLEDGE_ITEMS)
      .map((entry) => entry.item);

    await runtime.audit({
      action: "agent.tool.get_clinic_info",
      entity: "conversation",
      entityId: runtime.conversationId,
      // The topic is the agent's own word for the question, not the patient's
      // text, so it is safe to keep — it is what makes a knowledge gap findable.
      meta: { topic: input.topic.slice(0, 64), matched: scored.length },
    });

    if (scored.length === 0) {
      return {
        ok: true,
        result: {
          found: false,
          items: [],
          guidance:
            "The clinic has written nothing about this. You do not know the answer. Tell the patient you will check with the team, and call escalate with kind low_confidence.",
        },
      };
    }

    return {
      ok: true,
      result: {
        found: true,
        items: scored.map((item) => ({
          category: item.category,
          title: item.title,
          body: item.body,
        })),
      },
      facts: scored.map((item) => item.body),
    };
  },
});

function serviceMatches(service: ServiceFact, query: string): boolean {
  const haystack =
    `${service.name} ${service.category ?? ""} ${service.description ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 2)
    .some((word) => haystack.includes(word));
}

export const listServicesTool: AnyToolDefinition = defineTool<z.infer<typeof listServicesSchema>>({
  name: "list_services",
  description:
    "List the clinic's bookable services with their ids, durations, prices and deposits. Use it to find the svc_ id you need before searching for slots, and to answer 'what do you charge for X'. Quote prices only as this tool returns them.",
  schema: listServicesSchema,
  jsonSchema: JSON_SCHEMAS["list_services"] ?? {},
  mutating: false,

  async execute(input, runtime): Promise<ToolOutcome> {
    const currency = runtime.context.clinic.currency as CurrencyCode;
    const all = runtime.context.services;
    const query = input.query;
    const matched =
      query === undefined ? all : all.filter((service) => serviceMatches(service, query));
    // A query that matches nothing falls back to the whole catalogue rather
    // than to an empty list: the patient asked for something, and the useful
    // answer is "here is what we do offer", not silence.
    const services = matched.length > 0 ? matched : all;

    await runtime.audit({
      action: "agent.tool.list_services",
      entity: "conversation",
      entityId: runtime.conversationId,
      meta: { query: input.query?.slice(0, 64) ?? null, returned: services.length },
    });

    const facts: string[] = [];
    const rendered = services.map((service) => {
      const price =
        service.priceMinor === null ? null : formatMoney(money(service.priceMinor, currency));
      const deposit =
        service.depositMinor === 0 ? null : formatMoney(money(service.depositMinor, currency));
      if (price !== null) facts.push(price);
      if (deposit !== null) facts.push(deposit);
      facts.push(service.name);
      if (service.prepInstructions !== null) facts.push(service.prepInstructions);

      return {
        service_id: service.id,
        name: service.name,
        category: service.category,
        duration_min: service.durationMin,
        price: price,
        price_note: service.priceNote,
        deposit_required: service.depositMinor > 0,
        deposit: deposit,
        description: service.description,
        preparation: service.prepInstructions,
        intake_questions: service.intakeQuestions,
      };
    });

    return {
      ok: true,
      result: { services: rendered, exact_match: matched.length > 0 },
      facts,
    };
  },
});

export const sendLocationTool: AnyToolDefinition = defineTool<z.infer<typeof sendLocationSchema>>({
  name: "send_location",
  description:
    "Send the clinic's map pin to the patient. Use it when they ask where the clinic is or how to get there, alongside a short text description.",
  schema: sendLocationSchema,
  jsonSchema: JSON_SCHEMAS["send_location"] ?? {},
  mutating: false,

  async execute(_input, runtime): Promise<ToolOutcome> {
    const location =
      runtime.context.locations.find((candidate) => candidate.isPrimary) ??
      runtime.context.locations[0];

    await runtime.audit({
      action: "agent.tool.send_location",
      entity: "conversation",
      entityId: runtime.conversationId,
      meta: { location_id: location?.id ?? null },
    });

    if (!location || location.lat === null || location.lng === null) {
      return {
        ok: false,
        result: {
          sent: false,
          reason: "no_pin_configured",
          guidance:
            location?.address == null
              ? "The clinic has no address or pin on file. Say you will check with the team and escalate with kind low_confidence."
              : `No map pin is configured, but the address is on file. Give the address as written and do not invent directions.`,
          ...(location?.address == null ? {} : { address: location.address }),
        },
        ...(location?.address == null ? {} : { facts: [location.address] }),
      };
    }

    return {
      ok: true,
      result: {
        sent: true,
        name: location.name,
        address: location.address,
      },
      facts: [location.name, ...(location.address === null ? [] : [location.address])],
      effects: {
        sendLocation: {
          latitude: location.lat,
          longitude: location.lng,
          name: location.name,
          ...(location.address === null ? {} : { address: location.address }),
        },
      },
    };
  },
});
