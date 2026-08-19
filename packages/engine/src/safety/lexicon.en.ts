/**
 * English emergency + distress lexicon.
 *
 * BINDING PROCESS (SAFETY.md §3): **adding a term here requires an eval case**
 * in `evals/datasets/emergency.jsonl`. `lexicon.test.ts` runs the whole corpus
 * through this catalogue with no API key and fails the build if recall or
 * precision regresses, so a term added without a case is a term nobody is
 * measuring.
 *
 * Read `lexicon.ts` first for the matching model. In short: phrases are folded
 * to lowercase, apostrophe-free, punctuation-free text, every letter run is
 * tolerant of stretching and doubling, and words may run together — so write
 * phrases in their plainest form ("cant breathe", not "can't breathe") and let
 * the builder handle the variants.
 *
 * Severity: `emergency` = physical emergency or self-harm already acted on.
 * `distress` = self-harm or suicidal ideation (SAFETY.md §4).
 */

import { term, type LexiconTerm } from "./lexicon.js";

export const EN_TERMS: readonly LexiconTerm[] = [
  // ---------------------------------------------------------------- cardiac
  term("chest_pain", "emergency", [
    "chest pain",
    "chest pains",
    "pain in my chest",
    "pain in the chest",
    "pain in her chest",
    "pain in his chest",
    "chest is paining",
    "chest is painful",
    "chest hurts",
    "chest hurting",
    // Letter-transposition typo the `x+` builder cannot reach on its own.
    "chets pain",
    "chest is tight",
    "chest is very tight",
    "my chest is tight",
    "chest tightness",
    "tightness in my chest",
    "pressure in my chest",
    "chest feels heavy",
    "crushing pain",
    "heart attack",
    "my heart is racing and",
  ]),

  // -------------------------------------------------------------- breathing
  term("cannot_breathe", "emergency", [
    "cant breathe",
    "cant breath",
    "cannot breathe",
    "can not breathe",
    "couldnt breathe",
    "unable to breathe",
    "struggling to breathe",
    "struggling for air",
    "trouble breathing",
    "difficulty breathing",
    "difficult to breathe",
    "hard to breathe",
    "shortness of breath",
    "short of breath",
    "cant catch my breath",
    "gasping for air",
    "gasping for breath",
    "not breathing",
    "isnt breathing",
    "stopped breathing",
    "hardly breathing",
    "barely breathing",
    "cant get air",
    "cannot get air",
    "no air",
    "suffocating",
    "wheezing badly",
    "asthma attack",
  ]),

  term("choking", "emergency", [
    "choking",
    "choked on",
    "something stuck in my throat",
    "something stuck in his throat",
    "cant swallow anything",
  ]),

  // --------------------------------------------------------------- bleeding
  term("heavy_bleeding", "emergency", [
    "bleeding heavily",
    "bleeding a lot",
    "heavy bleeding",
    "bleeding badly",
    "bleeding non stop",
    "bleeding nonstop",
    "wont stop bleeding",
    "cant stop the bleeding",
    "cant stop bleeding",
    "blood wont stop",
    "lots of blood",
    "a lot of blood",
    "so much blood",
    "losing a lot of blood",
    "blood everywhere",
    "gushing blood",
    "pouring blood",
    "haemorrhage",
    "hemorrhage",
    "bled through",
    "soaked through",
  ]),

  term("blood_from_mouth", "emergency", [
    "coughing blood",
    "coughing up blood",
    "vomiting blood",
    "throwing up blood",
    "blood in my vomit",
    "spitting blood",
    "spitting up blood",
  ]),

  // ------------------------------------------------------------ neurological
  term("unconscious", "emergency", [
    "unconscious",
    "unresponsive",
    "passed out",
    "blacked out",
    "not waking up",
    "wont wake up",
    "cant wake him",
    "cant wake her",
    "lost consciousness",
    "not responding at all",
    "collapsed",
    "fainted",
    "keeps fainting",
  ]),

  term("seizure", "emergency", [
    "seizure",
    "seizures",
    "convulsing",
    "convulsions",
    "having a fit",
    "having fits",
    "epileptic fit",
    "shaking uncontrollably",
    "jerking uncontrollably",
    "foaming at the mouth",
  ]),

  term("stroke", "emergency", [
    "stroke",
    "face is drooping",
    "face drooping",
    "slurred speech",
    "speech is slurred",
    "cant move one side",
    "one side of his body",
    "one side of her body",
    "arm has gone numb",
    "sudden numbness",
    "sudden weakness on one",
  ]),

  term("head_injury", "emergency", [
    "head injury",
    "hit his head",
    "hit her head",
    "hit my head hard",
    "banged his head",
    "fell and hit",
    "vomiting after a fall",
  ]),

  // ---------------------------------------------------------- poison / drugs
  term("overdose", "emergency", [
    "overdose",
    "overdosed",
    "took too many pills",
    "took too many tablets",
    "took the whole bottle",
    "swallowed the whole packet",
    "swallowed pills",
    "swallowed poison",
    "drank poison",
    "took poison",
    "rat poison",
    "drank paraffin",
    "drank bleach",
    "poisoned",
  ]),

  term("self_harm_acted", "emergency", [
    "i cut myself",
    "cut my wrists",
    "slit my wrists",
    "i have hurt myself",
    "tried to kill myself",
    "tried to hang myself",
    "attempted suicide",
    "took pills to end",
  ]),

  // ----------------------------------------------------------------- allergy
  term("anaphylaxis", "emergency", [
    "throat is closing",
    "throat closing",
    "throat is swelling",
    "tongue is swelling",
    "lips are swelling",
    "face is swelling up",
    "anaphylaxis",
    "anaphylactic",
    "severe allergic reaction",
  ]),

  // ------------------------------------------------------------- obstetric
  term("obstetric_emergency", "emergency", [
    "in labour and bleeding",
    "labour and bleeding",
    "labor and bleeding",
    "contractions and bleeding",
    "water broke and bleeding",
    "water broke and there is blood",
    "pregnant and bleeding",
    "bleeding and pregnant",
    "bleeding in pregnancy",
    "miscarrying",
    "baby is not moving",
    "baby hasnt moved",
    "havent felt the baby move",
    "the head is coming",
  ]),

  // ---------------------------------------------------------------- paediatric
  term("child_fever_fits", "emergency", [
    "fever and fitting",
    "fever and convulsions",
    "fever and convulsing",
    "baby is convulsing",
    "child is convulsing",
    "child is fitting",
    "high fever and shaking",
    "temperature and fits",
    "baby is limp",
    "baby wont feed and is",
  ]),

  // -------------------------------------------------------------- trauma etc
  term("severe_burn", "emergency", [
    "badly burnt",
    "badly burned",
    "severe burns",
    "burnt all over",
    "scalded badly",
  ]),

  term("snake_bite", "emergency", ["snake bite", "snake bit", "bitten by a snake"]),

  term("drowning", "emergency", ["drowning", "drowned", "pulled out of the water"]),

  term("electrocution", "emergency", ["electrocuted", "shocked by electricity"]),

  term("accident", "emergency", [
    "car accident",
    "road accident",
    "hit by a car",
    "hit by a matatu",
    "hit by a boda",
    "knocked down by a",
    "run over",
    "bad accident",
  ]),

  // --------------------------------------------------------------- escalators
  term("severe_pain", "emergency", [
    "worst pain of my life",
    "unbearable pain",
    "excruciating pain",
    "cant bear the pain",
    "screaming in pain",
    "pain is unbearable",
  ]),

  term("dying", "emergency", [
    "i am dying",
    "im dying",
    "he is dying",
    "she is dying",
    "going to die",
    "about to die",
    "he will die",
    "she will die",
    "ambulance",
    "its an emergency",
    "this is an emergency",
    "emergency right now",
    "help us now",
  ]),

  // ---------------------------------------------------------------- distress
  term("suicidal_ideation", "distress", [
    "want to kill myself",
    "kill myself",
    "killing myself",
    "want to die",
    "wish i was dead",
    "wish i were dead",
    "end my life",
    "end it all",
    "no reason to live",
    "nothing to live for",
    "better off dead",
    "suicidal",
    "suicide",
    "thinking of ending it",
    "dont want to live",
    "dont want to be here anymore",
    "tired of living",
    "tired of life",
    "life is not worth",
    "cant go on anymore",
    "cant take it anymore",
    "want to hurt myself",
    "want to harm myself",
    "harm myself",
  ]),

  term("hopelessness", "distress", [
    "i have given up",
    "nobody would miss me",
    "better off without me",
    "i am a burden to everyone",
    "there is no point anymore",
    "i feel completely hopeless",
    "i see no way out",
    "no way out of this",
  ]),
];
