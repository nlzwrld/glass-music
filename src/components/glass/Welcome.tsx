import { useEffect, useState } from 'react';
import { LiquidHubLogo } from '../brand/LiquidHubLogo';
import { motion, useReducedMotion } from 'motion/react';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../../../shared/auth';
import { useApp } from '../../stores/app';

export function greeting(hour: number) {
  return hour >= 5 && hour < 12 ? 'Bom dia' : hour >= 12 && hour < 18 ? 'Boa tarde' : 'Boa noite';
}

export default function Welcome() {
  const ready = useApp(s => s.ready),
    preferences = useApp(s => s.data.preferences);
  const [date] = useState(() => new Date());
  const [done, setDone] = useState(false),
    [leaving, setLeaving] = useState(false),
    [busy, setBusy] = useState(false);
  const phrase = greeting(date.getHours());
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const systemReduced = useReducedMotion(),
    reduced = preferences.reducedMotion || preferences.performance || systemReduced;
  const skipSplash = (preferences.uiStyle ?? 'matte') !== 'glass';

  useEffect(() => {
    if (!ready || !preferences.onboardingDone || done) return;
    if (skipSplash) {
      setDone(true);
      return;
    }
    const fade = setTimeout(() => setLeaving(true), reduced ? 120 : 620);
    const finish = setTimeout(() => setDone(true), reduced ? 160 : 920);
    return () => {
      clearTimeout(fade);
      clearTimeout(finish);
    };
  }, [ready, preferences.onboardingDone, done, reduced, skipSplash]);

  useEffect(() => {
    document.documentElement.dataset.starting = String(!done);
    return () => {
      delete document.documentElement.dataset.starting;
    };
  }, [done]);

  useEffect(() => {
    if (!ready || preferences.onboardingDone) return;
    const focus = setTimeout(
      () => document.querySelector<HTMLButtonElement>('.onboarding .primary')?.focus(),
      0,
    );
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const nodes = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.onboarding button:not(:disabled)'),
      );
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', trap);
    return () => {
      clearTimeout(focus);
      window.removeEventListener('keydown', trap);
    };
  }, [ready, preferences.onboardingDone]);

  const accept = async (online: boolean) => {
    setBusy(true);
    try {
      const next = {
        ...useApp.getState().data.preferences,
        onboardingDone: true,
        onlineConsent: online,
        catalogConsent: online,
        ...(online
          ? {
              termsVersion: CURRENT_TERMS_VERSION,
              privacyVersion: CURRENT_PRIVACY_VERSION,
              termsAcceptedAt: Date.now(),
            }
          : {}),
      };
      await window.glass.preferences(next);
      useApp.setState(s => ({ data: { ...s.data, preferences: next } }));
    } catch (error) {
      useApp.getState().message(String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return null;
  if (preferences.onboardingDone) {
    return done || skipSplash ? null : (
      <motion.div
        className="welcome-screen welcome-smooth"
        role="status"
        aria-label="Liquid Hub abertura"
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={{ duration: reduced ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.div
          className="welcome-content"
          initial={reduced ? false : { opacity: 0, y: 10, scale: 0.985 }}
          animate={{ opacity: leaving ? 0 : 1, y: leaving && !reduced ? -4 : 0, scale: 1 }}
          transition={{ duration: reduced ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="welcome-emblem">
            <LiquidHubLogo size={34} />
          </div>
          <h1>{phrase}</h1>
          <time>{time}</time>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <div className="modal-backdrop onboarding">
      <section
        className="modal onboarding-compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
      >
        <div className="onboarding-brand">
          <LiquidHubLogo size={24} />
          <span className="collection-type-label" style={{ margin: 0 }}>
            Liquid Hub
          </span>
        </div>
        <h2 id="welcome-title">Permitir acesso online?</h2>
        <p className="onboarding-hint">Para buscas, capas, letras e salas JAM.</p>
        <p className="onboarding-hint" style={{ fontSize: '0.78rem', opacity: 0.72, marginTop: -4 }}>
          Ao continuar online, você aceita os Termos e Privacidade (v{CURRENT_TERMS_VERSION}).
        </p>
        <div className="modal-actions">
          <button className="button secondary" disabled={busy} onClick={() => void accept(false)}>
            Agora não
          </button>
          <button className="button primary" disabled={busy} onClick={() => void accept(true)}>
            Permitir e continuar
          </button>
        </div>
      </section>
    </div>
  );
}
