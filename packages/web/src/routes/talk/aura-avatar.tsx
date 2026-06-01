/**
 * Jinn Talk — AURA voice avatar (Concept A, leveled up).
 *
 * A single emissive orb of warm amber "liquid light" that breathes, listens,
 * thinks, and speaks. Everything is rendered on ONE <canvas> under one rAF
 * loop (plasma core, drifting light blobs, specular highlight, reactive edge
 * ring, emanating ripples, a 48-bar listening equalizer, and a thinking arc)
 * so it stays razor-crisp on retina and is cheap to animate. State changes are
 * eased by springs (`useSpringValue`) so they feel physical, not linear.
 *
 * Design choices vs. the HTML reference prototype:
 *  - The DOM blobs + DOM orb + DOM ripples are all unified into the canvas:
 *    one paint pass, true `screen` compositing, devicePixelRatio-correct.
 *  - Numeric per-state targets (orb scale, glow, ring amplitude, saturation,
 *    blob energy, equalizer/arc/ripple intensity) are chased with springs so
 *    a state flip overshoots and settles like an Apple control.
 *  - `level` (real/simulated audio 0..1) drives the ring/equalizer/ripples in
 *    listening + speaking; if absent we synthesize a lively internal signal.
 *  - The orb plasma core stays fixed warm amber (it's a light SOURCE — looks
 *    right on both themes); the glow/ring/arc/equalizer tint off `--accent`.
 */
import { useEffect, useMemo, useRef } from "react"
import type { JSX } from "react"
import type { AvatarState } from "./types"
import {
  SPRING_PRESETS,
  useSpringValue,
  usePrefersReducedMotion,
} from "./motion"
import "./aura-avatar.css"

export interface AuraAvatarProps {
  state: AvatarState
  /** Real or simulated audio level 0..1. If omitted, generate internal idle motion. */
  level?: number
  /** Orb diameter wrapper in px. Default 340. */
  size?: number
  className?: string
}

// ---------------------------------------------------------------------------
// Fixed warm-amber plasma palette (the orb is an emissive light source).
// ---------------------------------------------------------------------------
const CORE = {
  hi: "#FFD27A", // specular / highlight
  mid: "#E0A33C", // amber body
  low: "#9a6a1f", // shaded body
  deep: "#5e3f12", // terminator / inner shadow
  bloom: "#FFE7B0", // hottest blob center
} as const

interface RGB {
  r: number
  g: number
  b: number
}

function parseColor(input: string): RGB {
  const s = input.trim()
  if (s.startsWith("#")) {
    const hex = s.slice(1)
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex
    const n = parseInt(full.slice(0, 6), 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const m = s.match(/(-?\d*\.?\d+)/g)
  if (m && m.length >= 3) {
    return { r: +m[0], g: +m[1], b: +m[2] }
  }
  return { r: 224, g: 163, b: 60 } // sensible amber fallback
}

const rgba = (c: RGB, a: number) => `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`

/** Per-state targets the springs chase. Tuned so transitions feel alive. */
interface StateTargets {
  scale: number // orb breathing amplitude carrier (multiplier baseline)
  glow: number // outer glow opacity 0..1
  glowScale: number // outer glow scale
  ring: number // edge-ring amplitude scalar
  sat: number // plasma saturation/brightness
  blob: number // blob drift energy
  equalizer: number // listening bars intensity 0..1
  arc: number // thinking arc intensity 0..1
  ripple: number // ripple emission rate scalar 0..1
}

function targetsFor(state: AvatarState): StateTargets {
  switch (state) {
    case "listening":
      return {
        scale: 1.0,
        glow: 0.82,
        glowScale: 1.08,
        ring: 1.0,
        sat: 1.14,
        blob: 1.35,
        equalizer: 1,
        arc: 0,
        ripple: 1,
      }
    case "thinking":
      return {
        scale: 1.0,
        glow: 0.5,
        glowScale: 1.0,
        ring: 0.55,
        sat: 1.28,
        blob: 1.9,
        equalizer: 0,
        arc: 1,
        ripple: 0,
      }
    case "speaking":
      return {
        scale: 1.0,
        glow: 0.95,
        glowScale: 1.12,
        ring: 1.2,
        sat: 1.16,
        blob: 1.7,
        equalizer: 0,
        arc: 0,
        ripple: 1,
      }
    case "idle":
    default:
      return {
        scale: 1.0,
        glow: 0.5,
        glowScale: 1.0,
        ring: 0.4,
        sat: 1.0,
        blob: 1.0,
        equalizer: 0,
        arc: 0,
        ripple: 0,
      }
  }
}

export function AuraAvatar({
  state,
  level,
  size = 340,
  className,
}: AuraAvatarProps): JSX.Element {
  const reduced = usePrefersReducedMotion()

  // --- Spring-chased per-state scalars ------------------------------------
  const t = useMemo(() => targetsFor(state), [state])
  const glow = useSpringValue(t.glow, SPRING_PRESETS.gentle)
  const glowScale = useSpringValue(t.glowScale, SPRING_PRESETS.snappy)
  const ring = useSpringValue(t.ring, SPRING_PRESETS.bouncy)
  const sat = useSpringValue(t.sat, SPRING_PRESETS.snappy)
  const blob = useSpringValue(t.blob, SPRING_PRESETS.snappy)
  const equalizer = useSpringValue(t.equalizer, SPRING_PRESETS.snappy)
  const arc = useSpringValue(t.arc, SPRING_PRESETS.snappy)
  const rippleRate = useSpringValue(t.ripple, SPRING_PRESETS.snappy)

  // Audio level → reactive spring (tight tracking). When `level` is omitted we
  // feed 0 here and synthesize internal motion inside the loop instead.
  const hasLevel = typeof level === "number"
  const levelSpring = useSpringValue(
    hasLevel ? Math.max(0, Math.min(1, level)) : 0,
    SPRING_PRESETS.reactive,
  )

  // Refs so the rAF loop reads the freshest spring values without re-binding.
  const live = useRef({
    glow,
    glowScale,
    ring,
    sat,
    blob,
    equalizer,
    arc,
    rippleRate,
    level: levelSpring,
    hasLevel,
    state,
    reduced,
  })
  live.current = {
    glow,
    glowScale,
    ring,
    sat,
    blob,
    equalizer,
    arc,
    rippleRate,
    level: levelSpring,
    hasLevel,
    state,
    reduced,
  }

  // Accent (theme) color — read once on mount for glow/ring/arc/equalizer.
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const accentRef = useRef<RGB>({ r: 224, g: 163, b: 60 })

  // --- Drive the CSS outer glow from springs (cheap GPU blur) -------------
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    el.style.setProperty("--aura-size", `${size}px`)
    const raw = getComputedStyle(el).getPropertyValue("--accent").trim()
    if (raw) {
      accentRef.current = parseColor(raw)
      el.style.setProperty("--aura-accent", raw)
    }
  }, [size])

  // Keep glow opacity/scale in sync each render (spring values change often).
  const glowStyle = useMemo(
    () => ({
      opacity: glow,
      transform: `scale(${glowScale})`,
    }),
    [glow, glowScale],
  )

  // ------------------------------------------------------------------------
  // The single rAF render loop.
  // ------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    // The reactive layers (ripples, equalizer, ring) emanate well past the orb,
    // so the canvas drawing space is HEADROOM× the orb footprint — the orb stays
    // the same visual size, but the rings have room to fully dissipate instead
    // of being clipped at the edge. The canvas is centered over the wrapper
    // (CSS), overflowing it symmetrically; it's transparent + pointer-events:none
    // so the extra room costs nothing in layout.
    const HEADROOM = 1.7
    const px = Math.round(size * HEADROOM)
    canvas.width = Math.round(px * dpr)
    canvas.height = Math.round(px * dpr)
    canvas.style.width = `${px}px`
    canvas.style.height = `${px}px`

    const CX = px / 2
    const CY = px / 2
    // Orb radius ~ 0.353 of the ORB footprint (`size`), not the padded canvas.
    const R = size * 0.3529
    // Rings fade to zero by this radius so they never touch the canvas edge.
    const maxRippleR = (px / 2) * 0.96

    const accent = accentRef.current
    const core = {
      hi: parseColor(CORE.hi),
      mid: parseColor(CORE.mid),
      low: parseColor(CORE.low),
      deep: parseColor(CORE.deep),
      bloom: parseColor(CORE.bloom),
    }

    // Persistent simulation state.
    let raf = 0
    let time = 0
    let breathePhase = 0
    let lastTs: number | null = null
    let smoothAmp = 0
    type Ripple = { r: number; a: number }
    const ripples: Ripple[] = []

    // Three plasma blobs with independent organic drift params.
    const blobs = [
      { baseX: -0.04, baseY: -0.08, rad: 0.47, sp: 0.9, ph: 0.0, col: core.bloom, amp: 0.13 },
      { baseX: 0.05, baseY: 0.04, rad: 0.38, sp: 0.72, ph: 2.1, col: core.mid, amp: 0.11 },
      { baseX: -0.02, baseY: 0.1, rad: 0.27, sp: 1.15, ph: 4.0, col: core.hi, amp: 0.1 },
    ]

    const draw = (now: number) => {
      const s = live.current
      const dtMs = lastTs == null ? 16 : Math.min(now - lastTs, 1000 / 30)
      lastTs = now
      const dt = dtMs / 1000
      const moving = !s.reduced

      // State-driven base speed for the internal clock.
      const speedByState =
        s.state === "speaking" ? 2.0 : s.state === "thinking" ? 1.7 : s.state === "listening" ? 1.25 : 0.85
      if (moving) time += dt * speedByState

      // --- Amplitude: real level if provided, else synthesized per state ---
      let ampTarget: number
      if (s.hasLevel) {
        ampTarget = s.level
      } else if (s.state === "listening") {
        ampTarget =
          0.35 +
          0.35 * Math.abs(Math.sin(time * 3.1)) +
          0.15 * (Math.sin(time * 11.3) * 0.5 + 0.5)
      } else if (s.state === "speaking") {
        ampTarget =
          0.25 + 0.5 * Math.abs(Math.sin(time * 7)) * Math.abs(Math.sin(time * 2.3))
      } else if (s.state === "thinking") {
        ampTarget = 0.12
      } else {
        ampTarget = 0.05
      }
      smoothAmp += (ampTarget - smoothAmp) * (moving ? 0.18 : 1)
      const amp = smoothAmp

      // Breathing: idle slow ~5.5s, speaking fast ~1.1s. Driven off the
      // dt-accumulated `breathePhase` (below) so a backgrounded tab can't jump.
      const breatheHz =
        s.state === "speaking" ? 1 / 1.1 : s.state === "listening" ? 1 / 2.6 : 1 / 5.5
      if (moving) breathePhase += dt * breatheHz * Math.PI * 2
      const breathe = moving
        ? 1 + 0.045 * (0.5 - 0.5 * Math.cos(breathePhase))
        : 1.0
      // Audio-coupled micro-pulse on top of the breath.
      const pulse = 1 + amp * 0.05
      const orbScale = breathe * pulse

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, px, px)

      // ===== 1. Emanating ripples (behind ring, listening + speaking) =====
      const rippleStart = R + R * 0.08
      if (moving && s.rippleRate > 0.05) {
        const emit = 0.05 * s.rippleRate * (0.6 + amp)
        if (Math.random() < emit) ripples.push({ r: rippleStart, a: 0.5 })
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const p = ripples[i]
        if (moving) p.r += R * 0.02
        // Fade smoothly to zero as the ring travels toward the canvas-safe edge,
        // so it always fully dissipates on-canvas (never a hard clipped cut).
        const prog = Math.min(1, (p.r - rippleStart) / (maxRippleR - rippleStart))
        p.a = 0.5 * Math.pow(1 - prog, 1.6)
        if (prog >= 1 || p.a <= 0.01) {
          ripples.splice(i, 1)
          continue
        }
        ctx.beginPath()
        ctx.arc(CX, CY, p.r, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(accent, p.a)
        ctx.lineWidth = Math.max(1, R * 0.016)
        ctx.stroke()
      }

      const rOrb = R * orbScale

      // ===== 2. Reactive wavy edge ring (the "voice" undulation) =====
      const ringAmp = s.ring * (0.4 + amp * 1.9)
      ctx.beginPath()
      const STEPS = 160
      for (let i = 0; i <= STEPS; i++) {
        const ang = (i / STEPS) * Math.PI * 2
        const disp =
          Math.sin(ang * 3 + time * 2) * (R * 0.047) +
          Math.sin(ang * 6 - time * 3) * (R * 0.031) +
          Math.sin(ang * 9 + time) * (R * 0.023)
        const rr = rOrb + R * 0.172 + disp * ringAmp
        const x = CX + Math.cos(ang) * rr
        const y = CY + Math.sin(ang) * rr
        if (i) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      }
      ctx.closePath()
      ctx.strokeStyle = rgba(core.hi, 0.22 + amp * 0.5)
      ctx.lineWidth = Math.max(1, R * 0.012)
      ctx.stroke()

      // ===== 3. Thinking: orbiting progress arc + trailing dot =====
      if (s.arc > 0.02) {
        const a0 = time * 2
        ctx.beginPath()
        ctx.arc(CX, CY, rOrb + R * 0.266, a0, a0 + 1.7)
        ctx.strokeStyle = rgba(core.hi, 0.85 * s.arc)
        ctx.lineWidth = Math.max(1.5, R * 0.023)
        ctx.lineCap = "round"
        ctx.stroke()
        // counter-orbiting accent dot for depth
        const da = -time * 1.4
        const dx = CX + Math.cos(da) * (rOrb + R * 0.266)
        const dy = CY + Math.sin(da) * (rOrb + R * 0.266)
        ctx.beginPath()
        ctx.arc(dx, dy, R * 0.03, 0, Math.PI * 2)
        ctx.fillStyle = rgba(accent, 0.9 * s.arc)
        ctx.fill()
      }

      // ===== 4. Listening: perimeter equalizer (48 bars) =====
      if (s.equalizer > 0.02) {
        const bars = 48
        const baseR = rOrb + R * 0.31
        ctx.lineCap = "round"
        ctx.lineWidth = Math.max(1.5, R * 0.019)
        for (let i = 0; i < bars; i++) {
          const ang = (i / bars) * Math.PI * 2
          const h =
            (R * 0.047 +
              Math.abs(Math.sin(time * 4 + i * 0.6)) * amp * (R * 0.36)) *
            s.equalizer
          const c = Math.cos(ang)
          const sn = Math.sin(ang)
          ctx.beginPath()
          ctx.moveTo(CX + c * baseR, CY + sn * baseR)
          ctx.lineTo(CX + c * (baseR + h), CY + sn * (baseR + h))
          ctx.strokeStyle = rgba(accent, (0.3 + amp * 0.5) * s.equalizer)
          ctx.stroke()
        }
      }

      // ===== 5. The orb body =====
      ctx.save()
      // Clip to the breathing orb circle so plasma stays contained.
      ctx.beginPath()
      ctx.arc(CX, CY, rOrb, 0, Math.PI * 2)
      ctx.clip()

      const bright = s.sat // brightness/sat scalar from spring

      // 5a. Radial plasma base (highlight offset toward upper-left).
      const grad = ctx.createRadialGradient(
        CX - rOrb * 0.24,
        CY - rOrb * 0.3,
        rOrb * 0.05,
        CX,
        CY,
        rOrb,
      )
      const b = Math.min(1.4, bright)
      grad.addColorStop(0, rgba({ r: core.hi.r * b, g: core.hi.g * b, b: core.hi.b * b }, 1))
      grad.addColorStop(0.34, rgba({ r: core.mid.r * b, g: core.mid.g * b, b: core.mid.b * b }, 1))
      grad.addColorStop(0.7, rgba(core.low, 1))
      grad.addColorStop(1, rgba(core.deep, 1))
      ctx.fillStyle = grad
      ctx.fillRect(CX - rOrb, CY - rOrb, rOrb * 2, rOrb * 2)

      // 5b. Drifting plasma light blobs (screen blend = additive light).
      ctx.globalCompositeOperation = "screen"
      const energy = s.blob
      for (const bl of blobs) {
        const drift = bl.amp * energy
        const ox =
          bl.baseX * rOrb +
          Math.sin(time * bl.sp + bl.ph) * rOrb * drift +
          Math.cos(time * bl.sp * 0.6 + bl.ph) * rOrb * drift * 0.5
        const oy =
          bl.baseY * rOrb +
          Math.cos(time * bl.sp * 0.8 + bl.ph) * rOrb * drift +
          Math.sin(time * bl.sp * 0.5 + bl.ph) * rOrb * drift * 0.5
        const bx = CX + ox
        const by = CY + oy
        // Subtle living radius pulse (stronger when speaking/thinking).
        const br = rOrb * bl.rad * (1 + 0.12 * Math.sin(time * bl.sp * 1.3 + bl.ph) * (energy - 0.6))
        const bg = ctx.createRadialGradient(bx, by, 0, bx, by, br)
        const ba = 0.85 * Math.min(1.3, bright)
        bg.addColorStop(0, rgba(bl.col, ba))
        bg.addColorStop(0.6, rgba(bl.col, ba * 0.28))
        bg.addColorStop(1, rgba(bl.col, 0))
        ctx.fillStyle = bg
        ctx.beginPath()
        ctx.arc(bx, by, br, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = "source-over"

      // 5c. Inner shadow for volume (bottom terminator) — multiply-ish vignette.
      const vig = ctx.createRadialGradient(
        CX,
        CY + rOrb * 0.32,
        rOrb * 0.45,
        CX,
        CY + rOrb * 0.25,
        rOrb * 1.05,
      )
      vig.addColorStop(0, "rgba(40,24,4,0)")
      vig.addColorStop(1, "rgba(28,16,2,0.62)")
      ctx.fillStyle = vig
      ctx.fillRect(CX - rOrb, CY - rOrb, rOrb * 2, rOrb * 2)

      // 5d. Specular highlight (glossy hot spot, upper-left).
      const spX = CX - rOrb * 0.32
      const spY = CY - rOrb * 0.38
      const sp = ctx.createRadialGradient(spX, spY, 0, spX, spY, rOrb * 0.5)
      sp.addColorStop(0, rgba(core.hi, 0.55 * Math.min(1.2, bright)))
      sp.addColorStop(0.5, rgba(core.bloom, 0.12))
      sp.addColorStop(1, "rgba(255,255,255,0)")
      ctx.globalCompositeOperation = "screen"
      ctx.fillStyle = sp
      ctx.beginPath()
      ctx.arc(spX, spY, rOrb * 0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = "source-over"

      ctx.restore() // un-clip

      // 5e. Crisp rim light around the orb edge for definition.
      ctx.beginPath()
      ctx.arc(CX, CY, rOrb, 0, Math.PI * 2)
      ctx.strokeStyle = rgba(core.hi, 0.18 + amp * 0.18)
      ctx.lineWidth = Math.max(1, R * 0.01)
      ctx.stroke()

      if (moving) {
        raf = requestAnimationFrame(draw)
      }
    }

    // Always paint at least one frame (covers reduced-motion static orb).
    raf = requestAnimationFrame(draw)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      lastTs = null
    }
    // Re-init the loop when size changes or motion preference flips. The loop
    // reads everything else (state, springs, level) live from `live.current`.
  }, [size, reduced])

  return (
    <div
      ref={wrapRef}
      className={className ? `aura ${className}` : "aura"}
      style={{ ["--aura-size" as string]: `${size}px` }}
      data-state={state}
      aria-hidden="true"
    >
      <div className="aura__glow" style={glowStyle} />
      <canvas ref={canvasRef} className="aura__canvas" />
    </div>
  )
}
