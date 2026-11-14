// Custom GPUs: add, use everywhere a built-in card is used, edit, remove, persist.
const { test, expect, openApp, savedState, FLEET_STATE } = require('../fixtures');
const { contrastViolations } = require('../audit');

async function addGpu(page, name, power, yld) {
  await page.click('#addGpuBtn');
  await expect(page.locator('#gpuForm')).toBeVisible();
  await expect(page.locator('#gfName')).toBeFocused();
  await page.fill('#gfName', name);
  await page.fill('#gfPower', String(power));
  await page.fill('#gfYield', String(yld));
  await page.click('#gfSave');
  await expect(page.locator('#gpuForm')).toBeHidden();
}

test('a custom GPU joins the table, fleet totals, summary and every analysis view', async ({ page }) => {
  await openApp(page);
  await addGpu(page, 'Lab A6000', 300, 1.2);
  const row = page.locator('#rows tr.custom');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.chip-custom')).toHaveText('Custom');
  await expect(row.locator('.arch')).toContainText('Custom · 300W');
  await expect(row.locator('.yv')).toHaveText('1.02');          // 1.2 PRL/day ÷ ×1.18
  await expect(row.locator('td.c-net')).toHaveText('$0.18');
  await expect(row.locator('.gedit')).toBeFocused();            // focus returns to the new row

  await row.locator('.qbtn[data-step="1"]').click();
  await row.locator('.qbtn[data-step="1"]').click();
  await expect(page.locator('#fGpus')).toHaveText('2');
  await expect(page.locator('#fNet')).toHaveText('$0.36');
  await expect(page.locator('#sumTitle')).toHaveText('Your fleet · 2 GPUs');
  await expect(page.locator('#sumNet')).toHaveText('$0.36');

  await expect(page.locator('#subject option', { hasText: '1× Lab A6000 (custom)' })).toHaveCount(1);
  await expect(page.locator('#anSub')).toContainText('your fleet');
  await expect(page.locator('#roiCosts .costrow')).toContainText('2× Lab A6000');
  await expect(page.locator('#costHint')).toContainText('custom GPUs');
  await page.click('#tab-eff');
  await expect(page.locator('#effSvg circle.bub')).toHaveCount(9);
  await expect(page.locator('#effLegend')).toContainText('Custom');
  await expect(page.locator('#effRank .rrow')).toHaveCount(9);
  await expect(page.locator('#beNote')).toContainText('each card in your fleet');

  // persists like everything else
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('#rows tr.custom .nmt')).toHaveText('Lab A6000');
  await expect(page.locator('#rows tr.custom .qty')).toHaveValue('2');
  const st = await savedState(page);
  expect(st.custom).toEqual([{ id: 'c1', name: 'Lab A6000', power: 300, yield: 1.2 }]);
});

test('edit and remove a custom GPU; inline yield edit changes its definition', async ({ page }) => {
  await openApp(page);
  await addGpu(page, 'Rig one', 250, 1);
  await addGpu(page, 'Rig two', 400, 2);
  await expect(page.locator('#rows tr.custom')).toHaveCount(2);
  const one = page.locator('#rows tr[data-id="c1"]');

  await one.locator('.yieldcell').click();
  await one.locator('.yieldedit').fill('1.5');
  await page.keyboard.press('Enter');
  await expect(one.locator('.yv')).toHaveText((1.5 / 1.18).toFixed(2));
  await one.locator('.yieldcell').click();
  await one.locator('.yieldedit').fill('');                     // no default to fall back to: unchanged
  await page.keyboard.press('Enter');
  await expect(one.locator('.yv')).toHaveText((1.5 / 1.18).toFixed(2));

  await one.locator('.gedit').click();
  await expect(page.locator('#gpuFormTitle')).toHaveText('Edit Rig one');
  await expect(page.locator('#gfYield')).toHaveValue('1.5');
  await page.fill('#gfName', 'Rig one (tuned)');
  await page.fill('#gfPower', '220');
  await page.click('#gfSave');
  await expect(one.locator('.nmt')).toHaveText('Rig one (tuned)');
  await expect(one.locator('.arch')).toContainText('Custom · 220W');

  await one.locator('.qty').fill('3');
  await page.selectOption('#subject', 'c1');
  await one.locator('.gedit').click();
  await page.click('#gfRemove');
  await expect(page.locator('#rows tr[data-id="c1"]')).toHaveCount(0);
  await expect(page.locator('#fGpus')).toHaveText('0');
  await expect(page.locator('#subject')).toHaveValue('fleet');
  await expect(page.locator('#addGpuBtn')).toBeFocused();
  await page.waitForTimeout(400);
  const st = await savedState(page);
  expect(st.custom.map((g) => g.id)).toEqual(['c2']);
  expect(st.qty.c1).toBeUndefined();
});

test('form validation, Escape to cancel', async ({ page }) => {
  await openApp(page);
  await page.click('#addGpuBtn');
  await page.click('#gfSave');
  await expect(page.locator('#gfErr')).toHaveText('Give the GPU a name.');
  await expect(page.locator('#gfName')).toHaveAttribute('aria-invalid', 'true');
  await page.fill('#gfName', 'X');
  await page.fill('#gfPower', '0');
  await page.click('#gfSave');
  await expect(page.locator('#gfErr')).toHaveText('Power must be between 1 and 10,000 W.');
  await page.fill('#gfPower', '200');
  await page.fill('#gfYield', '-1');
  await page.click('#gfSave');
  await expect(page.locator('#gfErr')).toContainText('Yield must be');
  await page.keyboard.press('Escape');
  await expect(page.locator('#gpuForm')).toBeHidden();
  await expect(page.locator('#addGpuBtn')).toBeFocused();
  await expect(page.locator('#rows tr.custom')).toHaveCount(0);
});

test('a hostile GPU name is shown as text, never run as markup', async ({ page }) => {
  await openApp(page);
  const evil = '<img src=x onerror="window.__pwned=1">';
  await addGpu(page, evil, 300, 1.2);
  await page.locator('#rows tr.custom .qty').fill('1');
  await expect(page.locator('#rows tr.custom .nmt')).toHaveText(evil);
  expect(await page.locator('#rows img, #effSvg image, #effRank img').count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test.describe('reset', () => {
  test.use({ seedState: { ...FLEET_STATE, qty: { ...FLEET_STATE.qty, c1: 2 }, custom: [{ id: 'c1', name: 'Keep me', power: 300, yield: 1 }] } });

  test('Reset defaults keeps custom GPU definitions but clears their quantity', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#fGpus')).toHaveText('14');
    await page.click('#resetBtn');
    await expect(page.locator('#fGpus')).toHaveText('0');
    await expect(page.locator('#rows tr[data-id="c1"] .nmt')).toHaveText('Keep me');
  });
});

for (const scheme of ['dark', 'light']) {
  test(`custom rows and the open form meet AA contrast (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    await addGpu(page, 'Contrast rig', 300, 1.2);
    await page.click('#rows tr.custom .gedit');
    await page.click('#gfSave'); // name kept: closes again
    await page.click('#addGpuBtn');
    await page.click('#gfSave'); // shows the error line
    await expect(page.locator('#gfErr')).toBeVisible();
    expect(await contrastViolations(page)).toEqual([]);
  });
}
