// Section 7, Table 7.1: the entities and their fields, as data.
// Each field spec is {type, optional?, values?}. validateShape() is the only reader.
import { isCentavos, isPhDate, isPhTimestamp } from "./util.js";

const id = { type: "id" };
const name = { type: "name" };
const text = { type: "text" };
const bool = { type: "bool" };
const centavos = { type: "centavos" };
const date = { type: "date" };
const timestamp = { type: "timestamp" };
const count = { type: "count" };
const ease = { type: "ease" };
const oneOf = (...values) => ({ type: "enum", values });
const optional = (spec) => ({ ...spec, optional: true });

export const SCHEMAS = {
  Account: {
    id, name,
    class: oneOf("asset", "liability"),
    role: text, hidden_by_default: bool, archived: bool,
    opening_balance: centavos,   // natural sign: a liability's owed amount is positive
    opening_date: date,
    reserve_for: optional(id),   // ADDED: on a reserve account, the card account it must cover
    bank: optional(text),   // ADDED: which bank the account belongs to (src/model/banks.js); accounts of one bank share a picture
    icon_url: optional({ type: "iconurl" }),   // ADDED: where a bank logo is shown from when it could not be copied onto the phone (allow-listed icon services only)
    icon: optional({ type: "icon" }),   // ADDED: a small picture the owner chose for this account, kept on the phone
  },
  Goal: { id, account_id: id, name, target: optional(centavos), deadline: optional(date), hidden_by_default: bool,
    role: optional(oneOf("emergency")) },   // ADDED: what the goal is FOR, so nothing has to guess from its name (one goal at most holds a role)
  Envelope: { id, account_id: id, name, purpose: text },
  Transaction: {
    id, date, payee: text, memo: text,
    status: oneOf("draft", "verified"),
    source: oneOf("manual", "preset", "template", "photo", "voice", "import", "reconciliation"),
    reference_no: optional(text),
    tag_id: optional(id),        // ADDED: spec 8.1 says trip expenses carry one tag. OLD: no longer read or written (data version 4 copies it to trip_add)
    trip_add: optional(id),      // ADDED (version 4): put on this trip by hand (or by a manual trip start); overrides the dates
    trip_out: optional(id),      // ADDED (version 4): taken off this trip by hand although its date falls inside the trip
    created_at: timestamp, verified_at: optional(timestamp),
    edited_before_verify: optional(bool),   // ADDED (addendum 3): photo/voice drafts only, feeds survey Q4
  },
  Entry: {
    transaction_id: id,
    account_id: optional(id), category_id: optional(id), envelope_id: optional(id),
    amount: centavos,            // signed: debit +, credit -; a transaction's entries sum to 0
    card_state: optional(oneOf("pending", "posted")),   // "Card entry state" row
  },
  Category: { id, name, kind: oneOf("income", "expense"),
    role: optional(oneOf("food", "essentials", "subscription", "rent")) },   // ADDED: what the category is FOR (the scanner guesses by role, so renaming cannot break a guess)
  CategoryMap: { from: id, to: id, effective_from: date },
  // BudgetRule / SavingsRule / AllocationRule share one shape, told apart by `kind`.
  // Fields beyond id and effective_from are a placeholder; the append-only check
  // compares whole rows, so adding fields later does not weaken it.
  Rule: { id, kind: oneOf("budget", "savings", "allocation"), subject_id: id, amount: centavos, effective_from: date, created_at: timestamp },
  Template: { id, payee: name, amount: centavos, accounts: { type: "idList" }, schedule: name },
  Preset: { id, name, amount: centavos, category_id: id },
  PayeeRule: { id, payee_pattern: name, category_id: id },
  Subscription: { id, name, card: id, currency: name, amount: centavos, renewal_day: { type: "day" }, exit_condition: text, review_date: date },
  CheckIn: { id, date, account_id: id, counted_balance: centavos, ledger_balance: centavos, difference: centavos },
  Attachment: { id, transaction_id: id, type: name, file: name, file_timestamp: timestamp },
  Tag: { id, name, budget: optional(centavos),
    start: optional(date), end: optional(date) },   // ADDED (data version 4): the trip's first and last day, inclusive; entries on those days belong to it, worked out when shown
  // Addendum 3: one row per week, answered at the end of the weekly check-in.
  SurveyResponse: {
    id, week_start: date, week_end: date,
    q1_missed_count: count, q1_missed_amount: centavos,
    q2_ease: ease, q3_annoyance: text, q4_corrections_count: count,
  },
  // A payslip copied from paper. Gross and net are NOT stored as facts: the printed figures are kept so the app can compare
  // them with the lines and the deposit (src/model/income.js). Never an employee id, tax id or account number.
  Payslip: {
    id, employer: name, period_from: date, period_to: date, pay_date: date, account_id: id, transaction_id: id,
    printed_gross: centavos, printed_net: centavos, deposit: centavos, net_words: optional(text),
    printed_deductions: optional(centavos),   // ADDED: the total deductions printed on the paper, when it was entered
    version: optional(count),   // ADDED: which rules saved it (income.js PAYSLIP_VERSION); a payslip without one was saved before the date and reading fixes
  },
  // The figures a payslip had before it was changed, with the day of the change. The payslip keeps its ids; this only remembers.
  PayslipRevision: {
    id, payslip_id: id, changed_on: date, employer: name, period_from: date, period_to: date, pay_date: date,
    printed_gross: centavos, printed_net: centavos, deposit: centavos, printed_deductions: optional(centavos), lines: { type: "lineList" },
  },
  PayslipLine: { payslip_id: id, side: oneOf("earning", "deduction"), kind: oneOf("basic", "rice", "skills", "clothing", "transport", "overtime", "thirteenth", "bonus", "tax", "sss", "philhealth", "pagibig", "absences", "lates", "loan", "other"), amount: centavos, earned_month: optional({ type: "month" }) },
  ForeignAmount: { transaction_id: id, currency: name, foreign_amount: centavos, rate: { type: "rate" } },
};

const TYPE_CHECKS = {
  id: (v) => typeof v === "string" && v.length > 0,
  name: (v) => typeof v === "string" && v.trim().length > 0,
  text: (v) => typeof v === "string",
  bool: (v) => typeof v === "boolean",
  centavos: isCentavos,
  date: isPhDate,
  timestamp: isPhTimestamp,
  count: (v) => Number.isSafeInteger(v) && v >= 0,
  ease: (v) => Number.isInteger(v) && v >= 1 && v <= 5,
  // A small picture stored right in the record, so it travels with backups and never leaves the phone.
  iconurl: (v) => typeof v === "string" && v.length <= 300 && /^https:\/\/(t[0-3]\.gstatic\.com|www\.google\.com|icons\.duckduckgo\.com|icon\.horse)\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*$/.test(v),
  icon: (v) => typeof v === "string" && v.length <= 40000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v),
  month: (v) => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v),
  day: (v) => Number.isInteger(v) && v >= 1 && v <= 31,
  rate: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  lineList: (v) => Array.isArray(v) && v.every((l) => typeof l === "object" && l !== null && validateShape("PayslipLine", { payslip_id: "x", ...l }).length === 0),
  idList: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0),
};

// Rules that involve two fields at once and so cannot live in a per-field spec.
const CROSS_FIELD = {
  Tag: (t) => [
    ...((t.start == null) !== (t.end == null) ? ["a trip needs both a start and an end date, or neither"] : []),
    ...(t.start != null && t.end != null && t.end < t.start ? ["a trip cannot end before it starts"] : []),
  ],
  Transaction: (t) => {
    if (t.status === "verified" && t.verified_at == null) return ["verified transaction needs verified_at"];
    if (t.status === "draft" && t.verified_at != null) return ["draft transaction must not have verified_at"];
    const capture = t.source === "photo" || t.source === "voice";
    if (capture && typeof t.edited_before_verify !== "boolean") return ["photo/voice transaction must record edited_before_verify"];
    if (!capture && t.edited_before_verify === true) return ["edited_before_verify only applies to photo/voice transactions"];
    return [];
  },
  Entry: (e) => {
    const out = [];
    if ((e.account_id == null) === (e.category_id == null)) out.push("exactly one of account_id or category_id is required");
    if (e.envelope_id != null && e.account_id == null) out.push("envelope_id requires account_id");
    if (e.card_state != null && e.account_id == null) out.push("card_state requires account_id");
    return out;
  },
  Payslip: (p) => [
    ...(p.period_to < p.period_from ? ["period_to is before period_from"] : []),
    ...(p.printed_gross <= 0 || p.printed_net <= 0 || p.deposit <= 0 ? ["gross, net and deposit must be more than zero"] : []),
  ],
  PayslipLine: (l) => [
    ...(l.amount <= 0 ? ["a payslip line must be more than zero"] : []),
    ...(l.side === "earning" && ["tax", "sss", "philhealth", "pagibig", "absences", "lates", "loan"].includes(l.kind) ? ["that kind belongs under deductions"] : []),
    ...(l.side === "deduction" && ["basic", "rice", "skills", "clothing", "transport", "overtime", "thirteenth", "bonus"].includes(l.kind) ? ["that kind belongs under earnings"] : []),
    ...(l.kind === "overtime" && l.earned_month == null ? ["overtime needs the month it was earned"] : []),
    ...(l.kind !== "overtime" && l.earned_month != null ? ["only overtime carries an earned month"] : []),
  ],
  SurveyResponse: (r) => [
    ...(r.week_end < r.week_start ? ["week_end is before week_start"] : []),
    ...(r.q1_missed_amount < 0 ? ["q1_missed_amount cannot be negative"] : []),
  ],
  CheckIn: (c) => (isCentavos(c.counted_balance) && isCentavos(c.ledger_balance) && c.difference !== c.counted_balance - c.ledger_balance
    ? ["difference must equal counted_balance - ledger_balance"] : []),
};

const violation = (entity, field, message) => ({ code: "SHAPE", severity: "error", entity, field, message });

// Returns a list of violations; an empty list means the object is well-formed.
export function validateShape(entityName, obj) {
  const schema = SCHEMAS[entityName];
  if (!schema) throw new Error("Unknown entity: " + entityName);
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [violation(entityName, null, "must be an object")];
  }
  const out = [];
  for (const [field, spec] of Object.entries(schema)) {
    const v = obj[field];
    if (v === undefined || v === null) {
      if (!spec.optional) out.push(violation(entityName, field, "is required"));
      continue;
    }
    const ok = spec.type === "enum" ? spec.values.includes(v) : TYPE_CHECKS[spec.type](v);
    if (!ok) out.push(violation(entityName, field, "invalid " + spec.type + ": " + JSON.stringify(v)));
  }
  for (const field of Object.keys(obj)) {
    if (!(field in schema)) out.push(violation(entityName, field, "unknown field"));
  }
  if (out.length === 0 && CROSS_FIELD[entityName]) {
    for (const m of CROSS_FIELD[entityName](obj)) out.push(violation(entityName, null, m));
  }
  return out;
}
