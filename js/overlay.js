/* Harmonic Bloom: the brass instrument layer (Canvas 2D).
 *
 * The epicycle machine draws the boundary curve γ: one circle per Fourier term,
 * largest first, each turning at its own frequency k. Under the pen a probe
 * follows the same boundary point down into the field, along the line of
 * constant x, where Laplace's equation pulls it toward the mean c_0.
 */
(function (global) {
  'use strict';

  const { TAU } = global.Harmonic;

  function project(m, x, y, z, W, H) {
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [(cx / cw * 0.5 + 0.5) * W, (0.5 - cy / cw * 0.5) * H];
  }

  function termAt(e, x, scale) {
    const c = Math.cos(e.k * x), s = Math.sin(e.k * x);
    return [scale * (e.re * c - e.im * s), scale * (e.re * s + e.im * c)];
  }

  function rgba(rgb, a) {
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
  }

  /* o = { list, scale, mvp, W, H, x, depth, ymax, gamma, trail, brass, machine } */
  function drawMachine(ctx, o) {
    const { list, scale, mvp, W, H, x, brass } = o;
    const P = (px, py, pz) => project(mvp, px, py, pz || 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Trail: the last stretch of the boundary the pen has drawn.
    const span = o.trail * TAU;
    const steps = Math.max(32, Math.round(o.trail * 900));
    let prev = null;
    ctx.lineWidth = 1.25;
    for (let i = 0; i <= steps; i++) {
      const t = x - span + (span * i) / steps;
      const p = global.Harmonic.evalAt(list, t, 0, scale);
      const q = P(p[0], p[1]);
      if (prev) {
        const a = Math.pow(i / steps, 1.6) * 0.95;
        ctx.strokeStyle = rgba(brass, a.toFixed(3));
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(q[0], q[1]);
        ctx.stroke();
      }
      prev = q;
    }

    // Probe: the boundary point under the pen, followed into the depth.
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(brass, 0.55);
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const y = o.ymax * Math.pow(i / 96, o.gamma);
      const p = global.Harmonic.evalAt(list, x, y, scale);
      const q = P(p[0], p[1], -o.depth * y);
      if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (!o.machine) return;

    // The machine: circles on circles, sized by |c_k|.
    let cx = 0, cy = 0;
    const drawn = Math.min(list.length, 24);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const d = termAt(e, x, scale);
      const nx = cx + d[0], ny = cy + d[1];
      if (i < drawn) {
        const r = e.mag * scale;
        const segs = Math.max(20, Math.min(96, Math.round(r * 160)));
        ctx.strokeStyle = rgba(brass, i === 0 ? 0.32 : 0.24);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let j = 0; j <= segs; j++) {
          const a = (j / segs) * TAU;
          const q = P(cx + r * Math.cos(a), cy + r * Math.sin(a));
          if (j === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
        }
        ctx.stroke();

        const a0 = P(cx, cy), a1 = P(nx, ny);
        ctx.strokeStyle = rgba(brass, 0.8);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a0[0], a0[1]);
        ctx.lineTo(a1[0], a1[1]);
        ctx.stroke();
        ctx.fillStyle = rgba(brass, 0.85);
        ctx.beginPath();
        ctx.arc(a0[0], a0[1], i === 0 ? 2 : 1.25, 0, TAU);
        ctx.fill();
      }
      cx = nx; cy = ny;
    }

    const pen = P(cx, cy);
    ctx.fillStyle = rgba(brass, 1);
    ctx.beginPath();
    ctx.arc(pen[0], pen[1], 2.6, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(brass, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pen[0], pen[1], 7, 0, TAU);
    ctx.stroke();
  }

  /* The spectrum: one stem per frequency k, height √|c_k|. */
  function drawSpectrum(ctx, W, H, list, colors) {
    ctx.clearRect(0, 0, W, H);
    if (!list.length) return;
    let kmax = 8, mmax = 0;
    for (const e of list) { kmax = Math.max(kmax, Math.abs(e.k)); mmax = Math.max(mmax, e.mag); }
    kmax = Math.ceil(kmax / 5) * 5;
    const base = H - 13, top = 4;
    const X = (k) => 4 + ((k + kmax) / (2 * kmax)) * (W - 8);

    ctx.strokeStyle = colors.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(4, base + 0.5); ctx.lineTo(W - 4, base + 0.5);
    for (let k = -kmax; k <= kmax; k += 5) {
      const px = Math.round(X(k)) + 0.5;
      ctx.moveTo(px, base); ctx.lineTo(px, base + (k === 0 ? 4 : 2.5));
    }
    ctx.stroke();

    ctx.fillStyle = colors.label;
    ctx.font = '9px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('0', X(0), H - 1);
    ctx.fillText('−' + kmax, X(-kmax) + 8, H - 1);
    ctx.fillText(String(kmax), X(kmax) - 6, H - 1);

    ctx.strokeStyle = colors.stem;
    ctx.fillStyle = colors.stem;
    ctx.lineWidth = 1.5;
    for (const e of list) {
      const px = Math.round(X(e.k)) + 0.5;
      const h = Math.sqrt(e.mag / mmax) * (base - top);
      ctx.beginPath();
      ctx.moveTo(px, base); ctx.lineTo(px, base - h);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, base - h, 1.6, 0, TAU);
      ctx.fill();
    }
  }

  global.HarmonicOverlay = { project, drawMachine, drawSpectrum };
})(window);
