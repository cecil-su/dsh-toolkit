// Test-only replacement for the historical exclusive receipt and audit rows.
export function mockLedger() {
  let used = false;
  const rows = [];
  return { rows, claim() { if (used) return false; used = true; return true; }, note(row) { rows.push(row); } };
}
