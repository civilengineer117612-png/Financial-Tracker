// The accounts picker (owner's request): choose a bank instead of typing its name, and optionally which part of the
// bank an account is (for example an Emergency Fund kept inside GoTyme). Only names live here: no logos are shipped in
// this public repository. A picture is chosen once on the phone and is shared by every account of the same bank.
// Ten commonly used banks and e-wallets in the Philippines, including the owner's own; edit this list to change it.
import { validateShape } from "./schema.js";

export const BANKS = [
  { id: "gcash", name: "GCash" }, { id: "maya", name: "Maya" }, { id: "gotyme", name: "GoTyme" }, { id: "maribank", name: "MariBank" },
  { id: "bdo", name: "BDO" }, { id: "bpi", name: "BPI" }, { id: "metrobank", name: "Metrobank" }, { id: "unionbank", name: "UnionBank" },
  { id: "landbank", name: "Landbank" }, { id: "securitybank", name: "Security Bank" },
];
export const CASH = { id: "cash", name: "Cash" };
export const bankById = (id) => [...BANKS, CASH].find((b) => b.id === id) ?? null;

const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });

// input: {id, bank?, sub?, name?, kind: "asset"|"liability", opening (centavos), date, covers?}
// With a bank the name is made for you ("GoTyme" or "GoTyme · Emergency Fund"); without one the typed name is used.
export function planAccount(state, input) {
  let name, bank;
  if (input.bank) {
    bank = bankById(input.bank);
    if (!bank) return fail("UNKNOWN_BANK", "that bank is not in the list");
    const sub = (input.sub ?? "").trim();
    if (sub.length > 40) return fail("BAD_NAME", "keep the part of the bank to 40 characters or less");
    name = sub ? bank.name + " · " + sub : bank.name;
  } else {
    name = (input.name ?? "").trim();
    if (!name) return fail("BAD_NAME", "Give the account a name.");
  }
  if (state.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) return fail("DUPLICATE_NAME", "You already have an account with that name.");
  const sibling = bank ? state.accounts.find((a) => a.bank === bank.id && a.icon) : null;
  const account = {
    id: input.id, name, class: input.kind, role: "", hidden_by_default: false, archived: false,
    opening_balance: input.opening ?? 0, opening_date: input.date,
    ...(bank ? { bank: bank.id } : {}), ...(sibling ? { icon: sibling.icon } : {}),
    ...(input.kind === "asset" && input.covers ? { reserve_for: input.covers } : {}),
  };
  const problems = validateShape("Account", account);
  if (problems.length) return { ok: false, violations: problems };
  return { ok: true, violations: [], account, state: { ...state, accounts: [...state.accounts, account] } };
}
