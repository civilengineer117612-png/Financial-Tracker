// Every record in every collection of a ledger must be well-formed. Shared by saving to the
// phone, backing up and restoring, so all three apply exactly the same rule.
import { validateShape } from "./schema.js";

// state key -> entity name, for validating every record on the way in and out.
const COLLECTIONS = {
  accounts: "Account", goals: "Goal", envelopes: "Envelope", transactions: "Transaction", entries: "Entry",
  categories: "Category", categoryMaps: "CategoryMap", rules: "Rule", templates: "Template", presets: "Preset",
  payeeRules: "PayeeRule", subscriptions: "Subscription", checkIns: "CheckIn", attachments: "Attachment",
  tags: "Tag", foreignAmounts: "ForeignAmount", surveyResponses: "SurveyResponse", payslips: "Payslip", payslipLines: "PayslipLine",
};

// Every record in every collection must be well-formed; unknown collections are refused.
export function validateState(state) {
  if (typeof state !== "object" || state === null) return [{ code: "SHAPE", severity: "error", message: "state must be an object" }];
  const out = [];
  for (const [key, rows] of Object.entries(state)) {
    const entity = COLLECTIONS[key];
    if (!entity) { out.push({ code: "SHAPE", severity: "error", message: "unknown collection " + key }); continue; }
    if (!Array.isArray(rows)) { out.push({ code: "SHAPE", severity: "error", message: key + " must be an array" }); continue; }
    rows.forEach((r, i) => validateShape(entity, r).forEach((v) => out.push({ ...v, message: key + "[" + i + "] " + v.message })));
  }
  return out;
}
