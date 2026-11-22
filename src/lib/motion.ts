import { useReducedMotion } from 'motion/react';
import { useApp } from '../stores/app';

export const MOTION_EASE = {
  standard: [0.22, 1, 0.36, 1] as const,
  emphasized: [0.2, 0, 0, 1] as const,
  decelerate: [0, 0, 0.2, 1] as const,
  accelerate: [0.4, 0, 1, 1] as const,
};

export const MOTION_DURATION = {
  instant: 0.09,
  fast: 0.14,
  base: 0.18,
  page: 0.18,
  menu: 0.12,
  modal: 0.18,
  panel: 0.24,
  toast: 0.18,
} as const;

export function motionTransition(
  reduced: boolean,
  duration: number,
  ease: readonly [number, number, number, number] = MOTION_EASE.standard,
) {
  return {
    duration: reduced ? 0 : duration,
    ease,
  };
}

export function pageMotion(reduced: boolean) {
  return {
    initial: reduced ? (false as const) : { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    transition: motionTransition(reduced, MOTION_DURATION.page),
  };
}

export function menuMotion(reduced: boolean) {
  return {
    initial: reduced ? (false as const) : { opacity: 0, scale: 0.97, y: -4 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: reduced ? { opacity: 1 } : { opacity: 0, scale: 0.97, y: -4 },
    transition: motionTransition(reduced, MOTION_DURATION.menu),
  };
}

export function backdropMotion(reduced: boolean) {
  return {
    initial: reduced ? (false as const) : { opacity: 0 },
    animate: { opacity: 1 },
    exit: reduced ? { opacity: 1 } : { opacity: 0 },
    transition: motionTransition(reduced, MOTION_DURATION.fast),
  };
}

export function modalMotion(reduced: boolean) {
  return {
    initial: reduced ? (false as const) : { opacity: 0, scale: 0.97, y: 8 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: reduced ? { opacity: 1 } : { opacity: 0, scale: 0.97, y: 6 },
    transition: motionTransition(reduced, MOTION_DURATION.modal, MOTION_EASE.emphasized),
  };
}

export function drawerMotion(reduced: boolean, axis: 'x' | 'y' = 'y') {
  if (axis === 'x') {
    return {
      initial: reduced ? (false as const) : { opacity: 0, x: 16 },
      animate: { opacity: 1, x: 0 },
      exit: reduced ? { opacity: 1 } : { opacity: 0, x: 16 },
      transition: motionTransition(reduced, MOTION_DURATION.panel, MOTION_EASE.emphasized),
    };
  }
  return {
    initial: reduced ? (false as const) : { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    exit: reduced ? { opacity: 1 } : { opacity: 0, y: 18 },
    transition: motionTransition(reduced, MOTION_DURATION.panel, MOTION_EASE.emphasized),
  };
}

export function toastMotion(reduced: boolean) {
  return {
    initial: reduced ? (false as const) : { opacity: 0, y: 10, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: reduced ? { opacity: 1 } : { opacity: 0, y: 8, scale: 0.98 },
    transition: motionTransition(reduced, MOTION_DURATION.toast),
  };
}

export function useReducedUI(): boolean {
  const sys = useReducedMotion();
  const userOrPerf = useApp(
    s => Boolean(s.data.preferences.reducedMotion || s.data.preferences.performance),
  );
  return Boolean(sys || userOrPerf);
}
