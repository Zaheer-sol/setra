"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue, type TargetAndTransition, type Transition } from "motion/react";
import { cn } from "@/lib/utils";
import { SETI_ART } from "./seti-eyes";

// Seti, Setra's mascot. Official renders live in docs/brand/seti/; scripts/prepare-seti.py makes the
// web images (public/seti/) and finds the eyes (seti-eyes.ts) so Seti can blink.
//
// Seti stays grounded: no bouncing. It breathes, sways gently from its feet, blinks now and then,
// its eyes drift continuously (toward the pointer when it moves) and it turns a little toward the
// pointer. Everything stops with the system "Reduce motion" setting.
// Use one Seti per view, where a friendly face helps; never on the merchant's customer payment page.

export type SetiMood = "welcome" | "focused" | "success" | "curious" | "attention" | "resting";

const ALT: Record<SetiMood, string> = {
  welcome: "Seti, the Setra mascot, waving hello",
  focused: "Seti, the Setra mascot, concentrating",
  success: "Seti, the Setra mascot, celebrating",
  curious: "Seti, the Setra mascot, looking curious",
  attention: "Seti, the Setra mascot, pointing something out",
  resting: "Seti, the Setra mascot, resting contentedly"
};

// Idle motion per mood: breathing (scale from the feet) plus a slow sway. Never vertical travel.
const IDLE: Record<SetiMood, { animate: TargetAndTransition; transition: Transition }> = {
  welcome: { animate: { rotate: [0, -2.2, 0, 1.6, 0], scaleY: [1, 1.012, 1, 1.012, 1] }, transition: { duration: 5, repeat: Infinity, ease: "easeInOut" } },
  focused: { animate: { rotate: [0, -0.8, 0], scaleY: [1, 1.01, 1] }, transition: { duration: 4.6, repeat: Infinity, ease: "easeInOut" } },
  success: { animate: { rotate: [0, -2.5, 2.5, -1.5, 0, 0], scaleY: [1, 1.015, 1, 1.015, 1, 1] }, transition: { duration: 3.2, repeat: Infinity, repeatDelay: 1.2, ease: "easeInOut" } },
  curious: { animate: { rotate: [0, -3, -3, 0, 0], scaleY: [1, 1.01, 1.01, 1, 1] }, transition: { duration: 7, repeat: Infinity, ease: "easeInOut", times: [0, 0.25, 0.55, 0.8, 1] } },
  attention: { animate: { rotate: [0, 1.2, 0, -1.2, 0], scaleY: [1, 1.01, 1, 1.01, 1] }, transition: { duration: 5.5, repeat: Infinity, ease: "easeInOut" } },
  resting: { animate: { scaleY: [1, 1.022, 1], scaleX: [1, 0.992, 1] }, transition: { duration: 5.2, repeat: Infinity, ease: "easeInOut" } }
};

/** Blinks every few seconds, sometimes twice, like a person would. */
function useBlink(enabled: boolean) {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const blink = (then: () => void) => {
      setClosed(true);
      timer = setTimeout(() => {
        if (!alive) return;
        setClosed(false);
        then();
      }, 130);
    };
    const schedule = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        const twice = Math.random() < 0.22;
        blink(() => (twice ? (timer = setTimeout(() => alive && blink(schedule), 180)) : schedule()));
      }, 2400 + Math.random() * 3600);
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [enabled]);
  return closed;
}


// How each mood's eyes drift when nobody is pointing at anything: a resting point (bias) and how far
// they roam around it (amp), in -1..1 of the eyes' travel. The path loops smoothly and never stops.
const DRIFT: Record<SetiMood, { bias: [number, number]; amp: [number, number]; speed: number }> = {
  welcome: { bias: [0, 0], amp: [0.55, 0.3], speed: 1 },
  focused: { bias: [0, 0.6], amp: [0.65, 0.12], speed: 1.25 }, // reading along a line
  curious: { bias: [0.3, -0.5], amp: [0.6, 0.35], speed: 0.9 },
  attention: { bias: [0.45, -0.1], amp: [0.45, 0.2], speed: 0.8 }, // between you and what it points at
  success: { bias: [0, 0], amp: [0, 0], speed: 0 },
  resting: { bias: [0, 0], amp: [0, 0], speed: 0 }
};

/**
 * Seti's gaze, moving continuously. When idle, the eyes glide along a slow looping path that suits
 * the mood; when the pointer moves, they glide toward it and blend back into the drift once it
 * stops. Pauses when Seti is off screen or the tab is hidden. Returns values in -1..1.
 */
function useGaze(ref: RefObject<HTMLElement | null>, mood: SetiMood, enabled: boolean): { gx: MotionValue<number>; gy: MotionValue<number> } {
  const tx = useMotionValue(0);
  const ty = useMotionValue(0);
  // Soft springs on top of a smooth target: gliding, never jumping.
  const gx = useSpring(tx, { stiffness: 90, damping: 20, mass: 0.8 });
  const gy = useSpring(ty, { stiffness: 90, damping: 20, mass: 0.8 });
  useEffect(() => {
    if (!enabled) {
      tx.set(0);
      ty.set(0);
      return;
    }
    const drift = DRIFT[mood];
    // Each Seti starts at a different point on its path, so several on a page don't move in sync.
    const phase = [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28];
    let pointer: { x: number; y: number } | null = null;
    let lastPointer = 0;
    let follow = 0; // 0 = drifting, 1 = following the pointer
    let visible = true;
    let frame = 0;
    let prev = performance.now();

    const tick = (now: number) => {
      frame = 0;
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      const t = (now / 1000) * drift.speed * 1.6;
      // Two slow waves per axis make a looping path that doesn't feel mechanical.
      const wx = drift.bias[0] + drift.amp[0] * (0.62 * Math.sin(t * 0.55 + phase[0]!) + 0.38 * Math.sin(t * 0.93 + phase[1]!));
      const wy = drift.bias[1] + drift.amp[1] * (0.6 * Math.sin(t * 0.47 + phase[2]!) + 0.4 * Math.sin(t * 0.81 + phase[3]!));
      const active = pointer !== null && now - lastPointer < 2500;
      follow += ((active ? 1 : 0) - follow) * Math.min(1, dt * (active ? 6 : 1.5));
      let x = wx;
      let y = wy;
      if (pointer && follow > 0.001) {
        const el = ref.current;
        if (el) {
          const r = el.getBoundingClientRect();
          const reach = Math.max(160, r.width * 2.2);
          // A little of the drift stays in, so even a fixed look is alive.
          const px = Math.max(-1, Math.min(1, (pointer.x - (r.left + r.width / 2)) / reach)) + (wx - drift.bias[0]) * 0.15;
          const py = Math.max(-1, Math.min(1, (pointer.y - (r.top + r.height * 0.4)) / reach)) + (wy - drift.bias[1]) * 0.15;
          x = wx + (px - wx) * follow;
          y = wy + (py - wy) * follow;
        }
      }
      tx.set(Math.max(-1, Math.min(1, x)));
      ty.set(Math.max(-1, Math.min(1, y)));
      if (visible && document.visibilityState === "visible") frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!frame && visible && document.visibilityState === "visible") {
        prev = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      pointer = { x: e.clientX, y: e.clientY };
      lastPointer = performance.now();
    };
    const onLeave = () => {
      pointer = null;
    };
    const observer = typeof IntersectionObserver !== "undefined" && ref.current
      ? new IntersectionObserver(([entry]) => {
          visible = !!entry?.isIntersecting;
          if (visible) start();
        })
      : null;
    if (observer && ref.current) observer.observe(ref.current);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", start);
    start();
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", start);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, mood, ref, tx, ty]);
  return { gx, gy };
}

export function Seti({
  mood = "welcome",
  size = 120,
  className,
  decorative = true,
  idle = true,
  enter = true,
  priority = false
}: {
  mood?: SetiMood;
  /** Height in px. */
  size?: number;
  className?: string;
  /** Decorative by default (hidden from screen readers); pass false when Seti carries meaning. */
  decorative?: boolean;
  /** Breathing, swaying and blinking. */
  idle?: boolean;
  /** Fade in when first visible. */
  enter?: boolean;
  /** Load eagerly (above-the-fold placements). */
  priority?: boolean;
}) {
  const reduce = useReducedMotion();
  const alive = idle && !reduce;
  const art = SETI_ART[mood];
  const width = Math.round((size * art.w) / art.h);
  const closed = useBlink(alive && art.eyes.length > 0);
  const root = useRef<HTMLDivElement>(null);
  const { gx, gy } = useGaze(root, mood, alive && art.eyes.length > 0);
  // How far the eyes can travel, in px: a fraction of the eye's own size so they stay in their sockets.
  const eyeW = (art.eyes[0]?.w ?? 0) * width;
  const eyeH = (art.eyes[0]?.h ?? 0) * size;
  const ex = useTransform(gx, (v) => v * eyeW * 0.3);
  const ey = useTransform(gy, (v) => v * eyeH * 0.22);

  // A gentle 3D turn toward the pointer.
  const px = useMotionValue(0);
  const turn = useSpring(useTransform(px, [-1, 1], [-14, 14]), { stiffness: 120, damping: 18 });
  const lean = useSpring(useTransform(px, [-1, 1], [1.5, -1.5]), { stiffness: 120, damping: 18 });

  return (
    <motion.div
      ref={root}
      className={cn("relative inline-block shrink-0 select-none [perspective:700px]", className)}
      style={{ width, height: size }}
      initial={enter ? { opacity: 0, scale: 0.94 } : false}
      whileInView={enter ? { opacity: 1, scale: 1 } : undefined}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.6, ease: [0.32, 0.72, 0, 1] }}
      aria-hidden={decorative || undefined}
      onPointerMove={(e) => {
        if (reduce || e.pointerType === "touch") return;
        const r = e.currentTarget.getBoundingClientRect();
        px.set(((e.clientX - r.left) / r.width) * 2 - 1);
      }}
      onPointerLeave={() => px.set(0)}
    >
      {/* Soft contact shadow; it breathes with Seti. */}
      <motion.span
        aria-hidden="true"
        className="absolute bottom-[0.5%] left-1/2 h-[6%] w-[60%] -translate-x-1/2 rounded-[50%] bg-black/16 blur-[5px] dark:bg-black/55"
        animate={alive ? { scaleX: [1, 0.97, 1], opacity: [1, 0.85, 1] } : undefined}
        transition={IDLE[mood].transition}
      />
      <motion.div className="relative h-full w-full [transform-style:preserve-3d]" style={{ rotateY: reduce ? 0 : turn, rotateZ: reduce ? 0 : lean }}>
        <motion.div className="relative h-full w-full origin-bottom" animate={alive ? IDLE[mood].animate : undefined} transition={IDLE[mood].transition}>
          <img
            src={`/seti/${mood}.webp`}
            alt={decorative ? "" : ALT[mood]}
            width={width}
            height={size}
            draggable={false}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            className="h-full w-full object-contain"
          />
          {/* The eyes move: each drawn eye is covered with a soft patch of Seti's colour, and a copy of
              it (from the same image) is drawn on top and shifted. The lids move with the eyes. */}
          {alive &&
            art.eyes.map((e, i) => (
              <span
                key={`patch-${i}`}
                aria-hidden="true"
                className="absolute rounded-[50%]"
                style={{
                  left: `${(e.x - e.w * 0.14) * 100}%`,
                  top: `${(e.y - e.h * 0.1) * 100}%`,
                  width: `${e.w * 1.28 * 100}%`,
                  height: `${e.h * 1.2 * 100}%`,
                  background: e.lid,
                  boxShadow: `0 0 ${Math.max(1, e.w * width * 0.18)}px ${Math.max(0.5, e.w * width * 0.08)}px ${e.lid}`
                }}
              />
            ))}
          <motion.div aria-hidden="true" className="pointer-events-none absolute inset-0" style={alive ? { x: ex, y: ey } : undefined}>
            {alive &&
              art.eyes.map((e, i) => {
                // A slightly larger box than the eye, so its edge and highlight come along.
                const bx = e.x - e.w * 0.08;
                const by = e.y - e.h * 0.06;
                const bw = e.w * 1.16;
                const bh = e.h * 1.12;
                return (
                  <span
                    key={`eye-${i}`}
                    className="absolute rounded-[50%]"
                    style={{
                      left: `${bx * 100}%`,
                      top: `${by * 100}%`,
                      width: `${bw * 100}%`,
                      height: `${bh * 100}%`,
                      backgroundImage: `url(/seti/${mood}.webp)`,
                      backgroundSize: `${100 / bw}% ${100 / bh}%`,
                      backgroundPosition: `${(bx / (1 - bw)) * 100}% ${(by / (1 - bh)) * 100}%`,
                      backgroundRepeat: "no-repeat"
                    }}
                  />
                );
              })}
            {art.eyes.map((e, i) => {
              const eh = e.h * size;
              return (
                <span
                  key={i}
                  aria-hidden="true"
                  className="absolute origin-top rounded-[50%] transition-transform ease-out"
                  style={{
                    left: `${(e.x - e.w * 0.18) * 100}%`,
                    top: `${(e.y - e.h * 0.14) * 100}%`,
                    width: `${e.w * 1.36 * 100}%`,
                    height: `${e.h * 1.28 * 100}%`,
                    background: e.lid,
                    transform: `scaleY(${closed ? 1 : 0})`,
                    transitionDuration: closed ? "70ms" : "110ms"
                  }}
                >
                  {/* The closed eye: a soft downward curve, like Seti's resting face. */}
                  <span
                    className="absolute right-[6%] left-[6%] rounded-[50%] border-[#1d1d1f] transition-opacity"
                    style={{ top: "22%", height: "46%", borderBottomWidth: Math.max(1.2, eh * 0.12), borderBottomStyle: "solid", opacity: closed ? 1 : 0 }}
                  />
                </span>
              );
            })}
          </motion.div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
