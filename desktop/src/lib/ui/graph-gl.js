// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @ts-nocheck -- presentation code: WebGL buffers and canvas drawing, not type-checked here.
// A WebGL2 point-and-line renderer for graphs of tens of thousands of nodes. No dependencies. `GraphView.svelte` owns
// its lifetime; the page owns the data, the colours and what a pick does.
//
// createGraphView({ canvas, labels, data, theme }) -> view
//   data.count            number of nodes
//   data.pos              Float32Array(count * 3)
//   data.color            Uint8Array(count * 4)   rgba
//   data.size             Float32Array(count)     a non-negative value per node (the page's measure, e.g. times shown).
//                         The point's diameter on screen is POINT_MIN_PX..POINT_MAX_PX CSS px, growing with sqrt(value / max value),
//                         so area follows the value; depth does not change it. Emphasised points keep that diameter and get a ring (RING_GAP_PX, RING_WIDTH_PX) in the ink colour.
//   data.edges            Uint32Array(pairs)      node indices
//   data.anchors          [{ text, x, y, z, color? }]  group labels, drawn while zoomed out
//   data.label(i)         a node's label
//   theme                 { dark, background: [r, g, b], ink, paper }, from the design tokens
// view.setColors(u8) / setPositions(f32) / setEdges(u32) / setHighlightEdges(u32) / setTheme(theme)
// view.setState(u8: 0 dimmed, 1 normal, 2 emphasised, 3 hidden). Dimmed points are faint but pickable. Hidden points, and the
//   edges that touch them, are neither drawn, labelled nor picked: use it for what is not on the current arrangement.
// view.setFlat(bool)    flat = top-down, axis-aligned (yaw 0, no auto-rotation); not flat = the 3D view.
// view.fit(indices?)    frames the bounding box of those points (default: every point that is not hidden) and targets its centre.
// view.home()           same as fit().
// view.select(i | -1)   marks the page's selection (ring, label, cursor) and announces it; it does not call onPick.
// view.focus(i, dist?)  flies the camera to node i and puts the keyboard cursor on it (a table row's "show on map").
// view.invalidate()     asks for a redraw; every setter does. Call it after mutating view.particles or other state in place.
// view.onHover(i | -1, [x, y]) / view.onPick(i | -1) / view.onFrame(ms, t) / view.onAnnounce(text)
// view.avoid = () => [[x0, y0, x1, y1]]  rectangles (canvas CSS px) that labels keep clear of; GraphView fills it in.
// view.particles: [{ from | fromPos, to, t (0..1), color: [r, g, b], size?, arc? }], advanced by the page's own clock.
//   size is the pulse's diameter in CSS px.
// view.animating: true while the page needs a frame per tick (its own clock). The renderer draws only when something changed,
//   the camera is moving, particles exist, auto-rotation runs, or animating is true; it stops while the canvas is hidden.
//   For compatibility, a page that sets view.onFrame and leaves animating unset gets a frame per tick.
//
// Keyboard (canvas focused): arrows turn the 3D view or pan the flat one along the screen axes; + and - zoom;
// [ and ] move the focus cursor through the selection's neighbours, else the emphasised points, else the largest points;
// Enter selects the cursor; Escape clears the selection. Under prefers-reduced-motion the camera snaps and nothing auto-rotates.

/** Point diameter on screen, in CSS px: the smallest and largest a node can be before emphasis. */
export const POINT_MIN_PX = 3;
export const POINT_MAX_PX = 16;
/** The largest a point is ever drawn, emphasis included, in CSS px. */
export const POINT_CAP_PX = 32;
/** Extra pointer slack around a point, in CSS px. */
export const HIT_PAD_PX = 4;
/** Group names show while the camera is farther than this fraction of the distance that fits the drawn points. */
export const ANCHOR_FAR = 0.45;
const HIDDEN = 3;

/** CSS-px diameter for a value: area-proportional (radius grows with sqrt(value / max)) between the min and max. */
export function pointDiameter(value, max) {
  if (!(max > 0) || !(value > 0)) return POINT_MIN_PX;
  return POINT_MIN_PX + (POINT_MAX_PX - POINT_MIN_PX) * Math.sqrt(Math.min(1, value / max));
}
/** An emphasised point's ring: a gap, then a line, outside the point, in CSS px. The point's own diameter does not change. */
export const RING_GAP_PX = 1;
export const RING_WIDTH_PX = 1.5;
const RING_OUTSET_PX = RING_GAP_PX + RING_WIDTH_PX;
/** What is drawn for a point of base diameter `d` in `state`: the sprite includes the ring, so the drawing and the hit test share it. */
export function drawnDiameter(d, state) {
  return state === HIDDEN ? 0 : state === 2 ? d + 2 * RING_OUTSET_PX : d;
}
/** The pointer's reach around a drawn point, in CSS px. */
export function hitRadius(drawn) {
  return drawn / 2 + HIT_PAD_PX;
}
/** World-axis step for a pan of `right` and `up` screen units at camera `yaw` in the flat (top-down) view: [dx, dz]. */
export function panVector(yaw, right, up) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return [right * c - up * s, -right * s - up * c];
}
/** The camera distance that frames a bounding box { min: [x, y, z], max: [x, y, z] } (null: nothing drawn). */
export function fitDistance(box, { flat, fov, aspect, margin = 1.15, floor = 60 }) {
  if (!box) return 2150;
  const dx = box.max[0] - box.min[0],
    dy = box.max[1] - box.min[1],
    dz = box.max[2] - box.min[2];
  const t = Math.tan(fov / 2);
  const d = flat
    ? Math.max(dz / 2 / t, dx / 2 / (t * aspect))
    : Math.hypot(dx, dy, dz) / 2 / Math.sin(Math.atan(t * Math.min(1, aspect)));
  return Math.max(floor, d * margin);
}

const POINT_VS = `#version 300 es
in vec3 aPos; in vec4 aColor; in float aSize; in float aState;
uniform mat4 uMVP; uniform float uDpr, uFlat, uDim;
out vec4 vColor; out vec3 vRing;
void main() {
  // A hidden point is sent outside the clip volume; aSize is its diameter in CSS px, so depth does not change it.
  gl_Position = aState > 2.5 ? vec4(2.0, 2.0, 2.0, 1.0) : uMVP * vec4(aPos.x, aPos.y * uFlat, aPos.z, 1.0);
  gl_PointSize = aSize * uDpr;
  vColor = vec4(aColor.rgb, aColor.a * (aState < 0.5 ? uDim : 1.0));
  // For an emphasised point (the sprite includes its ring): the core radius and the ring's inner radius as fractions of the sprite's.
  float radiusPx = aSize * 0.5;
  vRing = aState > 1.5 && aState < 2.5 ? vec3(1.0, (radiusPx - ${RING_OUTSET_PX.toFixed(2)}) / radiusPx, (radiusPx - ${RING_WIDTH_PX.toFixed(2)}) / radiusPx) : vec3(0.0);
}`;
const POINT_FS = `#version 300 es
precision mediump float;
in vec4 vColor; in vec3 vRing; out vec4 o;
uniform vec3 uInk;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  if (vRing.x > 0.5) {
    float r = sqrt(d);
    float aa = 0.08;
    if (r <= vRing.y) { o = vec4(vColor.rgb, vColor.a * (1.0 - smoothstep(vRing.y - aa, vRing.y, r))); return; }
    if (r >= vRing.z) { o = vec4(uInk, 1.0 - smoothstep(1.0 - aa, 1.0, r)); return; }
    discard;
  }
  o = vec4(vColor.rgb, vColor.a * smoothstep(1.0, 0.6, d));
}`;
const LINE_VS = `#version 300 es
in vec3 aPos; in vec4 aColor; in float aState;
uniform mat4 uMVP; uniform float uFlat, uAlpha, uDim;
out vec4 vColor;
void main() {
  gl_Position = uMVP * vec4(aPos.x, aPos.y * uFlat, aPos.z, 1.0);
  vColor = vec4(aColor.rgb, uAlpha * (aState < 0.5 ? uDim : 1.0));
}`;
const LINE_FS = `#version 300 es
precision mediump float;
in vec4 vColor; out vec4 o;
void main() { o = vColor; }`;

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  // One attribute layout for every program, so they share a vertex array.
  for (const [i, name] of ["aPos", "aColor", "aSize", "aState"].entries()) gl.bindAttribLocation(p, i, name);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(p, i).name;
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

/** The edges of `src` (pairs of node indices) whose two ends are both drawn. */
function visibleEdges(src, state) {
  const out = new Uint32Array(src.length);
  let n = 0;
  for (let e = 0; e < src.length; e += 2) {
    if (state[src[e]] === HIDDEN || state[src[e + 1]] === HIDDEN) continue;
    out[n++] = src[e];
    out[n++] = src[e + 1];
  }
  return out.subarray(0, n);
}

export function createGraphView({ canvas, labels, data, theme }) {
  let dark = theme.dark;
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, powerPreference: "high-performance" });
  if (!gl) throw new Error("WebGL2 is not available");
  const ctx = labels.getContext("2d");
  const N = data.count;
  const points = program(gl, POINT_VS, POINT_FS);
  const lines = program(gl, LINE_VS, LINE_FS);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = (index, array, size, type, normalized, usage = gl.STATIC_DRAW) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, array, usage);
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, type, normalized, 0, 0);
    return b;
  };
  const state = new Uint8Array(N).fill(1);
  // Base diameters (CSS px) from the page's values, and what is drawn now (emphasis, hidden) for the current state.
  let vmax = 0;
  for (let i = 0; i < N; i++) vmax = Math.max(vmax, data.size[i]);
  const base = Float32Array.from({ length: N }, (_, i) => pointDiameter(data.size[i], vmax));
  const drawn = Float32Array.from(base);
  const posBuf = buffer(0, data.pos, 3, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  const colorBuf = buffer(1, data.color, 4, gl.UNSIGNED_BYTE, true, gl.DYNAMIC_DRAW);
  const sizeBuf = buffer(2, drawn, 1, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  const stateBuf = buffer(3, state, 1, gl.UNSIGNED_BYTE, false, gl.DYNAMIC_DRAW);
  const edgeBuf = gl.createBuffer();
  const hiBuf = gl.createBuffer();
  let edgeCount = 0;
  let hiCount = 0;
  let edgeSrc = new Uint32Array(0);
  let hiSrc = new Uint32Array(0);
  let hiddenCount = 0;

  // Particles (activity pulses) are drawn from small dynamic buffers of their own.
  const pvao = gl.createVertexArray();
  gl.bindVertexArray(pvao);
  const MAXP = 4096;
  const pPos = new Float32Array(MAXP * 3);
  const pCol = new Uint8Array(MAXP * 4);
  const pSize = new Float32Array(MAXP);
  const pState = new Uint8Array(MAXP).fill(1);
  const pPosBuf = buffer(0, pPos, 3, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  const pColBuf = buffer(1, pCol, 4, gl.UNSIGNED_BYTE, true, gl.DYNAMIC_DRAW);
  const pSizeBuf = buffer(2, pSize, 1, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  buffer(3, pState, 1, gl.UNSIGNED_BYTE, false);
  gl.bindVertexArray(null);

  const cam = { yaw: 0.6, pitch: 0.42, dist: 2150, tx: 0, ty: 0, tz: 0, flat: 1 };
  const goal = { ...cam };
  const mvp = new Float32Array(16);
  let W = 1,
    H = 1,
    dpr = 1,
    fov = 0.8;
  let hover = -1,
    selected = -1,
    cursor = -1,
    idleAt = 0,
    raf = 0,
    lastT = 0,
    dirty = true,
    visible = true,
    pointerMoved = false,
    destroyed = false;
  let pointer = null;
  let box = null,
    boxStale = true;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const noop = () => {};
  let emphasis = [],
    edgeScale = 1;

  function invalidate() {
    dirty = true;
    schedule();
  }
  function schedule() {
    if (raf || destroyed || !visible) return;
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }
  const announce = (text) => view.onAnnounce(text);

  /** Bounding box of the points that are drawn (not hidden), or of `indices`; y follows the flat/3D goal. */
  function bounds(indices) {
    if (!indices && !boxStale) return box;
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    const add = (i) => {
      if (state[i] === HIDDEN) return;
      for (let a = 0; a < 3; a++) {
        const v = a === 1 ? data.pos[i * 3 + 1] * goal.flat : data.pos[i * 3 + a];
        lo[a] = Math.min(lo[a], v);
        hi[a] = Math.max(hi[a], v);
      }
    };
    if (indices) for (const i of indices) add(i);
    else for (let i = 0; i < N; i++) add(i);
    const out = lo[0] === Infinity ? null : { min: lo, max: hi };
    if (!indices) {
      box = out;
      boxStale = false;
    }
    return out;
  }
  const fitFor = (b) => fitDistance(b, { flat: goal.flat === 0, fov, aspect: W / H });

  const view = {
    particles: [],
    autoRotate: !motion.matches,
    animating: undefined,
    onHover: noop,
    onPick: noop,
    onFrame: noop,
    onAnnounce: noop,
    avoid: () => [],
    cam,
    goal,
    state,
    get emphasis() {
      return emphasis;
    },
    set emphasis(list) {
      emphasis = list;
      invalidate();
    },
    get edgeScale() {
      return edgeScale;
    },
    set edgeScale(v) {
      edgeScale = v;
      invalidate();
    },
    invalidate,
    setColors(u8) {
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, u8);
      data.color = u8;
      invalidate();
    },
    setPositions(f32) {
      data.pos = f32;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, f32);
      boxStale = true;
      invalidate();
    },
    setState(u8) {
      const hadHidden = hiddenCount > 0;
      state.set(u8);
      hiddenCount = 0;
      for (let i = 0; i < N; i++) {
        drawn[i] = drawnDiameter(base[i], state[i]);
        if (state[i] === HIDDEN) hiddenCount++;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state);
      gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, drawn);
      if (hiddenCount || hadHidden) {
        uploadEdges();
        uploadHighlight();
      }
      boxStale = true;
      invalidate();
    },
    setEdges(u32) {
      edgeSrc = u32;
      uploadEdges();
      invalidate();
    },
    setHighlightEdges(u32) {
      hiSrc = u32;
      uploadHighlight();
      invalidate();
    },
    setFlat(flat) {
      goal.flat = flat ? 0 : 1;
      goal.pitch = flat ? Math.PI / 2 - 0.001 : 0.42;
      if (flat) {
        // Axis-aligned: yaw 0 by the shorter way round, so the flat arrangement is not left turned.
        cam.yaw -= Math.round(cam.yaw / (2 * Math.PI)) * 2 * Math.PI;
        goal.yaw = 0;
      }
      boxStale = true;
      invalidate();
    },
    setTheme(next) {
      theme = next;
      dark = next.dark;
      invalidate();
    },
    select(i) {
      selected = i;
      if (i >= 0) cursor = i;
      announce(i >= 0 ? `Selected ${data.label(i)}` : "Selection cleared");
      invalidate();
    },
    focus(i, dist) {
      if (i < 0 || state[i] === HIDDEN) return;
      goal.tx = data.pos[i * 3];
      goal.ty = data.pos[i * 3 + 1] * goal.flat;
      goal.tz = data.pos[i * 3 + 2];
      if (dist) goal.dist = Math.min(goal.dist, dist);
      idleAt = performance.now() + 6000;
      if (cursor !== i) announce(data.label(i));
      cursor = i;
      invalidate();
    },
    fit(indices) {
      const b = bounds(indices);
      goal.tx = b ? (b.min[0] + b.max[0]) / 2 : 0;
      goal.ty = b ? (b.min[1] + b.max[1]) / 2 : 0;
      goal.tz = b ? (b.min[2] + b.max[2]) / 2 : 0;
      goal.dist = fitFor(b);
      invalidate();
      return goal.dist;
    },
    home() {
      return view.fit();
    },
    project,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      seen.disconnect();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };

  function uploadEdges() {
    const list = hiddenCount ? visibleEdges(edgeSrc, state) : edgeSrc;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, list, gl.STATIC_DRAW);
    edgeCount = list.length;
  }
  function uploadHighlight() {
    const list = hiddenCount ? visibleEdges(hiSrc, state) : hiSrc;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, hiBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, list, gl.DYNAMIC_DRAW);
    hiCount = list.length;
  }
  edgeSrc = data.edges;
  uploadEdges();

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    for (const c of [canvas, labels]) {
      c.width = Math.max(1, W * dpr);
      c.height = Math.max(1, H * dpr);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    invalidate();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  // Nothing is drawn, and no frame is requested, while the canvas is hidden or detached.
  const seen = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) invalidate();
    else {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  });
  seen.observe(canvas);
  resize();

  function updateMatrix() {
    const cp = Math.cos(cam.pitch),
      sp = Math.sin(cam.pitch),
      cy = Math.cos(cam.yaw),
      sy = Math.sin(cam.yaw);
    // The camera's basis: f looks from the eye to the target, r is right, u is up.
    const fx = -cp * sy,
      fy = -sp,
      fz = -cp * cy;
    const rx = cy,
      ry = 0,
      rz = -sy;
    const ux = ry * fz - rz * fy,
      uy = rz * fx - rx * fz,
      uz = rx * fy - ry * fx;
    const ex = cam.tx - fx * cam.dist,
      ey = cam.ty - fy * cam.dist,
      ez = cam.tz - fz * cam.dist;
    const f = 1 / Math.tan(fov / 2),
      aspect = W / H,
      near = 5,
      far = 20000;
    const a = (far + near) / (near - far),
      b = (2 * far * near) / (near - far);
    // mvp = projection * view, column-major.
    const v = [
      rx,
      ux,
      -fx,
      ry,
      uy,
      -fy,
      rz,
      uz,
      -fz,
      -(rx * ex + ry * ey + rz * ez),
      -(ux * ex + uy * ey + uz * ez),
      fx * ex + fy * ey + fz * ez,
    ];
    for (let c = 0; c < 4; c++) {
      const x = v[c * 3],
        y = v[c * 3 + 1],
        z = v[c * 3 + 2],
        w = c === 3 ? 1 : 0;
      mvp[c * 4] = (f / aspect) * x;
      mvp[c * 4 + 1] = f * y;
      mvp[c * 4 + 2] = a * z + b * w;
      mvp[c * 4 + 3] = -z;
    }
  }

  /** Screen position of a node, or of a world point: [x, y, w, drawnRadiusPx]. w <= 0 is behind the camera. */
  function project(i, out = [0, 0, 0, 0], x, y, z) {
    if (x === undefined) {
      x = data.pos[i * 3];
      y = data.pos[i * 3 + 1];
      z = data.pos[i * 3 + 2];
    }
    y *= cam.flat;
    const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    out[0] = (((mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w) * 0.5 + 0.5) * W;
    out[1] = (1 - (((mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w) * 0.5 + 0.5)) * H;
    out[2] = w;
    out[3] = i >= 0 ? drawn[i] / 2 : 0;
    return out;
  }

  /** The node under the pointer: every drawn node (dimmed ones too) is projected on the CPU, well under a millisecond at 30k. */
  function pick(mx, my) {
    const p = [0, 0, 0, 0];
    let best = -1,
      bestScore = Infinity;
    for (let i = 0; i < N; i++) {
      if (state[i] === HIDDEN) continue;
      project(i, p);
      if (p[2] <= 0) continue;
      const dx = p[0] - mx,
        dy = p[1] - my,
        r = hitRadius(drawn[i]);
      const d = dx * dx + dy * dy;
      if (d < r * r) {
        const score = d / (r * r) + p[2] * 1e-5;
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    return best;
  }

  // Pointer: drag orbits (or pans in flat mode / with shift or the right button), wheel and pinch zoom.
  const touches = new Map();
  let dragged = false,
    pinch = 0;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    dragged = false;
    pinch = 0;
  });
  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer = [e.clientX - rect.left, e.clientY - rect.top];
    pointerMoved = true;
    schedule();
    const last = touches.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last[0],
      dy = e.clientY - last[1];
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    idleAt = performance.now() + 6000;
    invalidate();
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) goal.dist = Math.max(40, Math.min(8000, goal.dist * (pinch / d)));
      pinch = d;
      dragged = true;
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
    if (goal.flat === 0 || e.shiftKey || e.buttons === 2) {
      const k = (cam.dist * Math.tan(fov / 2) * 2) / H;
      const cy = Math.cos(cam.yaw),
        sy = Math.sin(cam.yaw),
        sp = Math.sin(cam.pitch);
      goal.tx -= (dx * cy + dy * sy * sp) * k;
      goal.tz -= (-dx * sy + dy * cy * sp) * k;
      Object.assign(cam, { tx: goal.tx, tz: goal.tz });
    } else {
      goal.yaw -= dx * 0.005;
      goal.pitch = Math.max(-1.4, Math.min(1.5, goal.pitch + dy * 0.005));
      Object.assign(cam, { yaw: goal.yaw, pitch: goal.pitch });
    }
  });
  const release = (e) => {
    if (touches.delete(e.pointerId) && !dragged && e.type === "pointerup") {
      const rect = canvas.getBoundingClientRect();
      updateMatrix();
      view.onPick(pick(e.clientX - rect.left, e.clientY - rect.top));
    }
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    pointer = null;
    if (hover !== -1) {
      hover = -1;
      view.onHover(-1);
      invalidate();
    }
  });
  // The keyboard cursor is drawn only while the canvas has focus.
  canvas.addEventListener("focus", invalidate);
  canvas.addEventListener("blur", invalidate);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      goal.dist = Math.max(40, Math.min(8000, goal.dist * Math.exp(e.deltaY * 0.0012)));
      idleAt = performance.now() + 6000;
      invalidate();
    },
    { passive: false },
  );

  // The largest nodes first: labels are given to whichever of these are big enough on screen.
  const bySize = Array.from({ length: N }, (_, i) => i)
    .sort((a, b) => data.size[b] - data.size[a])
    .slice(0, 3000);

  /** What [ and ] step through: the selection's neighbours, else the emphasised points, else the largest points. */
  function cursorList() {
    if (selected >= 0 && emphasis.length) return [selected, ...emphasis].filter((i) => state[i] !== HIDDEN);
    const pool = bySize.filter((i) => state[i] !== HIDDEN);
    const lit = pool.filter((i) => state[i] === 2);
    return lit.length ? lit : pool;
  }
  function moveCursor(step) {
    const list = cursorList();
    if (!list.length) return;
    const at = list.indexOf(cursor);
    const next = list[(at < 0 ? (step > 0 ? 0 : list.length - 1) : at + step + list.length) % list.length];
    // Bring the point into view only when it is off screen, so the camera is not moved needlessly.
    updateMatrix();
    const p = project(next);
    if (p[2] <= 0 || p[0] < 24 || p[0] > W - 24 || p[1] < 24 || p[1] > H - 24) view.focus(next);
    else {
      cursor = next;
      announce(data.label(next));
      invalidate();
    }
  }
  // Keyboard: see the header. Arrows turn the 3D view or pan the flat one along the screen axes.
  canvas.tabIndex = 0;
  canvas.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? 0.3 : 0.1;
    const flat = goal.flat === 0;
    const pan = (right, up) => {
      const [dx, dz] = panVector(goal.yaw, right * goal.dist * 0.1, up * goal.dist * 0.1);
      goal.tx += dx;
      goal.tz += dz;
    };
    const turn = (right, up) => {
      goal.yaw += right * step;
      goal.pitch = Math.min(1.5, Math.max(-1.4, goal.pitch + up * step));
    };
    const move = flat ? pan : turn;
    if (e.key === "ArrowLeft") move(-1, 0);
    else if (e.key === "ArrowRight") move(1, 0);
    else if (e.key === "ArrowUp") move(0, 1);
    else if (e.key === "ArrowDown") move(0, -1);
    else if (e.key === "+" || e.key === "=") goal.dist = Math.max(40, goal.dist * 0.8);
    else if (e.key === "-") goal.dist = Math.min(6000, goal.dist * 1.25);
    else if (e.key === "]") moveCursor(1);
    else if (e.key === "[") moveCursor(-1);
    else if (e.key === "Enter" && cursor >= 0 && state[cursor] !== HIDDEN) view.onPick(cursor);
    else if (e.key === "Escape" && selected >= 0) view.onPick(-1);
    else return;
    e.preventDefault();
    idleAt = performance.now() + 6000;
    invalidate();
  });

  const ink = () => theme.ink;
  /** The ink colour as 0..1 components, for the point shader's rings. */
  const inkRgb = () => (theme.ink.match(/[\d.]+/g) ?? [0, 0, 0]).slice(0, 3).map((v) => Number(v) / 255);
  const paper = () => theme.paper;
  const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

  function drawLabels() {
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = "middle";
    const p = [0, 0, 0, 0];
    const taken = [];
    const keepClear = view.avoid();
    /** Draws a label inside the canvas and outside the overlays. `anchor` [x, y, r] lets a bold label try the other sides. */
    const place = (text, x, y, { bold = false, pill = false, color = ink(), anchor } = {}) => {
      ctx.font = `${bold ? "600 " : ""}${pill ? 11 : 12}px ui-sans-serif, system-ui, sans-serif`;
      const w = ctx.measureText(text).width + (pill ? 16 : 8);
      const spots = [[x, y]];
      if (anchor) {
        const [ax, ay, r] = anchor;
        spots.push([ax - r - 9 - w, ay], [ax - w / 2, ay - r - 16], [ax - w / 2, ay + r + 16]);
      }
      let box = null,
        at = null;
      for (const [sx, sy] of spots) {
        const cx = Math.max(2, Math.min(W - w - 2, sx)),
          cy = Math.max(11, Math.min(H - 11, sy));
        // A plain label pushed away from its point by the edge would point at nothing: leave it out.
        if (!bold && !pill && (cx !== sx || cy !== sy)) continue;
        const candidate = [cx, cy - 10, cx + w, cy + 10];
        if (keepClear.some((r) => overlap(candidate, r))) continue;
        if (!bold && taken.some((t) => overlap(candidate, t))) continue;
        box = candidate;
        at = [cx, cy];
        break;
      }
      if (!box) return;
      taken.push(box);
      ctx.fillStyle = paper();
      ctx.beginPath();
      ctx.roundRect(at[0], at[1] - 9, w, 18, pill ? 9 : 2);
      ctx.fill();
      if (pill) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = color;
      ctx.fillText(text, at[0] + (pill ? 8 : 4), at[1] + 0.5);
    };
    const ring = (i, color, grow = 3, dash = []) => {
      if (state[i] === HIDDEN) return false;
      project(i, p);
      if (p[2] <= 0) return false;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.arc(p[0], p[1], p[3] + grow, 0, 7);
      ctx.stroke();
      ctx.setLineDash([]);
      return true;
    };
    const bold = (i, gap) => place(data.label(i), p[0] + p[3] + gap, p[1], { bold: true, anchor: [p[0], p[1], p[3]] });
    if (selected >= 0 && ring(selected, ink(), 5)) bold(selected, 9);
    if (hover >= 0 && hover !== selected && ring(hover, ink())) bold(hover, 7);
    // The keyboard cursor: a dashed ring, so it reads apart from the selection and the hover.
    if (cursor >= 0 && cursor !== selected && cursor !== hover && document.activeElement === canvas)
      if (ring(cursor, ink(), 6, [4, 3])) bold(cursor, 9);
    for (const i of emphasis) {
      if (i === selected || i === hover || state[i] === HIDDEN) continue;
      project(i, p);
      if (p[2] > 0 && p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H) place(data.label(i), p[0] + p[3] + 5, p[1]);
      if (taken.length > 40) break;
    }
    // Group names while zoomed out (relative to the distance that fits what is drawn); node names once nodes are large enough.
    const far = cam.dist > ANCHOR_FAR * fitFor(bounds());
    if (far)
      for (const a of data.anchors ?? []) {
        project(-1, p, a.x, a.y, a.z);
        if (p[2] > 0) place(a.text, p[0], p[1], { pill: true, color: a.color ?? ink() });
      }
    let shown = 0;
    if (!far && selected < 0)
      for (const i of bySize) {
        if (shown > 28) break;
        if (state[i] === HIDDEN || i === selected || i === hover) continue;
        project(i, p);
        if (p[2] <= 0 || p[3] < 5.5 || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
        const before = taken.length;
        place(data.label(i), p[0] + p[3] + 4, p[1]);
        if (taken.length > before) shown++;
      }
  }

  function drawScene() {
    const bg = theme.background;
    gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // Lines are additive on a dark ground (overlaps glow) and plain alpha on a light one.
    gl.blendFunc(gl.SRC_ALPHA, dark ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(vao);

    gl.useProgram(lines.p);
    gl.uniformMatrix4fv(lines.u.uMVP, false, mvp);
    gl.uniform1f(lines.u.uFlat, cam.flat);
    gl.uniform1f(lines.u.uDim, 0.12);
    // Fewer, fainter lines read better far away; the density rises as you zoom in.
    const zoom = Math.min(1, 500 / cam.dist);
    gl.uniform1f(lines.u.uAlpha, ((dark ? 0.075 : 0.09) + zoom * 0.12) * edgeScale);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuf);
    gl.drawElements(gl.LINES, edgeCount, gl.UNSIGNED_INT, 0);
    if (hiCount) {
      gl.uniform1f(lines.u.uAlpha, 0.9);
      gl.uniform1f(lines.u.uDim, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, hiBuf);
      gl.drawElements(gl.LINES, hiCount, gl.UNSIGNED_INT, 0);
    }

    // Nodes use plain alpha in both themes, so a dense cluster keeps its colours and does not burn out to white.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(points.p);
    gl.uniformMatrix4fv(points.u.uMVP, false, mvp);
    gl.uniform3f(points.u.uInk, ...inkRgb());
    gl.uniform1f(points.u.uDpr, dpr);
    gl.uniform1f(points.u.uFlat, cam.flat);
    gl.uniform1f(points.u.uDim, dark ? 0.16 : 0.18);
    gl.drawArrays(gl.POINTS, 0, N);

    // Pulses travelling along a link, drawn as a bright head on a straight path between two nodes.
    const count = Math.min(view.particles.length, MAXP);
    if (count) {
      for (let i = 0; i < count; i++) {
        const q = view.particles[i],
          a = q.from * 3,
          b = q.to * 3,
          s = q.t;
        const from = q.fromPos ?? data.pos.subarray(a, a + 3),
          to = data.pos.subarray(b, b + 3);
        pPos[i * 3] = from[0] + (to[0] - from[0]) * s;
        pPos[i * 3 + 1] = from[1] + (to[1] - from[1]) * s + Math.sin(s * Math.PI) * (q.arc ?? 0);
        pPos[i * 3 + 2] = from[2] + (to[2] - from[2]) * s;
        pCol.set(q.color, i * 4);
        pCol[i * 4 + 3] = 255;
        pSize[i] = Math.min(POINT_CAP_PX, q.size ?? 9);
      }
      gl.bindVertexArray(pvao);
      gl.bindBuffer(gl.ARRAY_BUFFER, pPosBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pPos, 0, count * 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, pColBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pCol, 0, count * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, pSizeBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pSize, 0, count);
      gl.drawArrays(gl.POINTS, 0, count);
    }
    gl.bindVertexArray(null);
    drawLabels();
  }

  const KEYS = ["yaw", "pitch", "dist", "tx", "ty", "tz", "flat"];
  const EPS = { yaw: 1e-4, pitch: 1e-4, flat: 1e-3, dist: 0.05, tx: 0.02, ty: 0.02, tz: 0.02 };
  function frame(t) {
    raf = 0;
    if (destroyed || !visible || !canvas.isConnected) return;
    const dt = Math.min(64, t - lastT);
    lastT = t;
    const spin = view.autoRotate && !motion.matches && goal.flat === 1;
    let rotating = false;
    if (spin && t > idleAt && !touches.size) {
      goal.yaw += dt * 0.00004;
      rotating = true;
    }
    // Under reduced motion the camera does not ease: it is where it was told to be.
    const k = motion.matches ? 1 : 1 - Math.exp(-dt / 140);
    let moving = false;
    for (const key of KEYS) {
      const gap = goal[key] - cam[key];
      if (Math.abs(gap) < EPS[key]) cam[key] = goal[key];
      else {
        cam[key] += gap * k;
        moving = true;
      }
    }
    updateMatrix();
    if (pointerMoved || (moving && pointer)) {
      pointerMoved = false;
      if (pointer && !touches.size) {
        const next = pick(pointer[0], pointer[1]);
        if (next !== hover) {
          hover = next;
          canvas.style.cursor = next >= 0 ? "pointer" : "grab";
          view.onHover(next, pointer);
          dirty = true;
        }
      }
    }
    // A page that drives its own clock from onFrame and does not say animating gets onFrame every tick, but a redraw only
    // when that call changes something.
    const ticking = view.animating ?? view.onFrame !== noop;
    const draw = dirty || moving || rotating || view.animating === true || view.particles.length > 0;
    if (draw) {
      dirty = false;
      drawScene();
    }
    if (draw || ticking) view.onFrame(dt, t);
    if (dirty || moving || spin || ticking || view.particles.length) schedule();
  }
  invalidate();
  return view;
}
