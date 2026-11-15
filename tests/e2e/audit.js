// In-page audits shared by several specs.

// WCAG 2.x AA text-contrast audit of every visible text node (HTML and SVG).
// Background = the stack of ancestor background colours composited down to the
// first opaque one; linear-gradient backgrounds (e.g. the sponsor button, the
// active-chip tint) are checked against every colour stop, worst case wins.
// Text painted with a gradient (background-clip:text) has a transparent fill
// and is skipped. Returns [{ratio, need, px, sel, txt}] of failures.
async function contrastViolations(page) {
  return page.evaluate(() => {
    const parse = (c) => {
      const m = c && c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
    const lum = (c) => {
      const t = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * t(c.r) + 0.7152 * t(c.g) + 0.0722 * t(c.b);
    };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const stops = (img) => (img && /linear-gradient/.test(img) ? (img.match(/rgba?\([^)]+\)/g) || []).map(parse) : []);
    // Possible background colours behind an element (several when a gradient is involved).
    const bgsOf = (el) => {
      const layers = [];
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        const st = stops(cs.backgroundImage);
        const c = parse(cs.backgroundColor);
        if (st.length) layers.push(st);
        if (c && c.a > 0) { layers.push([c]); if (c.a >= 1) break; }
      }
      let out = [{ r: 255, g: 255, b: 255, a: 1 }];
      for (let i = layers.length - 1; i >= 0; i--) {
        const next = [];
        layers[i].forEach((c) => out.forEach((b) => next.push(c.a >= 1 ? c : over(c, b))));
        out = next;
      }
      return out;
    };
    const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
    const failures = [];
    const els = [...document.querySelectorAll('body *')].filter((e) => {
      if (!['text', 'tspan'].includes(e.tagName) && ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(e);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
    });
    for (const e of els) {
      const cs = getComputedStyle(e);
      const isSvg = e instanceof SVGElement;
      let fg = parse(isSvg ? cs.fill : cs.color);
      if (!fg || fg.a === 0) continue;
      const tf = parse(cs.webkitTextFillColor);
      if (tf && tf.a === 0) continue;
      const px = parseFloat(cs.fontSize) * zoom, bold = parseInt(cs.fontWeight, 10) >= 700;
      const need = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5;
      let worst = Infinity;
      for (const bg of bgsOf(isSvg ? e.ownerSVGElement.parentElement : e)) {
        const f = fg.a < 1 ? over(fg, bg) : fg;
        worst = Math.min(worst, ratio(f, bg));
      }
      if (worst < need) {
        const cls = typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || '';
        failures.push({
          ratio: +worst.toFixed(2), need, px: +px.toFixed(1),
          sel: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (cls ? '.' + cls.trim().split(/\s+/).join('.') : ''),
          txt: e.textContent.trim().slice(0, 40),
        });
      }
    }
    return failures;
  });
}

// Elements that stick out past the right edge of the viewport (sideways scroll).
async function overflowingElements(page) {
  return page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > window.innerWidth + 1 && !e.closest('.tscroll svg');
    })
    .map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''))
    .slice(0, 8));
}

// Rendered size (CSS px, including the page's zoom) of every visible match.
async function targetSizes(page, selector) {
  return page.$$eval(selector, (els) => els
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), what: (e.getAttribute('aria-label') || e.textContent || e.id || e.className).trim().slice(0, 30) }; }));
}

module.exports = { contrastViolations, overflowingElements, targetSizes };
