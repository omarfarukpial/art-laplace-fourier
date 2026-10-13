/* Harmonic Bloom: the mathematics.
 *
 * Fourier: a closed curve is a sum of rotating circles
 *     γ(x) = Σ c_k e^{ikx},   x ∈ [0, 2π)
 *
 * Laplace: use γ as boundary data on a half-cylinder (x periodic, depth y ≥ 0).
 * The bounded solution of  u_xx + u_yy = 0  with  u(x, 0) = γ(x)  is
 *     u(x, y) = Σ c_k e^{-|k| y} e^{ikx}
 * Every harmonic fades at its own rate. With r = e^{-y} this is the Poisson
 * integral of γ on the unit disc, and as y → ∞ every point tends to c_0, the
 * mean of the boundary (the mean-value property of harmonic functions).
 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  function rng(seed) {
    let a = (seed * 2654435761) >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { const t = a % b; a = b; b = t; }
    return a;
  }

  // Plate I is Frank Farris's "mystery curve": e^{ix} + ½e^{6ix} + (i/3)e^{-14ix}.
  function farris() {
    return {
      seed: 0, m: 5, sigma: 1,
      terms: [
        { k: 1, amp: 1, phase: 0, omega: 0 },
        { k: 6, amp: 1 / 2, phase: 0, omega: 0.035 },
        { k: -14, amp: 1 / 3, phase: Math.PI / 2, omega: -0.05 },
        { k: -4, amp: 0.09, phase: 1.1, omega: 0.06 },
      ],
    };
  }

  // Every frequency in a form satisfies k ≡ σ (mod m), so γ(x + 2π/m) = e^{2πiσ/m} γ(x):
  // the curve has m-fold rotational symmetry whatever the amplitudes and phases are.
  function makeForm(seed) {
    if (seed === 0) return farris();
    const r = rng(seed);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const m = pick([3, 4, 5, 5, 6, 7, 7, 8, 9, 10, 11, 13]);
    const sigma = pick([1, 1, 1, 2, 3].filter((s) => s < m && gcd(s, m) === 1));
    const drift = () => (r() < 0.5 ? -1 : 1) * (0.015 + 0.07 * r());

    const terms = [{ k: sigma, amp: 1, phase: r() * TAU, omega: 0 }];
    const used = new Set([0]);
    const lead = r() < 0.6 ? -1 : 1;
    terms.push({ k: sigma + lead * m, amp: 0.3 + 0.45 * r(), phase: r() * TAU, omega: drift() });
    used.add(lead);

    const extra = 1 + Math.floor(r() * 4);
    for (let n = 0; n < extra; n++) {
      let j = 0;
      for (let tries = 0; tries < 12 && used.has(j); tries++) {
        j = (1 + Math.floor(r() * 5)) * (r() < 0.55 ? -1 : 1);
      }
      if (used.has(j)) continue;
      used.add(j);
      const amp = (0.07 + 0.38 * r()) / Math.pow(Math.abs(j), 0.55);
      terms.push({ k: sigma + j * m, amp, phase: r() * TAU, omega: drift() });
    }
    return { seed, m, sigma, terms };
  }

  // Blend form A into form B (weight w ∈ [0, 1]) at time t, as flat arrays the
  // shader and the epicycle machine both read. Coefficients sharing a frequency add.
  function liveTerms(A, B, w, t) {
    const map = new Map();
    const add = (form, weight) => {
      if (!form || weight <= 1e-4) return;
      for (const T of form.terms) {
        const ph = T.phase + T.omega * t;
        const re = weight * T.amp * Math.cos(ph);
        const im = weight * T.amp * Math.sin(ph);
        const e = map.get(T.k);
        if (e) { e.re += re; e.im += im; } else map.set(T.k, { k: T.k, re, im });
      }
    };
    add(A, 1 - w);
    add(B, w);
    const list = [...map.values()]
      .map((e) => ({ ...e, mag: Math.hypot(e.re, e.im) }))
      .filter((e) => e.mag > 1e-5)
      .sort((a, b) => b.mag - a.mag);
    return list;
  }

  // Largest |γ(x)| on the boundary, used to fit every form to the unit circle.
  function boundaryRadius(list) {
    let best = 0;
    for (let i = 0; i < 720; i++) {
      const p = evalAt(list, (i / 720) * TAU, 0);
      best = Math.max(best, Math.hypot(p[0], p[1]));
    }
    return best || 1;
  }

  // u(x, y) evaluated on the CPU (the GPU does the same sum for the whole field).
  function evalAt(list, x, y, scale = 1) {
    let X = 0, Y = 0;
    for (const e of list) {
      const a = e.k * x;
      const d = Math.exp(-Math.abs(e.k) * y);
      const c = Math.cos(a) * d, s = Math.sin(a) * d;
      X += e.re * c - e.im * s;
      Y += e.re * s + e.im * c;
    }
    return [X * scale, Y * scale];
  }

  function roman(n) {
    if (n <= 0) return 'N';
    const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
      [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let s = '';
    for (const [v, sym] of map) while (n >= v) { s += sym; n -= v; }
    return s;
  }

  global.Harmonic = { TAU, makeForm, liveTerms, boundaryRadius, evalAt, roman };
})(window);
