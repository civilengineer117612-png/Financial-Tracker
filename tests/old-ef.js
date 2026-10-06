// The Emergency Fund status as it was BEFORE it read category roles: written out as it was (it looked for plan lines by the words Rent, Food and Essentials),
// so the before/after tests can show the new code gives the same answer on the same data.
import { naturalBalance } from "../src/model/index.js";
const key = (s) => s.trim().toLowerCase();
const DEFAULT = { months: 3, basis: ["Rent", "Food", "Essentials"] };
export function oldEmergencyFundStatus(state, plan, goal) {
  if (!plan || !goal) return null;
  const { months, basis } = plan.emergency ?? DEFAULT;
  const found = basis.map((n) => plan.lines.find((l) => key(l.name) === key(n))).filter(Boolean);
  if (!found.length) return null;
  const monthlyBasis = found.reduce((n, l) => n + l.first + l.second, 0), target = months * monthlyBasis;
  const account = state.accounts.find((a) => a.id === goal.account_id);
  const balance = account ? naturalBalance(account, state.entries) : 0;
  const line = plan.lines.find((l) => l.kind === "goal" && key(l.name) === key(goal.name)) ?? plan.lines.find((l) => l.kind === "goal" && /emergency/i.test(l.name));
  const monthly = line ? line.first + line.second : 0, remaining = Math.max(0, target - balance);
  return { target, months, basis: found.map((l) => l.name), missing: basis.filter((n) => !plan.lines.some((l) => key(l.name) === key(n))), monthlyBasis,
    balance, remaining, percent: target ? Math.min(100, Math.floor((balance * 100) / target)) : 0, reached: balance >= target,
    monthly, monthsToTarget: remaining === 0 ? 0 : monthly > 0 ? Math.ceil(remaining / monthly) : null };
}
