"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, MotionConfig, useInView, useMotionTemplate, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform, type HTMLMotionProps, type MotionValue } from "motion/react";
import { cn } from "@/lib/utils";

// Setra's motion language: calm, physical and brief. Things arrive (fade + rise), respond to the
// pointer with a little depth, and numbers settle into place. Nothing loops loudly or blocks input,
// and everything turns off with the system "reduce motion" setting (MotionConfig reducedMotion="user").

export const EASE = [0.32, 0.72, 0, 1] as const;
export const SPRING = { type: "spring", stiffness: 260, damping: 30, mass: 0.9 } as const;

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.5, ease: EASE }}>
      {children}
    </MotionConfig>
  );
}

/** Fades and rises into place the first time it scrolls into view. */
export function Reveal({ children, delay = 0, y = 24, blur = true, className, amount = 0.25, ...rest }: { children: ReactNode; delay?: number; y?: number; blur?: boolean; className?: string; amount?: number } & Omit<HTMLMotionProps<"div">, "children">) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y, filter: blur ? "blur(8px)" : "blur(0px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, amount }}
      transition={{ duration: 0.8, ease: EASE, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

const staggerParent = (gap: number, delay: number) => ({ hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: delay } } });
const staggerChild = { hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } } };

/** Children marked with <StaggerItem> arrive one after another. `onView` waits until visible. */
export function Stagger({ children, className, gap = 0.07, delay = 0, onView = true, ...rest }: { children: ReactNode; className?: string; gap?: number; delay?: number; onView?: boolean } & Omit<HTMLMotionProps<"div">, "children">) {
  return (
    <motion.div
      className={className}
      variants={staggerParent(gap, delay)}
      initial="hidden"
      {...(onView ? { whileInView: "show", viewport: { once: true, amount: 0.2 } } : { animate: "show" })}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className, ...rest }: { children: ReactNode; className?: string } & Omit<HTMLMotionProps<"div">, "children">) {
  return (
    <motion.div className={className} variants={staggerChild} {...rest}>
      {children}
    </motion.div>
  );
}

/**
 * Gives a card real depth: it tilts toward the pointer in 3D, with a soft light sheen following
 * the cursor. Mouse/trackpad only; touch and reduced motion get a flat, still card.
 */
export function Tilt({ children, className, max = 8, glare = true, scale = 1.015 }: { children: ReactNode; className?: string; max?: number; glare?: boolean; scale?: number }) {
  const reduce = useReducedMotion();
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const hover = useMotionValue(0);
  const cfg = { stiffness: 180, damping: 22, mass: 0.6 };
  const rotateX = useSpring(useTransform(py, [0, 1], [max, -max]), cfg);
  const rotateY = useSpring(useTransform(px, [0, 1], [-max, max]), cfg);
  const s = useSpring(useTransform(hover, [0, 1], [1, scale]), cfg);
  const glareOpacity = useSpring(useTransform(hover, [0, 1], [0, 1]), cfg);
  const gx = useTransform(px, (v) => `${v * 100}%`);
  const gy = useTransform(py, (v) => `${v * 100}%`);
  const sheen = useMotionTemplate`radial-gradient(420px circle at ${gx} ${gy}, rgba(255,255,255,0.22), transparent 55%)`;

  if (reduce) return <div className={className}>{children}</div>;
  return (
    <div className="[perspective:1100px]">
      <motion.div
        className={cn("relative [transform-style:preserve-3d] will-change-transform", className)}
        style={{ rotateX, rotateY, scale: s }}
        onPointerMove={(e) => {
          if (e.pointerType === "touch") return;
          const r = e.currentTarget.getBoundingClientRect();
          px.set((e.clientX - r.left) / r.width);
          py.set((e.clientY - r.top) / r.height);
          hover.set(1);
        }}
        onPointerLeave={() => {
          px.set(0.5);
          py.set(0.5);
          hover.set(0);
        }}
      >
        {children}
        {glare && <motion.div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] mix-blend-soft-light" style={{ background: sheen, opacity: glareOpacity }} />}
      </motion.div>
    </div>
  );
}

/** A slow, barely-there float, like an object resting on water. */
export function Float({ children, className, amplitude = 8, duration = 7, delay = 0, rotate = 0 }: { children: ReactNode; className?: string; amplitude?: number; duration?: number; delay?: number; rotate?: number }) {
  return (
    <motion.div
      className={className}
      animate={{ y: [0, -amplitude, 0], rotateZ: rotate ? [0, rotate, 0] : 0 }}
      transition={{ duration, delay, repeat: Infinity, ease: "easeInOut" }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Rises into view with perspective as the page scrolls toward it (the product "lifting" into place),
 * scrubbed by scroll position rather than a one-off animation.
 */
export function ScrollLift({ children, className, from = 16 }: { children: ReactNode; className?: string; from?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "center center"] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [from, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.94, 1]);
  const opacity = useTransform(scrollYProgress, [0, 0.35], [0.4, 1]);
  return (
    <div ref={ref} className="[perspective:1200px]">
      <motion.div className={cn("origin-bottom", className)} style={{ rotateX, scale, opacity }}>
        {children}
      </motion.div>
    </div>
  );
}

/**
 * A number that counts up to its value when first visible, and glides to new values after that.
 * `format` renders the in-between values (money, counts), so the final text is exactly `format(value)`.
 */
export function CountUp({ value, format, className, duration = 1.1 }: { value: number; format: (n: number) => ReactNode; className?: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduce = useReducedMotion();
  const mv = useMotionValue(0);
  const [display, setDisplay] = useState<number | null>(null);
  const shown = useRef(false);
  useEffect(() => mv.on("change", setDisplay), [mv]);
  // Start from zero before the first paint on the client, so the count never flashes the final value.
  useLayoutEffect(() => {
    if (!reduce && !shown.current) setDisplay(0);
  }, [reduce]);
  useEffect(() => {
    if (!inView) return;
    // Nothing to watch (reduced motion, or a background tab where animations are paused): show the value.
    if (reduce || document.visibilityState !== "visible") {
      setDisplay(value);
      shown.current = true;
      return;
    }
    const controls = animate(mv, value, { duration: shown.current ? 0.6 : duration, ease: EASE, onComplete: () => setDisplay(value) });
    shown.current = true;
    return () => controls.stop();
  }, [inView, value, reduce, duration, mv]);
  // Server render and first paint show the real value (no layout shift, correct for no-JS/SEO);
  // the count starts from zero only once the number is actually on screen.
  return (
    <span ref={ref} className={className}>
      {/* Assistive tech and page readers always get the real figure; the counting digits are decoration. */}
      <span className="sr-only">{format(value)}</span>
      <span aria-hidden="true">{format(display ?? value)}</span>
    </span>
  );
}

/** Slides in from one side with a slight 3D turn, like a card being placed on a table. */
export function SlideIn({ children, from = "left", className, delay = 0 }: { children: ReactNode; from?: "left" | "right"; className?: string; delay?: number }) {
  const dir = from === "left" ? -1 : 1;
  return (
    <div className={cn("[perspective:1200px]", className)}>
      <motion.div
        className="h-full"
        initial={{ opacity: 0, x: 48 * dir, rotateY: -14 * dir }}
        whileInView={{ opacity: 1, x: 0, rotateY: 0 }}
        viewport={{ once: true, amount: 0.35 }}
        transition={{ duration: 0.9, ease: EASE, delay }}
      >
        {children}
      </motion.div>
    </div>
  );
}

/** Pops in with a spring once visible (small icons, badges, arrows). */
export function Pop({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, scale: 0.6 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true, amount: 0.6 }} transition={{ ...SPRING, delay }}>
      {children}
    </motion.div>
  );
}

/** CountUp with plain props, usable from server components: prefix + rounded number + suffix. */
export function CountTo({ value, prefix = "", suffix = "", decimals = 0, className }: { value: number; prefix?: string; suffix?: string; decimals?: number; className?: string }) {
  return <CountUp value={value} className={className} format={(n) => `${prefix}${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`} />;
}

/** Wraps a route's content so each page arrives with a short fade and rise. */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: EASE }}>
      {children}
    </motion.div>
  );
}

export { motion, AnimatePresence, LayoutGroup } from "motion/react";
