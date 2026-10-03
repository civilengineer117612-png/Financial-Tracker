// Spec 2.5: effective-dated, append-only rules. Rows are never edited, so "the rule"
// for a subject on a date is found by looking back through its history:
//   take rows of that kind and subject with effective_from <= date,
//   the latest effective_from wins,
//   on the same effective_from, the latest created_at wins (that is how a mistaken
//   row is corrected without editing it: append a new row with the same date).
// Dates are YYYY-MM-DD and timestamps share one +08:00 format, so plain string
// comparison orders them correctly.

const newer = (a, b) =>
  a.effective_from !== b.effective_from ? a.effective_from > b.effective_from : a.created_at > b.created_at;

export function ruleInEffect(rules, kind, subjectId, date) {
  let best = null;
  for (const r of rules) {
    if (r.kind !== kind || r.subject_id !== subjectId || r.effective_from > date) continue;
    if (!best || !newer(best, r)) best = r;   // on a full tie the row added LATER wins (rows are only ever appended)
  }
  return best;
}

// The whole table for one kind as of a date, e.g. "the budget on Nov 1":
// Map of subject_id -> rule row in effect.
export function rulesInEffect(rules, kind, date) {
  const out = new Map();
  for (const r of rules) {
    if (r.kind !== kind || r.effective_from > date) continue;
    const cur = out.get(r.subject_id);
    if (!cur || !newer(cur, r)) out.set(r.subject_id, r);
  }
  return out;
}

// Spec 2.5: transactions keep their original category; merges exist only in reports.
// A map row {from, to, effective_from} redirects `from` into `to` for reports run on
// or after effective_from. Chains (A->B, B->C) are followed to the end.
export function reportingCategory(maps, categoryId, asOf) {
  const active = new Map();
  for (const m of maps) {
    if (m.effective_from > asOf) continue;
    const cur = active.get(m.from);
    if (!cur || m.effective_from > cur.effective_from) active.set(m.from, m);
  }
  let id = categoryId;
  const seen = new Set([id]);
  while (active.has(id)) {
    id = active.get(id).to;
    if (seen.has(id)) throw new Error("category map cycle at " + id);   // blocked at save, see below
    seen.add(id);
  }
  return id;
}

// Save-time check for a new map row: it must not create a loop (A->B then B->A),
// which would make reports undefined. Checked on every date a row takes effect.
export function checkCategoryMapSave(maps, newMap) {
  const all = [...maps, newMap];
  if (newMap.from === newMap.to) return [{ code: "MAP_SELF", severity: "error", message: "a category cannot map to itself" }];
  for (const date of new Set(all.map((m) => m.effective_from))) {
    try {
      for (const m of all) reportingCategory(all, m.from, date);
    } catch (e) {
      return [{ code: "MAP_CYCLE", severity: "error", message: e.message + " from " + date }];
    }
  }
  return [];
}
