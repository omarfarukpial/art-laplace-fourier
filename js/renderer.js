/* Harmonic Bloom: WebGL2 renderer.
 *
 * The field is drawn as instanced line strips with no vertex buffers: the vertex
 * shader reads gl_InstanceID / gl_VertexID, works out (x, y) and sums the series
 *     u(x, y) = Σ c_k e^{-|k| y} e^{ikx}
 * Light accumulates additively in a half-float, multisampled target and is
 * tone-mapped onto the ground colour in a final pass.
 *   R = rings near the boundary, G = deep rings, B = threads (lines of constant x).
 */
(function (global) {
  'use strict';

  const MAX_TERMS = 48;

  const FIELD_VS = `#version 300 es
precision highp float;
precision highp int;
uniform vec4 uTerms[${MAX_TERMS}];
uniform int uCount;
uniform mat4 uMVP;
uniform float uScale, uDepth, uYmax, uGamma, uLines, uSamples, uComp;
uniform int uMode;
out float vDepth;
out float vWeight;
void main() {
  float i = float(gl_InstanceID), j = float(gl_VertexID);
  float s, q;
  if (uMode == 0) { q = i / max(uLines - 1.0, 1.0); s = j / uSamples; }
  else            { s = (i + 0.5) / uLines;         q = j / uSamples; }
  float y = uYmax * pow(q, uGamma);
  vec2 acc = vec2(0.0);
  for (int n = 0; n < ${MAX_TERMS}; n++) {
    if (n >= uCount) break;
    vec4 T = uTerms[n];
    float a = 6.28318530718 * fract(T.x * s);
    vec2 e = vec2(cos(a), sin(a)) * exp(-T.y * y);
    acc += vec2(T.z * e.x - T.w * e.y, T.z * e.y + T.w * e.x);
  }
  vDepth = q;
  // Rings crowd together near the boundary (dy/dq → 0); dim them in proportion.
  vWeight = uMode == 0 ? pow(max(uGamma * pow(max(q, 1e-4), uGamma - 1.0), 0.04), uComp) : 1.0;
  gl_Position = uMVP * vec4(acc * uScale, -uDepth * y, 1.0);
}`;

  const FIELD_FS = `#version 300 es
precision highp float;
precision highp int;
in float vDepth;
in float vWeight;
uniform float uGain, uFade;
uniform int uMode;
out vec4 o;
void main() {
  float w = uGain * vWeight * exp(-uFade * vDepth);
  if (uMode == 0) {
    float rim = pow(1.0 - vDepth, 3.0);
    o = vec4(w * rim, w * (1.0 - rim), 0.0, 0.0);
  } else {
    o = vec4(0.0, 0.0, w * (1.0 - 0.6 * vDepth), 0.0);
  }
}`;

  const POST_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const POST_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uExposure;
uniform int uLight;
uniform vec3 uBg, uRim, uDeep, uThread;
out vec4 o;
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 a = texture(uTex, uv).rgb * uExposure;
  vec2 c = (gl_FragCoord.xy - 0.5 * uRes) / max(uRes.x, uRes.y);
  float r2 = dot(c, c);
  vec3 col;
  if (uLight == 0) {
    vec3 bg = uBg * (1.0 + 0.55 * exp(-r2 * 9.0)) * (1.0 - 0.35 * r2);
    vec3 e = uRim * a.r + uDeep * a.g + uThread * a.b;
    col = 1.0 - (1.0 - bg) * exp(-e);
  } else {
    vec3 bg = uBg * (1.0 - 0.06 * r2);
    vec3 absorb = -log(uRim) * a.r - log(uDeep) * a.g - log(uThread) * a.b;
    col = bg * exp(-absorb);
  }
  col += (hash(gl_FragCoord.xy) - 0.5) * (2.5 / 255.0);
  o = vec4(col, 1.0);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
    }
    return sh;
  }

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  function createRenderer(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, powerPreference: 'high-performance',
    });
    if (!gl) return null;

    let field, post, vao, targets = null;
    let hdr = false, samples = 0;
    const terms = new Float32Array(MAX_TERMS * 4);

    function init() {
      hdr = !!gl.getExtension('EXT_color_buffer_float');
      field = program(gl, FIELD_VS, FIELD_FS);
      post = program(gl, POST_VS, POST_FS);
      vao = gl.createVertexArray();
      samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
      targets = null;
    }

    function makeTargets(w, h) {
      if (targets) {
        gl.deleteFramebuffer(targets.msFbo); gl.deleteRenderbuffer(targets.msRb);
        gl.deleteFramebuffer(targets.fbo); gl.deleteTexture(targets.tex);
      }
      const fmt = hdr ? gl.RGBA16F : gl.RGBA8;
      const msRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, msRb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, w, h);
      const msFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msRb);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      targets = { msRb, msFbo, tex, fbo, w, h };
    }

    init();
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', init);

    /* f = { list, scale, mvp, depth, ymax, gamma, rings, ringSamples, threads,
     *       threadSamples, gain, threadGain, fade, comp, exposure, light,
     *       colors: { bg, rim, deep, thread } } */
    function render(f) {
      if (gl.isContextLost()) return;
      const w = canvas.width, h = canvas.height;
      if (!targets || targets.w !== w || targets.h !== h) makeTargets(w, h);

      const n = Math.min(f.list.length, MAX_TERMS);
      terms.fill(0);
      for (let i = 0; i < n; i++) {
        const e = f.list[i];
        terms.set([e.k, Math.abs(e.k), e.re, e.im], i * 4);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.msFbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);

      const U = field.u;
      gl.useProgram(field.p);
      gl.bindVertexArray(vao);
      gl.uniform4fv(U.uTerms, terms);
      gl.uniform1i(U.uCount, n);
      gl.uniformMatrix4fv(U.uMVP, false, f.mvp);
      gl.uniform1f(U.uScale, f.scale);
      gl.uniform1f(U.uDepth, f.depth);
      gl.uniform1f(U.uYmax, f.ymax);
      gl.uniform1f(U.uGamma, f.gamma);
      gl.uniform1f(U.uComp, f.comp);
      gl.uniform1f(U.uFade, f.fade);

      gl.uniform1i(U.uMode, 0);
      gl.uniform1f(U.uLines, f.rings);
      gl.uniform1f(U.uSamples, f.ringSamples);
      gl.uniform1f(U.uGain, f.gain);
      gl.drawArraysInstanced(gl.LINE_STRIP, 0, f.ringSamples + 1, f.rings);

      if (f.threads > 0 && f.threadGain > 0) {
        gl.uniform1i(U.uMode, 1);
        gl.uniform1f(U.uLines, f.threads);
        gl.uniform1f(U.uSamples, f.threadSamples);
        gl.uniform1f(U.uGain, f.threadGain);
        gl.drawArraysInstanced(gl.LINE_STRIP, 0, f.threadSamples + 1, f.threads);
      }
      gl.disable(gl.BLEND);

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targets.msFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      const P = post.u;
      gl.useProgram(post.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targets.tex);
      gl.uniform1i(P.uTex, 0);
      gl.uniform2f(P.uRes, w, h);
      gl.uniform1f(P.uExposure, f.exposure);
      gl.uniform1i(P.uLight, f.light ? 1 : 0);
      gl.uniform3fv(P.uBg, f.colors.bg);
      gl.uniform3fv(P.uRim, f.colors.rim);
      gl.uniform3fv(P.uDeep, f.colors.deep);
      gl.uniform3fv(P.uThread, f.colors.thread);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    return { render, gl, get hdr() { return hdr; }, MAX_TERMS };
  }

  global.HarmonicRenderer = { createRenderer, MAX_TERMS };
})(window);
