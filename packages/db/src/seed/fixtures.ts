import type {
  availabilityRule,
  clinic,
  knowledgeItem,
  location,
  patient,
  patientConsent,
  provider,
  providerService,
  service,
  serviceIntakeQuestion,
  staffUser,
} from "../schema/index.js";
import { seedId } from "./ids.js";

/**
 * The Afyanex fixture — the founding design partner (ADR-004), as a realistic
 * Nairobi clinic: KES pricing in minor units, Africa/Nairobi hours, Mon–Sat.
 *
 * Everything here is invented. The patients are fake people with fake, valid
 * format `+2547…` numbers, and the email domain is a reserved `.example` TLD:
 * seeding a dev database must never be able to message a real person.
 */

export const AFYANEX_CLINIC_ID = seedId("clinic", "afyanex");

const KES = "KES";
/** KES minor units — 1 shilling = 100 cents. `1_500` shillings → `150_000`. */
const shillings = (amount: number): number => amount * 100;

export const clinicRow: typeof clinic.$inferInsert = {
  id: AFYANEX_CLINIC_ID,
  name: "Afyanex Clinic",
  slug: "afyanex",
  country: "KE",
  timezone: "Africa/Nairobi",
  currency: KES,
  defaultLanguage: "en",
  emergencyContactPhone: "+254709000100",
  bookingWindowDays: 30,
  minNoticeMin: 60,
  slotGranularityMin: 15,
  cancellationPolicy: { free_reschedule_hours: 24, forfeit_hours: 2 },
  flags: { seeded: true },
  plan: "trial",
  onboardingState: { step: "seeded", whatsapp_connected: false, mpesa_connected: false },
  kmpdcLicenceNo: "KMPDC/F/2019/00421",
};

export const locationRows: (typeof location.$inferInsert)[] = [
  {
    id: seedId("location", "kilimani"),
    clinicId: AFYANEX_CLINIC_ID,
    name: "Afyanex Clinic — Kilimani",
    address: "2nd Floor, Wood Avenue Plaza, Kilimani, Nairobi",
    lat: "-1.29210",
    lng: "36.78330",
    mapsUrl: "https://maps.example/afyanex-kilimani",
    phone: "+254709000100",
    isPrimary: true,
  },
];

export const staffRows: (typeof staffUser.$inferInsert)[] = [
  {
    id: seedId("user", "owner"),
    clinicId: AFYANEX_CLINIC_ID,
    email: "wanjiru@afyanex.example",
    name: "Dr. Wanjiru Kamau",
    role: "owner",
    phone: "+254709000101",
    notifyPrefs: { escalations: "push", daily_digest: true },
  },
  {
    id: seedId("user", "admin"),
    clinicId: AFYANEX_CLINIC_ID,
    email: "mercy@afyanex.example",
    name: "Mercy Achieng",
    role: "admin",
    phone: "+254709000102",
    notifyPrefs: { escalations: "push", daily_digest: true },
  },
  {
    id: seedId("user", "frontdesk"),
    clinicId: AFYANEX_CLINIC_ID,
    email: "kelvin@afyanex.example",
    name: "Kelvin Mutiso",
    role: "staff",
    phone: "+254709000103",
    notifyPrefs: { escalations: "push", daily_digest: false },
  },
];

export const providerRows: (typeof provider.$inferInsert)[] = [
  {
    id: seedId("provider", "gp"),
    clinicId: AFYANEX_CLINIC_ID,
    staffUserId: seedId("user", "owner"),
    displayName: "Dr. Wanjiru Kamau",
    title: "MBChB",
    specialty: "General practice",
    bioPublic: "General practitioner, 12 years in family medicine. English and Kiswahili.",
    sort: 1,
  },
  {
    id: seedId("provider", "dentist"),
    clinicId: AFYANEX_CLINIC_ID,
    displayName: "Dr. Samuel Otieno",
    title: "BDS",
    specialty: "Dentistry",
    bioPublic: "Dental surgeon. Cleanings, fillings and extractions.",
    sort: 2,
  },
  {
    id: seedId("provider", "nurse"),
    clinicId: AFYANEX_CLINIC_ID,
    displayName: "Grace Njeri",
    title: "RN, RM",
    specialty: "Maternal health",
    bioPublic: "Registered nurse and midwife. Antenatal clinic and immunisations.",
    sort: 3,
  },
];

export const serviceRows: (typeof service.$inferInsert)[] = [
  {
    id: seedId("service", "gp-consult"),
    clinicId: AFYANEX_CLINIC_ID,
    name: "GP consultation",
    category: "consultation",
    durationMin: 20,
    bufferMin: 5,
    priceMinor: shillings(2_000),
    depositMinor: 0,
    descriptionPublic: "See a general practitioner. Consultation fee excludes lab tests and drugs.",
  },
  {
    id: seedId("service", "gp-followup"),
    clinicId: AFYANEX_CLINIC_ID,
    name: "GP follow-up",
    category: "consultation",
    durationMin: 15,
    bufferMin: 5,
    priceMinor: shillings(1_000),
    depositMinor: 0,
    descriptionPublic: "Review visit within 14 days of a consultation.",
  },
  {
    id: seedId("service", "dental-scaling"),
    clinicId: AFYANEX_CLINIC_ID,
    name: "Dental scaling and polishing",
    category: "dental",
    durationMin: 45,
    bufferMin: 10,
    priceMinor: shillings(4_500),
    depositMinor: shillings(1_500),
    descriptionPublic: "Professional cleaning, scaling and polishing.",
    prepInstructions: "Brush before you come. Arrive 10 minutes early for the first visit.",
  },
  {
    id: seedId("service", "dental-extraction"),
    clinicId: AFYANEX_CLINIC_ID,
    name: "Tooth extraction (simple)",
    category: "dental",
    durationMin: 40,
    bufferMin: 10,
    priceMinor: shillings(3_500),
    depositMinor: shillings(1_000),
    descriptionPublic: "Simple extraction under local anaesthetic.",
  },
  {
    id: seedId("service", "antenatal"),
    clinicId: AFYANEX_CLINIC_ID,
    name: "Antenatal visit",
    category: "maternal",
    durationMin: 30,
    bufferMin: 5,
    priceMinor: shillings(2_500),
    depositMinor: shillings(500),
    descriptionPublic: "Routine antenatal check with the midwife.",
    prepInstructions: "Bring your antenatal booklet if you have one.",
  },
  {
    id: seedId("service", "lab-haemogram"),
    clinicId: AFYANEX_CLINIC_ID,
    name: "Full haemogram (lab)",
    category: "laboratory",
    durationMin: 10,
    bufferMin: 0,
    priceMinor: shillings(1_200),
    depositMinor: 0,
    priceNote: "Results the same day.",
    descriptionPublic: "Blood sample taken at the clinic lab.",
  },
];

export const providerServiceRows: (typeof providerService.$inferInsert)[] = [
  ["gp", "gp-consult"],
  ["gp", "gp-followup"],
  ["gp", "lab-haemogram"],
  ["dentist", "dental-scaling"],
  ["dentist", "dental-extraction"],
  ["nurse", "antenatal"],
  ["nurse", "lab-haemogram"],
].map(([providerKey, serviceKey]) => ({
  clinicId: AFYANEX_CLINIC_ID,
  providerId: seedId("provider", providerKey as string),
  serviceId: seedId("service", serviceKey as string),
}));

export const intakeQuestionRows: (typeof serviceIntakeQuestion.$inferInsert)[] = [
  {
    id: seedId("intakeQuestion", "dental-1"),
    clinicId: AFYANEX_CLINIC_ID,
    serviceId: seedId("service", "dental-scaling"),
    question: "Have you had a dental cleaning with us before?",
    kind: "yes_no",
    required: true,
    sort: 1,
  },
  {
    id: seedId("intakeQuestion", "dental-2"),
    clinicId: AFYANEX_CLINIC_ID,
    serviceId: seedId("service", "dental-scaling"),
    question: "Is there anything the dentist should know before your visit?",
    kind: "text",
    required: false,
    sort: 2,
  },
  {
    id: seedId("intakeQuestion", "extraction-1"),
    clinicId: AFYANEX_CLINIC_ID,
    serviceId: seedId("service", "dental-extraction"),
    question: "Which tooth is the appointment for? (e.g. upper left back)",
    kind: "text",
    required: true,
    sort: 1,
  },
  {
    id: seedId("intakeQuestion", "extraction-2"),
    clinicId: AFYANEX_CLINIC_ID,
    serviceId: seedId("service", "dental-extraction"),
    question: "Have you been seen at Afyanex for this tooth before?",
    kind: "yes_no",
    required: false,
    sort: 2,
  },
  {
    id: seedId("intakeQuestion", "antenatal-1"),
    clinicId: AFYANEX_CLINIC_ID,
    serviceId: seedId("service", "antenatal"),
    question: "How many weeks along are you?",
    kind: "text",
    required: true,
    sort: 1,
  },
  {
    id: seedId("intakeQuestion", "antenatal-2"),
    clinicId: AFYANEX_CLINIC_ID,
    serviceId: seedId("service", "antenatal"),
    question: "Do you already have an antenatal booklet?",
    kind: "choice",
    choices: ["Yes, from Afyanex", "Yes, from another clinic", "No"],
    required: true,
    sort: 2,
  },
];

/**
 * Weekly hours, wall clock in Africa/Nairobi. Weekday 1 = Monday … 6 =
 * Saturday; the clinic is closed on Sunday, so no rule exists for weekday 0.
 */
const hours = (
  providerKey: string,
  weekdays: readonly number[],
  startLocal: string,
  endLocal: string,
): (typeof availabilityRule.$inferInsert)[] =>
  weekdays.map((weekday) => ({
    id: seedId("availabilityRule", `${providerKey}-${weekday}-${startLocal.slice(0, 2)}`),
    clinicId: AFYANEX_CLINIC_ID,
    providerId: seedId("provider", providerKey),
    locationId: seedId("location", "kilimani"),
    weekday,
    startLocal,
    endLocal,
  }));

export const availabilityRows: (typeof availabilityRule.$inferInsert)[] = [
  ...hours("gp", [1, 2, 3, 4, 5], "08:00:00", "17:00:00"),
  ...hours("gp", [6], "09:00:00", "13:00:00"),
  ...hours("dentist", [1, 3, 5], "09:00:00", "16:00:00"),
  ...hours("dentist", [6], "09:00:00", "13:00:00"),
  ...hours("nurse", [2, 4], "08:00:00", "16:00:00"),
  ...hours("nurse", [6], "09:00:00", "13:00:00"),
];

/**
 * The clinic's own words — the only ground truth the agent may answer from
 * (CONVERSATION_ENGINE.md). Anything not here, it does not know.
 */
export const knowledgeRows: (typeof knowledgeItem.$inferInsert)[] = [
  {
    category: "hours",
    title: "Opening hours",
    body: "Monday to Friday 8:00am–5:00pm. Saturday 9:00am–1:00pm. Closed on Sundays and public holidays.",
    sort: 1,
  },
  {
    category: "location",
    title: "Where we are",
    body: "2nd Floor, Wood Avenue Plaza, Kilimani, Nairobi. Entrance is on Wood Avenue, opposite the petrol station. Lift to the 2nd floor.",
    sort: 2,
  },
  {
    category: "location",
    title: "Parking",
    body: "Free parking for patients in the basement, first two hours. Boda riders can wait at the gate.",
    sort: 3,
  },
  {
    category: "pricing",
    title: "Consultation fees",
    body: "GP consultation KES 2,000. Follow-up within 14 days KES 1,000. Dental scaling and polishing KES 4,500. Simple extraction KES 3,500. Antenatal visit KES 2,500. Full haemogram KES 1,200. Fees exclude medicines.",
    sort: 4,
  },
  {
    category: "pricing",
    title: "Deposits",
    body: "Dental and antenatal appointments need an M-Pesa deposit to confirm the booking. The deposit is deducted from the total on the day.",
    sort: 5,
  },
  {
    category: "insurance",
    title: "Insurance and SHA",
    body: "We accept cash, M-Pesa and card. SHA and private insurance are not billed directly yet — pay at the clinic and we give you a receipt to claim.",
    sort: 6,
  },
  {
    category: "policies",
    title: "Cancellations and rescheduling",
    body: "Reschedule or cancel free of charge up to 24 hours before your appointment. Inside 2 hours the deposit is not refunded.",
    sort: 7,
  },
  {
    category: "faq",
    title: "Do I need an appointment?",
    body: "Walk-ins are seen when there is a gap, but booked patients go first. Booking on WhatsApp takes a minute.",
    sort: 8,
  },
  {
    category: "faq",
    title: "Do you see children?",
    body: "Yes, we see children of all ages for general consultations and immunisations. Please come with the child's health booklet.",
    sort: 9,
  },
  {
    category: "prep",
    title: "Before a lab test",
    body: "For a fasting blood sugar or lipid profile, do not eat for 8 hours before. Water is fine. Other lab tests need no preparation.",
    sort: 10,
  },
  {
    category: "staff",
    title: "Our clinicians",
    body: "Dr. Wanjiru Kamau (general practice), Dr. Samuel Otieno (dentistry), Grace Njeri (nurse-midwife, antenatal clinic).",
    sort: 11,
  },
].map((item, index) => ({
  ...item,
  id: seedId("knowledge", `k${String(index + 1).padStart(2, "0")}`),
  clinicId: AFYANEX_CLINIC_ID,
  isPublic: true,
  updatedBy: "seed",
}));

/**
 * 20 demo patients. Names are common Kenyan names, numbers are inside the
 * +254 712 000 0xx block and belong to nobody. Never print these raw — the
 * seed logs them through `maskPhone` (hard rule 4).
 */
const PATIENT_NAMES: readonly (readonly [string, string, string])[] = [
  ["Achieng Odhiambo", "Achieng", "sw"],
  ["Brian Kiprono", "Brian", "en"],
  ["Cynthia Wambui", "Cynthia", "en"],
  ["David Mwangi", "David", "sw"],
  ["Esther Nafula", "Esther", "sw"],
  ["Faith Chepkorir", "Faith", "en"],
  ["George Omondi", "George", "sw"],
  ["Hellen Muthoni", "Hellen", "en"],
  ["Ian Kariuki", "Ian", "en"],
  ["Joyce Akinyi", "Joyce", "sw"],
  ["Kevin Barasa", "Kevin", "en"],
  ["Lucy Wanjala", "Lucy", "sw"],
  ["Michael Kimani", "Michael", "en"],
  ["Nancy Chelimo", "Nancy", "sw"],
  ["Peter Njoroge", "Peter", "en"],
  ["Rose Adhiambo", "Rose", "sw"],
  ["Samuel Kilonzo", "Samuel", "en"],
  ["Teresia Wairimu", "Teresia", "sw"],
  ["Victor Mutua", "Victor", "en"],
  ["Winnie Chebet", "Winnie", "sw"],
];

export const patientRows: (typeof patient.$inferInsert)[] = PATIENT_NAMES.map(
  ([fullName, preferredName, language], index) => {
    const suffix = String(index + 1).padStart(3, "0");
    const phoneE164 = `+254712000${suffix}`;
    return {
      id: seedId("patient", `p${suffix}`),
      clinicId: AFYANEX_CLINIC_ID,
      phoneE164,
      waId: phoneE164.slice(1),
      fullName,
      preferredName,
      language,
      flags: { vip: false, blocked: false, no_show_count: 0 },
    };
  },
);

/**
 * Consent captured at first contact (COMPLIANCE.md §1). Everyone consented to
 * service messages and processing; nobody opted into marketing, which is the
 * honest default and keeps template sends inside the utility category.
 */
export const consentRows: (typeof patientConsent.$inferInsert)[] = patientRows.flatMap((p, i) => {
  const suffix = String(i + 1).padStart(3, "0");
  return (
    [
      ["data_processing", true],
      ["service_messages", true],
      ["marketing", false],
    ] as const
  ).map(([kind, granted]) => ({
    id: seedId("consent", `${suffix}-${kind.slice(0, 3)}`),
    clinicId: AFYANEX_CLINIC_ID,
    patientId: p.id as string,
    kind,
    granted,
    source: "first_contact_notice",
  }));
});
