// Pesos as people type and read them, centavos as the ledger stores them (spec 7.1).

// "95" -> 9500, "1,250.5" -> 125050, "₱20.00" -> 2000. At most two decimals; never rounds.
export function parsePesos(input) {
  const s = String(input ?? "").trim().replace(/^₱/, "").replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, error: "enter an amount like 95 or 95.50" };
  const centavos = Number(m[1]) * 100 + Number(((m[2] ?? "") + "00").slice(0, 2));
  return Number.isSafeInteger(centavos) ? { ok: true, centavos } : { ok: false, error: "amount is too large" };
}

// 125050 -> "₱1,250.50"; negative amounts keep their sign in front.
export function formatPesos(centavos) {
  const abs = Math.abs(centavos);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+$)/g, ",");
  return (centavos < 0 ? "-" : "") + "₱" + whole + "." + String(abs % 100).padStart(2, "0");
}
