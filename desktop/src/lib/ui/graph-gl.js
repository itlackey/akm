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
//   data.size             Float32Array(count)     world-space radius
//   data.edges            Uint32Array(pairs)      node indices
//   data.anchors          [{ text, x, y, z, color? }]  group labels, drawn while zoomed out
//   data.label(i)         a node's label
//   theme                 { dark, background: [r, g, b], ink, paper }, from the design tokens
// view.setColors(u8) / setPositions(f32) / setState(u8: 0 dimmed, 1 normal, 2 emphasised) / setEdges(u32)
// view.setHighlightEdges(u32) / setFlat(bool) / setTheme(theme) / select(i) / focus(i) / home() / destroy()
// view.onHover(i | -1, [x, y]) / view.onPick(i | -1) / view.onFrame(ms)
// view.particles: [{ from | fromPos, to, t (0..1), color: [r, g, b], size?, arc? }], advanced by the page's own clock.

const POINT_VS = `#version 300 es
in vec3 aPos; in vec4 aColor; in float aSize; in float aState;
uniform mat4 uMVP; uniform float uPx, uFlat, uDim, uMinPx;
out vec4 vColor;
void main() {
  gl_Position = uMVP * vec4(aPos.x, aPos.y * uFlat, aPos.z, 1.0);
  float s = aSize * uPx / gl_Position.w;
  if (aState > 1.5) s = s * 1.5 + 3.0;
  gl_PointSize = clamp(s, uMinPx, 44.0);
  vColor = vec4(aColor.rgb, aColor.a * (aState < 0.5 ? uDim : 1.0));
}`;
const POINT_FS = `#version 300 es
precision mediump float;
in vec4 vColor; out vec4 o;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
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
  const posBuf = buffer(0, data.pos, 3, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  const colorBuf = buffer(1, data.color, 4, gl.UNSIGNED_BYTE, true, gl.DYNAMIC_DRAW);
  buffer(2, data.size, 1, gl.FLOAT, false);
  const stateBuf = buffer(3, state, 1, gl.UNSIGNED_BYTE, false, gl.DYNAMIC_DRAW);
  const edgeBuf = gl.createBuffer();
  const hiBuf = gl.createBuffer();
  let edgeCount = 0;
  let hiCount = 0;

  // Particles (activity pulses) and the emphasised nodes are drawn from small dynamic buffers of their own.
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
    fov = 0.8,
    px = 1;
  let hover = -1,
    selected = -1,
    idleAt = 0,
    raf = 0,
    destroyed = false;
  let pointer = null;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const view = {
    particles: [],
    emphasis: [],
    autoRotate: !reduced,
    edgeScale: 1,
    onHover: () => {},
    onPick: () => {},
    onFrame: () => {},
    cam,
    goal,
    setColors(u8) {
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, u8);
      data.color = u8;
    },
    setPositions(f32) {
      data.pos = f32;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, f32);
    },
    setState(u8) {
      state.set(u8);
      gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state);
    },
    state,
    setEdges(u32) {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, u32, gl.STATIC_DRAW);
      edgeCount = u32.length;
    },
    setHighlightEdges(u32) {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, hiBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, u32, gl.DYNAMIC_DRAW);
      hiCount = u32.length;
    },
    setFlat(flat) {
      goal.flat = flat ? 0 : 1;
      goal.pitch = flat ? Math.PI / 2 - 0.001 : 0.42;
    },
    setTheme(next) {
      theme = next;
      dark = next.dark;
    },
    select(i) {
      selected = i;
    },
    focus(i, dist) {
      goal.tx = data.pos[i * 3];
      goal.ty = data.pos[i * 3 + 1] * goal.flat;
      goal.tz = data.pos[i * 3 + 2];
      if (dist) goal.dist = Math.min(goal.dist, dist);
      idleAt = performance.now() + 6000;
    },
    home() {
      Object.assign(goal, { tx: 0, ty: 0, tz: 0, dist: 2150 });
    },
    project,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
  view.setEdges(data.edges);

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
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
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
    px = (H * dpr * f) / 2;
  }

  /** Screen position of a node, or of a world point: [x, y, w, pointRadiusPx]. w <= 0 is behind the camera. */
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
    out[3] = i >= 0 ? Math.min(44, Math.max((data.size[i] * px) / w, 2 * dpr)) / dpr / 2 : 0;
    return out;
  }

  /** The node under the pointer: every node is projected on the CPU, which costs well under a millisecond at 30k. */
  function pick(mx, my) {
    const p = [0, 0, 0, 0];
    let best = -1,
      bestScore = Infinity;
    for (let i = 0; i < N; i++) {
      if (state[i] === 0) continue;
      project(i, p);
      if (p[2] <= 0) continue;
      const dx = p[0] - mx,
        dy = p[1] - my,
        r = p[3] + 4;
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
    const last = touches.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last[0],
      dy = e.clientY - last[1];
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    idleAt = performance.now() + 6000;
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
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      goal.dist = Math.max(40, Math.min(8000, goal.dist * Math.exp(e.deltaY * 0.0012)));
      idleAt = performance.now() + 6000;
    },
    { passive: false },
  );
  // Keyboard: arrows orbit or pan, + and - zoom, so the map is usable without a pointer.
  canvas.tabIndex = 0;
  canvas.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.3 : 0.1;
    const pan = goal.flat === 0 ? goal.dist * 0.1 : 0;
    // In flat mode the arrows pan; in 3D they turn the map.
    if (e.key === "ArrowLeft") {
      if (pan) goal.tx -= pan;
      else goal.yaw -= step;
    } else if (e.key === "ArrowRight") {
      if (pan) goal.tx += pan;
      else goal.yaw += step;
    } else if (e.key === "ArrowUp") {
      if (pan) goal.tz -= pan;
      else goal.pitch = Math.min(1.5, goal.pitch + step);
    } else if (e.key === "ArrowDown") {
      if (pan) goal.tz += pan;
      else goal.pitch = Math.max(-1.4, goal.pitch - step);
    } else if (e.key === "+" || e.key === "=") goal.dist = Math.max(40, goal.dist * 0.8);
    else if (e.key === "-") goal.dist = Math.min(6000, goal.dist * 1.25);
    else return;
    e.preventDefault();
    idleAt = performance.now() + 6000;
  });

  // The largest nodes first: labels are given to whichever of these are big enough on screen.
  const bySize = Array.from({ length: N }, (_, i) => i)
    .sort((a, b) => data.size[b] - data.size[a])
    .slice(0, 3000);
  const ink = () => theme.ink;
  const paper = () => theme.paper;

  function drawLabels() {
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = "middle";
    const p = [0, 0, 0, 0];
    const taken = [];
    const place = (text, x, y, { bold = false, pill = false, color = ink() } = {}) => {
      ctx.font = `${bold ? "600 " : ""}${pill ? 11 : 12}px ui-sans-serif, system-ui, sans-serif`;
      const w = ctx.measureText(text).width + (pill ? 16 : 8);
      const box = [x, y - 10, x + w, y + 10];
      if (!bold && taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) return;
      taken.push(box);
      ctx.fillStyle = paper();
      ctx.beginPath();
      ctx.roundRect(x, y - 9, w, 18, pill ? 9 : 2);
      ctx.fill();
      if (pill) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = color;
      ctx.fillText(text, x + (pill ? 8 : 4), y + 0.5);
    };
    const ring = (i, color, grow = 3) => {
      project(i, p);
      if (p[2] <= 0) return false;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p[0], p[1], p[3] + grow, 0, 7);
      ctx.stroke();
      return true;
    };
    if (selected >= 0 && ring(selected, ink(), 5)) place(data.label(selected), p[0] + p[3] + 9, p[1], { bold: true });
    if (hover >= 0 && hover !== selected && ring(hover, ink()))
      place(data.label(hover), p[0] + p[3] + 7, p[1], { bold: true });
    for (const i of view.emphasis) {
      if (i === selected || i === hover) continue;
      project(i, p);
      if (p[2] > 0 && p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H) place(data.label(i), p[0] + p[3] + 5, p[1]);
      if (taken.length > 40) break;
    }
    // Group names while zoomed out; node names once nodes are large enough to read.
    const far = cam.dist > 1100;
    if (far)
      for (const a of data.anchors ?? []) {
        project(-1, p, a.x, a.y, a.z);
        if (p[2] > 0) place(a.text, p[0], p[1], { pill: true, color: a.color ?? ink() });
      }
    let shown = 0;
    if (!far && selected < 0)
      for (const i of bySize) {
        if (shown > 28) break;
        if (state[i] === 0 || i === selected || i === hover) continue;
        project(i, p);
        if (p[2] <= 0 || p[3] < 5.5 || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
        const before = taken.length;
        place(data.label(i), p[0] + p[3] + 4, p[1]);
        if (taken.length > before) shown++;
      }
  }

  let lastT = performance.now(),
    frameN = 0;
  function frame(t) {
    if (destroyed) return;
    const dt = Math.min(64, t - lastT);
    lastT = t;
    if (view.autoRotate && t > idleAt && !touches.size && goal.flat === 1) goal.yaw += dt * 0.00004;
    const k = 1 - Math.exp(-dt / 140);
    for (const key of ["yaw", "pitch", "dist", "tx", "ty", "tz", "flat"]) cam[key] += (goal[key] - cam[key]) * k;
    updateMatrix();
    if (pointer && !touches.size && frameN % 2 === 0) {
      const next = pick(pointer[0], pointer[1]);
      if (next !== hover) {
        hover = next;
        canvas.style.cursor = next >= 0 ? "pointer" : "grab";
        view.onHover(next, pointer);
      }
    } else if (!pointer && hover !== -1) {
      hover = -1;
      view.onHover(-1);
    }

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
    gl.uniform1f(lines.u.uAlpha, ((dark ? 0.075 : 0.09) + zoom * 0.12) * view.edgeScale);
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
    gl.uniform1f(points.u.uPx, px);
    gl.uniform1f(points.u.uFlat, cam.flat);
    gl.uniform1f(points.u.uDim, dark ? 0.16 : 0.18);
    gl.uniform1f(points.u.uMinPx, 2.0 * dpr);
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
        pSize[i] = q.size ?? 9;
      }
      gl.bindVertexArray(pvao);
      gl.bindBuffer(gl.ARRAY_BUFFER, pPosBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pPos, 0, count * 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, pColBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pCol, 0, count * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, pSizeBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pSize, 0, count);
      gl.uniform1f(points.u.uMinPx, 5 * dpr);
      gl.drawArrays(gl.POINTS, 0, count);
    }
    gl.bindVertexArray(null);
    drawLabels();
    view.onFrame(dt, t);
    frameN++;
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return view;
}
