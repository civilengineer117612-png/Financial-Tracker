// The Pay plan typed in by hand. The form is turned into the same plan text a plan file holds and then read by `parsePlan`, so one set of rules
// (the day ranges, each payday's lines adding up to its pay, names not repeated) judges a typed plan and a loaded file alike.
import { parsePesos } from "./money.js";

export const MAX_FORM_LINES = 40;
const blankLine = (f, i) => !(f["n" + i] ?? "").trim() && !(f["a" + i] ?? "").trim() && !(f["b" + i] ?? "").trim();
const KINDS = { expense: "Spending", goal: "Goal", buffer: "Buffer" };
export const KIND_NAMES = KINDS;

export const newPlanForm = (today) => ({ start: today, twice: true, d1: "15", p1: "", d2: "last", p2: "", count: 4, n0: "", k0: "expense", a0: "", b0: "", n1: "", k1: "expense", a1: "", b1: "", n2: "", k2: "expense", a2: "", b2: "", n3: "", k3: "expense", a3: "", b3: "" });

// Pesos typed in a box ("1,250.50") to centavos; empty means zero; anything else is NaN.
const peso = (s) => { const t = String(s ?? "").trim(); if (!t) return 0; const r = parsePesos(t); return r.ok ? r.centavos : NaN; };

// {ok, text} for the plan text, or {ok: false, error} when a box cannot be read. Whether the plan is acceptable is parsePlan's call.
export function planTextFromForm(f) {
  const income = [peso(f.p1), f.twice ? peso(f.p2) : 0];
  if (income.some(Number.isNaN)) return { ok: false, error: "A pay amount is not a number. Type it like 25000 or 25000.50." };
  const paydays = [{ label: "1st payday", day: Number(f.d1), expected_income: income[0] }];
  if (f.twice) paydays.push({ label: "2nd payday", day: String(f.d2).trim().toLowerCase() === "last" ? "last" : Number(f.d2), expected_income: income[1] });
  const lines = [];
  for (let i = 0; i < (f.count ?? 0); i++) {
    if (blankLine(f, i)) continue;
    const a = peso(f["a" + i]), b = f.twice ? peso(f["b" + i]) : 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return { ok: false, error: "The amount on line " + (i + 1) + " is not a number." };
    lines.push({ name: (f["n" + i] ?? "").trim(), kind: f["k" + i] ?? "expense", first: a, second: b });
  }
  return { ok: true, text: JSON.stringify({ schema_version: 1, unit: "PHP_centavos", effective_from: f.start, paydays, lines }) };
}

// Live help while typing: for each payday, the pay, what the lines place, and what is left to place (negative: placed too much).
export function planFormStatus(f) {
  const rows = [];
  for (let p = 0; p < (f.twice ? 2 : 1); p++) {
    const pay = peso(f[p ? "p2" : "p1"]); let placed = 0;
    for (let i = 0; i < (f.count ?? 0); i++) { if (blankLine(f, i)) continue; const v = peso(f[(p ? "b" : "a") + i]); placed += Number.isNaN(v) ? 0 : v; }
    rows.push({ pay: Number.isNaN(pay) ? 0 : pay, placed, left: (Number.isNaN(pay) ? 0 : pay) - placed });
  }
  return rows;
}
