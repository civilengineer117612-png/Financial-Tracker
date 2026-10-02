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
  day: (v) => Number.isInteger(v) && v >= 1 && v <= 31,
  rate: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  idList: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0),
};

// Rules that involve two fields at once and so cannot live in a per-field spec.
const CROSS_FIELD = {
  Transaction: (t) => {
    if (t.status === "verified" && t.verified_at == null) return ["verified transaction needs verified_at"];
    if (t.status === "draft" && t.verified_at != null) return ["draft transaction must not have verified_at"];
    return [];
  },
  Entry: (e) => {
    const out = [];
    if ((e.account_id == null) === (e.category_id == null)) out.push("exactly one of account_id or category_id is required");
    if (e.envelope_id != null && e.account_id == null) out.push("envelope_id requires account_id");
    if (e.card_state != null && e.account_id == null) out.push("card_state requires account_id");
    return out;
  },
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
