/* Harmonic Bloom: state, camera, input and the frame loop. */
(function () {
  'use strict';

  const H = window.Harmonic;
  const O = window.HarmonicOverlay;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  const glCanvas = $('field');
  const ovCanvas = $('machine');
  const specCanvas = $('spectrum');
  const ov = ovCanvas.getContext('2d');
  const spec = specCanvas.getContext('2d');
  const renderer = window.HarmonicRenderer.createRenderer(glCanvas);
  if (!renderer) { $('nogl').hidden = false; return; }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.25 : 1;

  /* ---------- the field ---------- */
  const FIELD = {
    ymax: 3.0,          // deepest ring: r = e^{-3} ≈ 0.05 of the boundary
    gamma: 2.2,         // ring spacing: q ↦ y = ymax·q^γ crowds rings at the boundary
    depthWorld: 1.0,    // how far the funnel falls below the boundary, in world units
    rings: 220, ringSamples: 1600,
    threads: 320, threadSamples: 140,
    comp: 0.55, fade: 0.8,
  };
  const PLATE_SECONDS = 10, MORPH_SECONDS = 7, PEN_PERIOD = 26;

  // A bare hash picks the opening state, e.g. #plate-12 or #plate-12-elevation.
  const hash = location.hash.slice(1);
  const startPlate = Math.max(1, parseInt((hash.match(/plate-(\d+)/) || [])[1], 10) || 1);
  const elevation = /elevation/.test(hash), planOnly = /plan/.test(hash);
  const capture = /capture/.test(hash);
  const nextFrame = capture ? (f) => setTimeout(() => f(performance.now()), 16) : requestAnimationFrame;

  const seedFor = (p) => (p === 1 ? 0 : p * 7919 + 17);
  const EL_PLAN = Math.PI / 2, EL_ELEV = (35 * Math.PI) / 180;
  const S = {
    plate: startPlate, A: H.makeForm(seedFor(startPlate)), B: null, mixT: 0,
    t: 0, sinceMorph: 0, paused: false,
    machine: false, threads: true,
    az: 0, el: elevation ? EL_ELEV : EL_PLAN, elTarget: elevation ? EL_ELEV : EL_PLAN, zoom: 1, plan: !elevation,
    reveal: reduced || capture ? 1 : 0, wantSave: false,
    // The opening move: the plate appears flat, then tilts to show it is the top of a funnel.
    intro: false, elRate: 2.2,
  };

  function goTo(plate) {
    plate = Math.max(1, plate);
    if (S.B) { S.A = S.B; S.B = null; }
    const B = H.makeForm(seedFor(plate));
    const a0 = S.A.terms[0];
    if (B.terms[0].k === a0.k) B.terms[0].phase = a0.phase + a0.omega * S.t;
    S.B = B; S.mixT = 0; S.plate = plate; S.sinceMorph = 0;
    updateCaption(B);
    try { history.replaceState(null, '', '#plate-' + plate); } catch (e) { /* sandboxed */ }
  }
  window.addEventListener('hashchange', () => {
    const m = location.hash.match(/plate-(\d+)/);
    if (m && +m[1] !== S.plate) goTo(+m[1]);
  });

  /* ---------- palette from CSS tokens ---------- */
  let palette = null;
  function hex(v) {
    const s = v.trim().replace('#', '');
    const n = parseInt(s.length === 3 ? s.replace(/(.)/g, '$1$1') : s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function readPalette() {
    const cs = getComputedStyle(root);
    const g = (name) => hex(cs.getPropertyValue(name));
    const f = (rgb) => rgb.map((c) => Math.max(0.02, c / 255));
    const light = cs.getPropertyValue('--mode').trim() === 'light';
    palette = {
      light,
      gl: { bg: f(g('--ground')), rim: f(g('--field-rim')), deep: f(g('--field-deep')), thread: f(g('--field-thread')) },
      brass: g('--brass'),
      spectrum: { rule: cs.getPropertyValue('--rule').trim(), label: cs.getPropertyValue('--text-dim').trim(), stem: cs.getPropertyValue('--brass').trim() },
    };
  }
  readPalette();
  new MutationObserver(readPalette).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readPalette);

  /* ---------- sizing ---------- */
  let W = 0, Hh = 0, dpr = 1, glDpr = 1;
  function resize() {
    W = ovCanvas.clientWidth; Hh = ovCanvas.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    glDpr = dpr;
    const cap = 3.2e6;
    if (W * Hh * glDpr * glDpr > cap) glDpr = Math.sqrt(cap / (W * Hh));
    glCanvas.width = Math.round(W * glDpr); glCanvas.height = Math.round(Hh * glDpr);
    ovCanvas.width = Math.round(W * dpr); ovCanvas.height = Math.round(Hh * dpr);
    const sw = specCanvas.clientWidth, sh = specCanvas.clientHeight;
    specCanvas.width = Math.round(sw * dpr); specCanvas.height = Math.round(sh * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------- camera ---------- */
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  const translate = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); }
  function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function camera() {
    const fovy = (28 * Math.PI) / 180, aspect = W / Hh, th = Math.tan(fovy / 2);
    const dist = Math.max(1.2 / th, 1.12 / (th * aspect)) / S.zoom;
    const targetZ = -0.42 * FIELD.depthWorld * Math.cos(S.el);
    const view = mul(translate(0, 0, -dist), mul(rotX(S.el - Math.PI / 2), mul(rotZ(S.az), translate(0, 0, -targetZ))));
    return mul(perspective(fovy, aspect, 0.05, 50), view);
  }

  /* ---------- captions ---------- */
  function updateCaption(form) {
    $('plate-no').textContent = H.roman(S.plate);
    const ks = form.terms.map((t) => t.k).sort((a, b) => a - b);
    $('plate-meta').textContent =
      `${form.m}-fold · k ≡ ${form.sigma} (mod ${form.m}) · ${form.terms.length} harmonics`;
    $('plate-ks').textContent = 'k = ' + ks.map((k) => (k < 0 ? '−' + -k : k)).join(', ');
  }
  updateCaption(S.A);

  /* ---------- controls ---------- */
  function setPressed(id, on) { $(id).setAttribute('aria-pressed', on ? 'true' : 'false'); }
  const actions = {
    next: () => goTo(S.plate + 1),
    prev: () => goTo(S.plate - 1),
    pause: () => { S.paused = !S.paused; $('btn-pause').lastElementChild.textContent = S.paused ? 'Play' : 'Pause'; },
    machine: () => { S.machine = !S.machine; setPressed('btn-machine', S.machine); },
    threads: () => { S.threads = !S.threads; setPressed('btn-threads', S.threads); },
    view: () => {
      S.intro = false; S.elRate = 2.2;
      S.plan = !S.plan; S.elTarget = S.plan ? EL_PLAN : EL_ELEV;
      $('btn-view').lastElementChild.textContent = S.plan ? 'Plan' : 'Elevation';
    },
    theme: () => { root.dataset.theme = palette.light ? 'dark' : 'light'; },
    save: () => { if (!window.HB_NO_SAVE) S.wantSave = true; },
    about: () => toggleAbout(),
  };
  document.querySelectorAll('[data-action]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); actions[b.dataset.action](); });
  });
  if (window.HB_NO_SAVE) $('btn-save').hidden = true;

  function toggleAbout(force) {
    const panel = $('about');
    const open = force !== undefined ? force : panel.hidden;
    panel.hidden = !open;
    $('btn-about').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) $('btn-close').focus();
  }
  $('btn-close').addEventListener('click', () => toggleAbout(false));

  const keys = { ' ': 'pause', n: 'next', arrowright: 'next', arrowleft: 'prev', e: 'machine', f: 'threads', v: 'view', t: 'theme', s: 'save', i: 'about', '?': 'about' };
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') return toggleAbout(false);
    if (keys[k] && !(k === ' ' && e.target.tagName === 'BUTTON')) { e.preventDefault(); actions[keys[k]](); }
  });

  /* drag to orbit, pinch or wheel to zoom, tap for the next plate */
  const pointers = new Map();
  let drag = null, pinch = null;
  ovCanvas.addEventListener('pointerdown', (e) => {
    ovCanvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: 0 };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: S.zoom }; drag = null;
    }
  });
  ovCanvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      S.zoom = clampZoom(pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d);
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.moved > 5) {
        S.intro = false; S.elRate = 2.2;
        S.az += dx * 0.006;
        S.el = S.elTarget = Math.min(Math.PI / 2, Math.max(0.12, S.el + dy * 0.005));
        S.plan = S.el > 1.5;
        $('btn-view').lastElementChild.textContent = S.plan ? 'Plan' : 'Elevation';
      }
    }
  });
  const release = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (drag && drag.moved <= 5 && e.type === 'pointerup') actions.next();
    if (pointers.size < 2) pinch = null;
    drag = null;
  };
  ovCanvas.addEventListener('pointerup', release);
  ovCanvas.addEventListener('pointercancel', release);
  ovCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    S.zoom = clampZoom(S.zoom * Math.exp(-e.deltaY * 0.0012));
  }, { passive: false });
  const clampZoom = (z) => Math.min(6, Math.max(0.6, z));

  /* ---------- frame loop ---------- */
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  let last = performance.now(), slow = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!S.paused) {
      S.t += dt * motion;
      S.sinceMorph += dt;
      if (!reduced) S.az += dt * 0.022;
    }
    if (S.B) {
      if (!S.paused) S.mixT = Math.min(1, S.mixT + dt / MORPH_SECONDS);
      if (S.mixT >= 1) { S.A = S.B; S.B = null; S.mixT = 0; }
    } else if (!reduced && !S.paused && S.sinceMorph > PLATE_SECONDS) {
      goTo(S.plate + 1);
    }
    if (S.intro && S.t > 7) {
      S.intro = false; S.plan = false; S.elTarget = EL_ELEV; S.elRate = 0.45;
      $('btn-view').lastElementChild.textContent = 'Elevation';
    }
    S.el += (S.elTarget - S.el) * Math.min(1, dt * S.elRate);
    S.reveal = Math.min(1, S.reveal + dt / 2.8);

    const list = H.liveTerms(S.A, S.B, ease(S.mixT), S.t);
    const scale = 1 / H.boundaryRadius(list);
    const mvp = camera();
    const px = Math.min(glCanvas.width, glCanvas.height) / 1000;
    const fadeIn = ease(S.reveal);

    renderer.render({
      list, scale, mvp,
      depth: FIELD.depthWorld / FIELD.ymax, ymax: FIELD.ymax, gamma: FIELD.gamma,
      rings: FIELD.rings, ringSamples: FIELD.ringSamples,
      threads: S.threads ? FIELD.threads : 0, threadSamples: FIELD.threadSamples,
      gain: 0.4 * px, threadGain: 0.16 * px,
      comp: FIELD.comp, fade: FIELD.fade,
      exposure: (palette.light ? 0.9 : 1.15) * fadeIn,
      light: palette.light, colors: palette.gl,
    });

    ov.setTransform(dpr, 0, 0, dpr, 0, 0);
    ov.clearRect(0, 0, W, Hh);
    ov.globalAlpha = fadeIn;
    O.drawMachine(ov, {
      list, scale, mvp, W, H: Hh,
      x: (S.t / PEN_PERIOD) * H.TAU, trail: 0.42,
      depth: FIELD.depthWorld / FIELD.ymax, ymax: FIELD.ymax, gamma: FIELD.gamma,
      brass: palette.brass, machine: S.machine,
    });
    ov.globalAlpha = 1;

    spec.setTransform(dpr, 0, 0, dpr, 0, 0);
    O.drawSpectrum(spec, specCanvas.clientWidth, specCanvas.clientHeight, list, palette.spectrum);

    if (S.wantSave) { S.wantSave = false; exportPNG(); }

    // Keep the frame rate up on slow GPUs by thinning the field.
    slow = slow * 0.95 + (dt > 0.036 ? 1 : 0) * 0.05;
    if (slow > 0.6 && FIELD.rings > 110) {
      FIELD.rings = Math.round(FIELD.rings * 0.8);
      FIELD.ringSamples = Math.max(1000, Math.round(FIELD.ringSamples * 0.85));
      FIELD.threads = Math.round(FIELD.threads * 0.8);
      $('ring-count').textContent = FIELD.rings;
      slow = 0;
    }
    nextFrame(frame);
  }

  function exportPNG() {
    const c = document.createElement('canvas');
    c.width = glCanvas.width; c.height = glCanvas.height;
    const g = c.getContext('2d');
    g.drawImage(glCanvas, 0, 0);
    g.drawImage(ovCanvas, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `harmonic-bloom-plate-${H.roman(S.plate).toLowerCase()}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }

  $('btn-view').lastElementChild.textContent = S.plan ? 'Plan' : 'Elevation';
  nextFrame(frame);
})();
