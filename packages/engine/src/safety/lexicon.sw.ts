/**
 * Swahili + Sheng emergency / distress lexicon.
 *
 * BINDING PROCESS (SAFETY.md §3): **adding a term here requires an eval case**
 * in `evals/datasets/emergency.jsonl`. See `lexicon.en.ts` for the full note.
 *
 * ## Why the phrase lists look repetitive
 *
 * Swahili marks subject and tense with prefixes — *ana*vuja, *na*vuja,
 * *ame*vuja, *ku*vuja are all "bleeding" — and the matcher pins every
 * alternative to a word start, so a bare stem ("vuja damu") would not match
 * inside "anavuja damu". Rather than guess at morphology with a regex, each
 * realistic prefix is spelled out. That is verbose, but a reviewer who does not
 * read regex can still check the list, which matters more here than brevity.
 *
 * ## Sheng
 *
 * CLAUDE.md treats Sheng as English/Swahili code-mixing rather than a third
 * language, so Sheng is covered two ways: the English and Swahili catalogues
 * both run over every message (a mixed sentence hits whichever list owns the
 * clinical word), plus the Sheng-specific idioms below that neither parent
 * language contains ("amefaint", "sina hewa", "ako mbaya sana").
 */

import { term, type LexiconTerm } from "./lexicon.js";

export const SW_TERMS: readonly LexiconTerm[] = [
  // ------------------------------------------------------------------ kifua
  term("sw_chest_pain", "emergency", [
    "kifua kinauma",
    "kifua kinaniuma",
    "kifua chauma",
    "kifua kinabana",
    "kifua kimebana",
    "maumivu ya kifua",
    "maumivu kifuani",
    "nauma kifuani",
    "naumwa kifuani",
    "anaumwa kifuani",
    "kifua inauma",
    "chest inauma",
    "chest inaniuma",
    "chest yangu inauma",
  ]),

  // ------------------------------------------------------------------ pumzi
  term("sw_cannot_breathe", "emergency", [
    "sina pumzi",
    "sipati pumzi",
    "siwezi pumua",
    "siwezi kupumua",
    "hawezi kupumua",
    "anashindwa kupumua",
    "ashindwa kupumua",
    "ameshindwa kupumua",
    "hapumui",
    "hapumuwi",
    "pumzi imekatika",
    "pumzi inaisha",
    "kukosa pumzi",
    "anahema sana",
    "anahema kwa shida",
    "napumua kwa shida",
    "sina hewa",
    "napitwa na pumzi",
    "sina breath",
    "siwezi breathe",
  ]),

  term("sw_choking", "emergency", [
    "amekabwa koo",
    "koo limebana",
    "koo linabana",
    "koo limefunga",
    "amekwama kitu kooni",
    "kitu kimekwama kooni",
  ]),

  // ------------------------------------------------------------------- damu
  term("sw_heavy_bleeding", "emergency", [
    "anavuja damu",
    "navuja damu",
    "unavuja damu",
    "inavuja damu",
    "amevuja damu",
    "kuvuja damu",
    "anatokwa damu",
    "natokwa damu",
    "ametokwa damu",
    "anatoka damu sana",
    "natoka damu sana",
    "damu nyingi",
    "damu haisimami",
    "damu haiishi",
    "damu inatoka sana",
    "damu inamwagika",
    "kutokwa damu nyingi",
    "amepoteza damu nyingi",
    "anableed",
    "anableed sana",
  ]),

  term("sw_blood_from_mouth", "emergency", [
    "anatapika damu",
    "natapika damu",
    "anakohoa damu",
    "nakohoa damu",
    "anatema damu",
  ]),

  // ----------------------------------------------------------------- fahamu
  term("sw_unconscious", "emergency", [
    "amezimia",
    "nimezimia",
    "amezirai",
    "anazimia",
    "amepoteza fahamu",
    "hana fahamu",
    "hajitambui",
    "haamki",
    "haitiki",
    "hajaamka",
    "ameanguka na hajaamka",
    "amelala hajaamka",
    "amefaint",
    "anafaint",
    "amecollapse",
    "amecollapsed",
    "ameanguka ghafla",
  ]),

  term("sw_seizure", "emergency", [
    "degedege",
    "anadegedege",
    "anapata degedege",
    "ana degedege",
    "kifafa",
    "amepata kifafa",
    "anatetemeka sana",
    "anatetemeka mwili mzima",
    "anatoa povu mdomoni",
  ]),

  term("sw_stroke", "emergency", [
    "kiharusi",
    "amepata kiharusi",
    "uso umepooza",
    "mdomo umepinda",
    "hawezi kuongea vizuri",
    "upande mmoja hausikii",
    "mkono umepooza",
  ]),

  // ------------------------------------------------------------------- sumu
  term("sw_overdose", "emergency", [
    "amemeza dawa nyingi",
    "nimemeza dawa nyingi",
    "amemeza vidonge vingi",
    "nimemeza vidonge vingi",
    "amekunywa sumu",
    "amemeza sumu",
    "nimemeza sumu",
    "amekunywa dawa ya panya",
    "sumu ya panya",
    "amekunywa mafuta ya taa",
    "amemeza chupa nzima",
  ]),

  term("sw_self_harm_acted", "emergency", [
    "nimejikata",
    "amejikata",
    "nimejaribu kujiua",
    "amejaribu kujiua",
    "amejaribu kujinyonga",
    "nimejidhuru",
  ]),

  // -------------------------------------------------------------- uzazi
  term("sw_obstetric_emergency", "emergency", [
    "uchungu na damu",
    "nina uchungu na damu",
    "uchungu wa kuzaa na damu",
    "maji yamevunjika na damu",
    "mimba na damu",
    "ana mimba na anavuja damu",
    "natokwa damu na nina mimba",
    "mtoto hasogei tumboni",
    "mtoto hajisogezi",
    "sijamsikia mtoto akisogea",
    "mtoto anatoka",
  ]),

  // -------------------------------------------------------------- watoto
  term("sw_child_fever_fits", "emergency", [
    "homa kali na degedege",
    "homa na degedege",
    "mtoto ana degedege",
    "mtoto anadegedege",
    "mtoto ana homa na anatetemeka",
    "mtoto amezimia",
    "mtoto hanyonyi na amelegea",
    "mtoto amelegea sana",
  ]),

  // ------------------------------------------------------------- majeraha
  term("sw_severe_burn", "emergency", [
    "ameungua vibaya",
    "amechomeka vibaya",
    "ameungua mwili mzima",
    "amemwagikiwa na maji ya moto",
  ]),

  term("sw_snake_bite", "emergency", ["ameumwa na nyoka", "nyoka amemuuma", "nimeumwa na nyoka"]),

  term("sw_drowning", "emergency", ["amezama majini", "alizama majini", "amezama kwa maji"]),

  term("sw_accident", "emergency", [
    "ajali",
    "amepata ajali",
    "amegongwa na gari",
    "amegongwa na boda",
    "amegongwa na pikipiki",
    "ameumia vibaya",
    "amejeruhiwa vibaya",
  ]),

  // ------------------------------------------------------------- kufa
  term("sw_dying", "emergency", [
    "anakufa",
    "nakufa",
    "atakufa",
    "anaenda kufa",
    "amededi",
    "anadedi",
    "ambulensi",
    "gari ya wagonjwa",
    "ni dharura",
    "hii ni dharura",
    "saidieni haraka",
    "tusaidieni haraka",
    "ako mbaya sana",
    "yuko mbaya sana",
    "hali yake ni mbaya sana",
  ]),

  term("sw_severe_pain", "emergency", [
    "maumivu makali sana",
    "naumwa sana siwezi",
    "siwezi kuvumilia maumivu",
    "anapiga kelele kwa maumivu",
  ]),

  // --------------------------------------------------------------- distress
  term("sw_suicidal_ideation", "distress", [
    "nataka kujiua",
    "nitajiua",
    "nafikiria kujiua",
    "nataka kujimaliza",
    "nataka kujinyonga",
    "nataka kufa",
    "ningependa kufa",
    "sitaki kuishi",
    "sioni sababu ya kuishi",
    "maisha hayana maana",
    "nimechoka na maisha",
    "nimechoka na hii life",
    "nimechoka na dunia",
    "nataka kujidhuru",
  ]),

  term("sw_hopelessness", "distress", [
    "nimekata tamaa kabisa",
    "hakuna anayenijali",
    "ni mzigo kwa kila mtu",
    "hakuna maana tena",
    "sina matumaini tena",
  ]),
];
