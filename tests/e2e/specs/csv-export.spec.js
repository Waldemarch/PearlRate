// CSV export: dated filename, parameters block, per-GPU rows, fleet totals, escaping.
const fs = require('fs');
const { test, expect, openApp, FLEET_STATE } = require('../fixtures');

// RFC 4180 parser (quoted fields, doubled quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

test.use({
  seedState: {
    ...FLEET_STATE,
    qty: { ...FLEET_STATE.qty, c1: 2 },
    yields: { 4090: 3.5 },
    rate: { 5090: 0.45 },
    custom: [{ id: 'c1', name: '=SUM(A1), "rig"', power: 300, yield: 1.2 }],
  },
});

test('exports parameters, every GPU and the fleet totals', async ({ page }) => {
  await openApp(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#csvBtn')]);
  expect(download.suggestedFilename()).toBe('pearlrate-2026-11-14.csv');
  const raw = fs.readFileSync(await download.path(), 'utf8');
  expect(raw.charCodeAt(0)).toBe(0xfeff);                       // BOM so Excel reads UTF-8
  expect(raw).toContain('\r\n');
  const rows = parseCsv(raw.slice(1));
  const param = Object.fromEntries(rows.filter((r) => r.length === 2).map((r) => [r[0], r[1]]));
  expect(param['Exported at']).toBe('2026-11-14T12:00:00.000Z');
  expect(param['PRL price (USDT)']).toBe('0.92');
  expect(param['PRL price mode']).toBe('live');
  expect(param['Network difficulty ×']).toBe('1.18');
  expect(param['Electricity $/kWh']).toBe('0.1');
  expect(param['Pool fee %']).toBe('4');
  expect(param['Scenario link']).toMatch(/#s=/);
  expect(param['Rental platform fee % (assumption)']).toBe('25');
  expect(param['Expected occupancy %']).toBe('60');
  expect(param['Idle draw W per GPU']).toBe('30');

  const hi = rows.findIndex((r) => r[0] === 'GPU');
  const header = rows[hi];
  const body = rows.slice(hi + 1).filter((r) => r.length === header.length);
  const col = (r, name) => r[header.indexOf(name)];
  expect(body.map((r) => r[0])).toEqual(['RTX 5090', 'RTX 4090', 'RTX 5080', 'RTX 5070 Ti', 'RTX 3090', 'RTX 5070', 'RTX 4060 Ti', 'RTX 3060', "'=SUM(A1), \"rig\"", 'Fleet total']);

  const r5090 = body[0];
  expect(col(r5090, 'Type')).toBe('verified');
  expect(col(r5090, 'Qty')).toBe('4');
  expect(Number(col(r5090, 'Self-mine net $/day'))).toBeCloseTo(2.204014, 6);
  expect(Number(col(r5090, 'Break-even rent $/h'))).toBeCloseTo(0.142834, 6);
  expect(col(r5090, 'Your rate $/h')).toBe('0.45');
  expect(Number(col(r5090, 'Rent only net $/day'))).toBeCloseTo(4.0968, 6);
  expect(Number(col(r5090, 'Rent + mine idle net $/day'))).toBeCloseTo(5.007206, 5);
  expect(col(r5090, 'Best now')).toBe('Rent + mine idle');
  expect(col(body[4], 'Best now')).toBe('not offered');
  expect(col(body[4], 'Your rate $/h')).toBe('');
  expect(col(body[1], 'Type')).toBe('override');
  expect(col(body[1], 'Yield PRL/day @ ×1.00')).toBe('3.5');
  expect(col(body[3], 'Type')).toBe('estimated');
  const custom = body[8];
  expect(col(custom, 'Type')).toBe('custom');
  expect(col(custom, 'Architecture')).toBe('Custom');
  expect(col(custom, 'Power W')).toBe('300');

  const total = body[9];
  expect(col(total, 'Qty')).toBe('14');
  const sumNet = body.slice(0, 9).reduce((t, r) => t + Number(col(r, 'Qty × self-mine net $/day')), 0);
  expect(Number(col(total, 'Self-mine net $/day'))).toBeCloseTo(sumNet, 5);
  // The export carries the same totals the table shows.
  const fNet = (await page.locator('#fNet').textContent()).replace('$', '');
  expect(Number(col(total, 'Self-mine net $/day')).toFixed(2)).toBe(fNet);
  expect(raw).toContain('"\'=SUM(A1), ""rig"""');                 // quoted, quotes doubled, formula-guarded
});
