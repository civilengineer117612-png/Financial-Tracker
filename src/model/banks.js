// The accounts picker (owner's request): choose a bank instead of typing its name, and optionally which part of the
// bank an account is (for example an Emergency Fund kept inside GoTyme). Only names live here: no logos are shipped in
// this public repository. A picture is chosen once on the phone and is shared by every account of the same bank.
// Commonly used banks and e-wallets in the Philippines, including the owner's own; edit this list to change it.
import { validateShape } from "./schema.js";

// `domain` is the bank's public website (`alt` lists other sites to try if the first has no icon). `noLookup` marks a bank
// the icon services only answer with a grey placeholder for, so they are skipped; `wiki` is a search phrase for the bank's
// Wikipedia article, whose picture is its logo (Wikipedia's pictures can be copied by the page). It is used only when the owner taps "Get bank logos" on the phone, which asks
// an icon service for that site's small icon and keeps it on the phone. Nothing is downloaded or stored in the repository.
export const BANKS = [
  { id: "gcash", name: "GCash", domain: "gcash.com" }, { id: "maya", name: "Maya", domain: "maya.ph", noLookup: true, wiki: ["Maya Philippines fintech", "Maya Bank Philippines", "PayMaya"] },
  { id: "gotyme", name: "GoTyme", domain: "gotyme.com.ph" }, { id: "maribank", name: "MariBank", domain: "maribank.ph" },
  { id: "bdo", name: "BDO", domain: "bdo.com.ph" }, { id: "bpi", name: "BPI", domain: "bpi.com.ph" },
  { id: "metrobank", name: "Metrobank", domain: "metrobank.com.ph" }, { id: "unionbank", name: "UnionBank", domain: "unionbankph.com", alt: ["unionbank.com.ph"] },
  { id: "landbank", name: "Landbank", domain: "landbank.com" }, { id: "securitybank", name: "Security Bank", domain: "securitybank.com", noLookup: true, wiki: ["Security Bank Corporation", "Security Bank Philippines"] },
  { id: "coinsph", name: "Coins.ph", domain: "coins.ph" },
  { id: "beep", name: "Beep", domain: "beep.com.ph" },   // the stored-value transport card
];
export const CASH = { id: "cash", name: "Cash" };
export const bankById = (id) => [...BANKS, CASH].find((b) => b.id === id) ?? null;

// The bank a typed account name obviously means ("gotyme", "GoTyme Savings"), or null. Used to offer logos for accounts
// made before the bank picker existed.
export const bankForName = (name) => BANKS.find((b) => { const n = name.trim().toLowerCase(), k = b.name.toLowerCase(); return n === k || n.startsWith(k + " "); }) ?? null;

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
    name = sub ? bank.name + " · " + sub : input.kind === "liability" ? bank.name + " · Credit card" : bank.name;   // a bank can hold a savings account and a credit card side by side
  } else {
    name = (input.name ?? "").trim();
    if (!name) return fail("BAD_NAME", "Give the account a name.");
  }
  if (state.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) return fail("DUPLICATE_NAME", bank ? "You already have \u201C" + name + "\u201D. To add another account at " + bank.name + ", say which part it is (for example Savings or Payroll)." : "You already have an account with that name.");
  const sibling = bank ? state.accounts.find((a) => a.bank === bank.id && (a.icon || a.icon_url)) : null;
  const account = {
    id: input.id, name, class: input.kind, role: "", hidden_by_default: false, archived: false,
    opening_balance: input.opening ?? 0, opening_date: input.date,
    ...(bank ? { bank: bank.id } : {}), ...(sibling?.icon ? { icon: sibling.icon } : sibling?.icon_url ? { icon_url: sibling.icon_url } : {}),
    ...(input.kind === "asset" && input.covers ? { reserve_for: input.covers } : {}),
  };
  const problems = validateShape("Account", account);
  if (problems.length) return { ok: false, violations: problems };
  return { ok: true, violations: [], account, state: { ...state, accounts: [...state.accounts, account] } };
}

// Link an account made earlier (with a typed name) to a bank, or unlink it (bankId null). A newly linked account that
// has no picture starts with the picture its bank already has on another account.
export function linkAccountBank(state, accountId, bankId) {
  const a = state.accounts.find((x) => x.id === accountId);
  if (!a) return fail("UNKNOWN_ACCOUNT", "no account " + accountId);
  if (bankId != null && !bankById(bankId)) return fail("UNKNOWN_BANK", "that bank is not in the list");
  const { bank, ...rest } = a;
  let kept = rest;
  if ((a.bank ?? null) !== (bankId ?? null)) {
    // Changing bank drops the picture the account was sharing with its old bank (an address always; a copied picture when
    // another account of that bank has the same one), so a wrong link can be undone without carrying the wrong logo along.
    const { icon_url, ...noUrl } = rest;
    const shared = a.icon && a.bank && state.accounts.some((x) => x.id !== accountId && x.bank === a.bank && x.icon === a.icon);
    kept = noUrl;
    if (shared) { const { icon, ...noIcon } = noUrl; kept = noIcon; }
  }
  const sibling = bankId ? state.accounts.find((x) => x.id !== accountId && x.bank === bankId && (x.icon || x.icon_url)) : null;
  const next = { ...kept, ...(bankId ? { bank: bankId } : {}), ...(!kept.icon && !kept.icon_url && sibling ? (sibling.icon ? { icon: sibling.icon } : { icon_url: sibling.icon_url }) : {}) };
  const problems = validateShape("Account", next);
  if (problems.length) return { ok: false, violations: problems };
  return { ok: true, violations: [], state: { ...state, accounts: state.accounts.map((x) => (x.id === accountId ? next : x)) } };
}

// When a bank's picture cannot be copied onto the phone (the icon service does not allow it) the app can instead show
// it from the service's address. Only allow-listed icon services are accepted (see the Account schema), and only
// accounts of that bank with no picture of their own are changed.
export function setBankIconUrl(state, bankId, url) {
  if (!bankById(bankId)) return fail("UNKNOWN_BANK", "that bank is not in the list");
  let changed = false;
  const accounts = state.accounts.map((a) => {
    if (a.bank !== bankId || a.icon) return a;
    const { icon_url, ...rest } = a;
    changed = true;
    return url == null ? rest : { ...rest, icon_url: url };
  });
  const problems = accounts.flatMap((a) => validateShape("Account", a));
  if (problems.length) return fail("BAD_ICON_URL", "that icon address cannot be used");
  return { ok: true, violations: [], changed, state: { ...state, accounts } };
}

// The picture a bank already has on one of the owner's accounts: one linked to the bank, or one whose name plainly is the
// bank (an account typed before the picker existed). Used for the bank tiles in Setup. {icon, icon_url} or null.
export function bankPicture(accounts, bankId) {
  const a = accounts.find((x) => (x.bank === bankId || (!x.bank && bankForName(x.name)?.id === bankId)) && (x.icon || x.icon_url));
  return a ? { ...(a.icon ? { icon: a.icon } : {}), ...(a.icon_url ? { icon_url: a.icon_url } : {}) } : null;
}

// Addresses saved by earlier versions from services that answer a missing icon with a grey placeholder picture.
export const isPlaceholderAddress = (url) => /fallback_opts|www\.google\.com\/s2\/favicons/.test(url ?? "");

// Throws those addresses away, so the account shows its letter tile until a real logo or a screenshot is added.
export function dropPlaceholderAddresses(state) {
  if (!state.accounts.some((a) => isPlaceholderAddress(a.icon_url))) return state;
  return { ...state, accounts: state.accounts.map((a) => { if (!isPlaceholderAddress(a.icon_url)) return a; const { icon_url, ...rest } = a; return rest; }) };
}
