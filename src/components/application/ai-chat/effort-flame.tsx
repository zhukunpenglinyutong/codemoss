"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

/**
 * Max-effort celebration for the effort slider (used by cli-menu):
 * a WebGL rocket-exhaust flame shader over a parallax starfield, with a
 * canvas pixel-noise fallback when WebGL is unavailable. Pure visual
 * effect — no props, no state shared with the slider.
 */

/* ------------------------------------------------- max-effort flame shader */

const FLAME_VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/**
 * Procedural blue rocket-exhaust plume: fbm turbulence advected right-to-left,
 * with a white-hot core at the nozzle (right edge) cooling through blue-300 →
 * blue-600 as it dissolves toward the left, plus a soft ambient glow.
 */
const FLAME_FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_power; // 0 -> 1 throttle-up after ignition

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.1 + vec2(37.4, 17.9);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float d = 1.0 - uv.x;            // 0 at the nozzle (right) -> 1 far left
  float y = (uv.y - 0.5) * 2.0;    // -1 bottom .. 1 top

  // Turbulence blown leftward; second octave wobbles the plume axis
  float turb = fbm(vec2(uv.x * 5.5 + u_time * 3.2, uv.y * 3.5 + u_time * 0.4)) - 0.5;
  float sway = (fbm(vec2(u_time * 1.6, uv.x * 2.0)) - 0.5) * 0.55;

  // Plume envelope: wide at the nozzle, tapering left, edges licked by noise.
  // Throttle (u_power) grows the plume from a short narrow jet to full burn.
  float width = mix(1.05, 0.12, smoothstep(0.0, 1.0, d)) * mix(0.35, 1.0, u_power);
  float reach = mix(0.18, 1.05, u_power);
  float shape = 1.0 - smoothstep(width * 0.35, width, abs(y + sway * d + turb * (0.35 + d * 0.9)));
  float len = 1.0 - smoothstep(0.15 * u_power, reach, d + turb * 0.45 * u_power);
  float flame = clamp(shape * len, 0.0, 1.0);

  // Extra hot core hugging the nozzle centre line
  float core = (1.0 - smoothstep(0.0, 0.38 * mix(0.5, 1.0, u_power), d + turb * 0.15)) * (1.0 - smoothstep(0.0, 0.55, abs(y)));
  flame = clamp(flame + core * 0.6, 0.0, 1.0) * mix(0.6, 1.0, u_power);

  // Ambient glow so the flame feels emissive even past its tongues
  float glow = (1.0 - smoothstep(0.0, 0.85, d)) * (1.0 - smoothstep(0.2, 1.15, abs(y))) * 0.4 * u_power;

  // blue-600 -> blue-400 -> blue-200 -> white-hot. The white core is gated on
  // nozzle distance too, so only the plume root burns white and the body
  // stays saturated blue.
  vec3 c600 = vec3(0.082, 0.365, 0.988);
  vec3 c400 = vec3(0.318, 0.635, 1.0);
  vec3 c200 = vec3(0.741, 0.867, 1.0);
  vec3 col = mix(c600, c400, smoothstep(0.2, 0.6, flame));
  col = mix(col, c200, smoothstep(0.62, 0.95, flame) * (1.0 - smoothstep(0.1, 0.75, d)));
  float hot = smoothstep(0.9, 1.0, flame) * (1.0 - smoothstep(0.02, 0.3, d));
  col = mix(col, vec3(1.0), hot);

  float alpha = smoothstep(0.04, 0.55, flame) * 0.96 + glow;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

/**
 * Parallax starfield behind the flame: three depth layers of tiny stars
 * streaming right-to-left at different speeds (near = faster + brighter +
 * stretched into streaks), plus the occasional fast shooting star.
 */
function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    interface Star {
      x: number;
      y: number;
      speed: number; // px/s leftward
      size: number;
      alpha: number;
    }

    // depth: 0 far … 1 near — near stars are faster, larger, brighter
    const makeStar = (spawnAnywhere: boolean): Star => {
      const depth = Math.random();
      return {
        x: spawnAnywhere ? Math.random() * width : width + 4,
        y: 1 + Math.random() * (height - 2),
        speed: 18 + depth * 90,
        size: 0.6 + depth * 1.0,
        alpha: 0.4 + depth * 0.55,
      };
    };
    const stars: Star[] = Array.from({ length: 40 }, () => makeStar(true));

    let shooting: (Star & { life: number }) | null = null;

    let raf = 0;
    let last = performance.now();
    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      ctx.clearRect(0, 0, width, height);

      for (const star of stars) {
        star.x -= star.speed * dt;
        if (star.x < -6) Object.assign(star, makeStar(false));
        // motion streak: length scales with speed so near stars smear
        const streak = star.speed * 0.05;
        const grad = ctx.createLinearGradient(star.x, star.y, star.x + streak, star.y);
        grad.addColorStop(0, `rgba(255,255,255,${star.alpha.toFixed(3)})`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(star.x, star.y - star.size / 2, streak + star.size, star.size);
      }

      // ~ every 2.5s launch a shooting star: long bright streak, fades out
      if (!shooting && Math.random() < dt / 2.5) {
        shooting = { ...makeStar(false), speed: 260 + Math.random() * 120, size: 1.2, alpha: 0.9, life: 1 };
      }
      if (shooting) {
        shooting.x -= shooting.speed * dt;
        shooting.life -= dt * 0.9;
        if (shooting.x < -40 || shooting.life <= 0) {
          shooting = null;
        } else {
          const len = 26;
          const a = shooting.alpha * Math.max(shooting.life, 0);
          const grad = ctx.createLinearGradient(shooting.x, shooting.y, shooting.x + len, shooting.y);
          grad.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
          grad.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(shooting.x, shooting.y - 0.6, len, 1.2);
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full" />;
}

/**
 * Shader-style "pixelation" fallback when WebGL is unavailable: a dense
 * field of blue pixels burns at the right edge and dissolves toward the
 * left — cell density and opacity both fall off with distance. ~12fps.
 */
function PixelationOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const cell = 3;
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    // Blue noise palette (blue-300 → blue-600)
    const palette = [
      [142, 197, 255], // blue-300
      [81, 162, 255], // blue-400
      [43, 127, 255], // blue-500
      [21, 93, 252], // blue-600
    ];

    let raf = 0;
    let last = 0;
    const draw = (time: number) => {
      if (time - last > 70) {
        last = time;
        ctx.clearRect(0, 0, width, height);
        for (let col = 0; col < cols; col++) {
          // 0 at the left edge → 1 at the right edge: dense at the right,
          // dissolving out toward the left. Capped below 1 so even the
          // rightmost cells keep flickering instead of reading as solid.
          const t = col / (cols - 1);
          const density = 0.78 * Math.pow(t, 1.6);
          for (let row = 0; row < rows; row++) {
            if (Math.random() < density) {
              const [r, g, b] = palette[(Math.random() * palette.length) | 0];
              // Fully random alpha per cell per frame keeps the field alive
              const alpha = (0.15 + Math.random() * 0.85) * (0.35 + 0.65 * t);
              ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
              ctx.fillRect(col * cell, row * cell, cell - 1, cell - 1);
            }
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0"
    >
      {/* accent-300 wash bleeding in from the right, under the pixel noise */}
      <div className="absolute inset-0 bg-gradient-to-l from-accent-300/90 via-accent-300/30 to-transparent" />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </motion.div>
  );
}

/**
 * Compiles the flame shaders and links them into a WebGL program.
 * Returns null when linking fails (the caller falls back to the pixel
 * overlay). Pure with respect to React: everything it touches lives on `gl`.
 */
function createFlameProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, FLAME_VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FLAME_FRAG));
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

/**
 * WebGL flame overlay shown when the slider hits max: a blue rocket-engine
 * exhaust plume firing right-to-left across the track (see FLAME_FRAG),
 * over a parallax starfield streaming past. Falls back to the pixel-noise
 * overlay if a WebGL context can't be created.
 */
export function FlameOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
    if (!gl) {
      setWebglFailed(true);
      return;
    }

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);

    const program = createFlameProgram(gl);
    if (!program) {
      setWebglFailed(true);
      return;
    }
    gl.useProgram(program);

    // Full-screen triangle strip quad
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(gl.getUniformLocation(program, "u_res"), canvas.width, canvas.height);
    const uTime = gl.getUniformLocation(program, "u_time");
    const uPower = gl.getUniformLocation(program, "u_power");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let raf = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const elapsed = (now - start) / 1000;
      gl.uniform1f(uTime, elapsed);
      // Throttle up over ~1.4s with an ease-out so the burn builds gradually
      const t = Math.min(elapsed / 1.4, 1);
      gl.uniform1f(uPower, 1 - Math.pow(1 - t, 3));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    // No loseContext() here: React strict-mode re-runs the effect on the same
    // canvas, and a deliberately-lost context would poison the second run.
    // The context is reclaimed with the canvas when the overlay unmounts.
    return () => cancelAnimationFrame(raf);
  }, []);

  if (webglFailed) return <PixelationOverlay />;

  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0"
    >
      {/* faint dark space wash so the white stars read on the grey track
          (fixed palette in both themes — the flame shader's is fixed too) */}
      <div className="absolute inset-0 rounded-lg bg-effort-flame-wash" />
      <Starfield />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </motion.div>
  );
}
