// PearlRate economics: the Worker's copy of index.html's calc() and its
// benchmark table.
//
// index.html is a single static file with no modules or build step, so it
// keeps its own copy. tests/e2e/specs/calc-parity.spec.js (run in CI) loads
// the page in a browser, evaluates its window.PearlRate.econ over a grid of
// inputs and compares every figure (and the card table) with this module.
// Change both together; the test fails if they drift.

// Network difficulty at ×1.00 (17 Jun 2026); the yields below are stated there.
export const BASELINE_DIFFICULTY = 18098085;

// Yields (PRL/day at ×1.00) and power draw (W) — same as DEFAULT_CARDS in index.html.
export const CARDS = [
  { id: "5090", name: "RTX 5090", arch: "Blackwell", yield: 4.58, power: 510, est: false },
  { id: "4090", name: "RTX 4090", arch: "Ada", yield: 3.32, power: 430, est: true },
  { id: "5080", name: "RTX 5080", arch: "Blackwell", yield: 2.73, power: 358, est: false },
  { id: "5070ti", name: "RTX 5070 Ti", arch: "Blackwell", yield: 2.28, power: 285, est: true },
  { id: "3090", name: "RTX 3090", arch: "Ampere", yield: 1.62, power: 320, est: false },
  { id: "5070", name: "RTX 5070", arch: "Blackwell", yield: 1.56, power: 235, est: true },
  { id: "4060ti", name: "RTX 4060 Ti", arch: "Ada", yield: 0.88, power: 155, est: true },
  { id: "3060", name: "RTX 3060", arch: "Ampere", yield: 0.55, power: 160, est: true },
];

export const cardById = (id) => CARDS.find((c) => c.id === String(id));

// One card at PRL price P (USDT) and difficulty multiplier D:
//   eff       PRL/day at that difficulty
//   grossDay  $/day before costs;  grossH = grossDay / 24
//   be        break-even rent $/h (what a renter mining PRL can pay, after pool fee)
//   net       self-mine net $/day (after pool fee and electricity)
//   bePrice   PRL price at which net = 0
export function econ(baseYield, power, P, D, feePct, elec) {
  D = Math.max(0.01, D);
  const F = Math.min(1, Math.max(0, feePct / 100));
  const eff = baseYield / D;
  const grossDay = eff * P;
  const grossH = grossDay / 24;
  const be = grossH * (1 - F);
  const elecDay = (power / 1000) * 24 * elec;
  const net = grossDay * (1 - F) - elecDay;
  const bePrice = eff > 0 && F < 1 ? elecDay / (eff * (1 - F)) : Infinity;
  return { eff, grossDay, grossH, be, net, bePrice };
}

// A whole fleet: items [{yield, power, qty}] summed the way the dashboard's
// "Fleet total" row sums them.
export function fleetEcon(items, P, D, feePct, elec) {
  const t = { gpus: 0, grossDay: 0, be: 0, net: 0 };
  for (const it of items) {
    const r = econ(it.yield, it.power, P, D, feePct, elec);
    t.gpus += it.qty;
    t.grossDay += r.grossDay * it.qty;
    t.be += r.be * it.qty;
    t.net += r.net * it.qty;
  }
  return t;
}
