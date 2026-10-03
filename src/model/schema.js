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
  Goal: { id, account_id: id, name, target: optional(centavos), deadline: optional(date), hidden_by_default: bool },
  Envelope: { id, account_id: id, name, purpose: text },
  Transaction: {
    id, date, payee: text, memo: text,
    status: oneOf("draft", "verified"),
    source: oneOf("manual", "preset", "template", "photo", "voice", "import", "reconciliation"),
    reference_no: optional(text),
    tag_id: optional(id),        // ADDED: spec 8.1 says trip expenses carry one tag
    created_at: timestamp, verified_at: optional(timestamp),
    edited_before_verify: optional(bool),   // ADDED (addendum 3): photo/voice drafts only, feeds survey Q4
  },
  Entry: {
    transaction_id: id,
    account_id: optional(id), category_id: optional(id), envelope_id: optional(id),
    amount: centavos,            // signed: debit +, credit -; a transaction's entries sum to 0
    card_state: optional(oneOf("pending", "posted")),   // "Card entry state" row
  },
  Category: { id, name, kind: oneOf("income", "expense") },
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
  Tag: { id, name, budget: optional(centavos) },
  // Addendum 3: one row per week, answered at the end of the weekly check-in.
  SurveyResponse: {
    id, week_start: date, week_end: date,
    q1_missed_count: count, q1_missed_amount: centavos,
    q2_ease: ease, q3_annoyance: text, q4_corrections_count: count,
  },
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
  day: (v) => Number.isInteger(v) && v >= 1 && v <= 31,
  rate: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  idList: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0),
};

// Rules that involve two fields at once and so cannot live in a per-field spec.
const CROSS_FIELD = {
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
