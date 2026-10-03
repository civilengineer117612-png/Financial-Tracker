// Spec 6.2: the savings ratchet. Savings move out on payday, before spending; each
// month's outcome sets next month's amount:
//   met            -> raise by `step`
//   missed once    -> hold
//   missed twice in a row -> lower by `step`, never below `floor`, and the miss
//                    count restarts (so a long miss streak lowers every 2nd month)
//
// No peso figures live in this file. Start, step, floor and the split are passed
// in, because they are policy stored as dated rule rows, not code.

export function validateRatchetParams(p) {
  const out = [];
  for (const k of ["start", "step", "floor"]) {
    if (!Number.isSafeInteger(p[k]) || p[k] < 0) out.push(k + " must be whole centavos >= 0");
  }
  if (out.length === 0 && p.start < p.floor) out.push("start must not be below floor");
  return out;
}

// A month counts as met when at least the ratchet amount actually moved to savings.
export const wasMet = (amount, moved) => moved >= amount;

// One step: (this month's amount, consecutive misses so far, did we meet it?)
// -> next month's amount and miss count.
export function nextRatchet({ amount, misses }, met, { step, floor }) {
  if (met) return { amount: amount + step, misses: 0 };
  if (misses + 1 < 2) return { amount, misses: misses + 1 };
  return { amount: Math.max(floor, amount - step), misses: 0 };
}

// Whole history: outcomes is [true, false, ...] per month, oldest first.
// Returns the amount for each month, plus one more for the coming month.
export function ratchetSchedule(params, outcomes) {
  const errors = validateRatchetParams(params);
  if (errors.length) throw new Error(errors.join("; "));
  let state = { amount: params.start, misses: 0 };
  const amounts = [state.amount];
  for (const met of outcomes) {
    state = nextRatchet(state, met, params);
    amounts.push(state.amount);
  }
  return amounts;
}

// Split one month's ratchet amount between the Emergency and Sinking funds.
// emergencyShare is a fraction {num, den} (2/3 in the spec). Fractions of a centavo
// cannot be stored, so Emergency is rounded and Sinking takes the exact remainder:
// the two parts always add back to the amount.
// Once the Emergency Fund has reached its target, its share goes to long-term savings.
export function splitRatchet(amount, { num, den }, emergencyReached = false) {
  const emergencyPart = Math.round((amount * num) / den);
  const sinking = amount - emergencyPart;
  return emergencyReached
    ? { emergency: 0, sinking, longTerm: emergencyPart }
    : { emergency: emergencyPart, sinking, longTerm: 0 };
}
