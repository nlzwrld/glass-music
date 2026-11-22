import { useState } from 'react';
import {
  Check,
  VolumeX,
  Sparkles,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { AUDIO_ADS_POLICY, PLUS_PLAN_CATALOG } from '../../../shared/plus';
import { useAccounts } from '../../stores/accounts';

export function LiquidPlusSection() {
  const plusStatus = useAccounts(s => s.plusStatus);
  const hub = useAccounts(s => s.hub);
  const refreshPlusStatus = useAccounts(s => s.refreshPlusStatus);
  const [refreshing, setRefreshing] = useState(false);

  const activePlanName =
    PLUS_PLAN_CATALOG.find(p => p.id === plusStatus.planId)?.name || 'Grátis';

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshPlusStatus();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="settings-section plus-shell" aria-label="Liquid Plus">
      <div className="plus-header">
        <div>
          <span className="collection-type-label">
            <Sparkles size={12} /> Liquid Plus
          </span>
          <h2>Planos e benefícios</h2>
          <p className="subtle">
            Plano atual: <strong>{activePlanName}</strong>
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={refreshing}
          onClick={() => void onRefresh()}
        >
          <RefreshCw size={14} className={refreshing ? 'spinner' : ''} />
          Atualizar status
        </button>
      </div>

      <div className="notice plus-policy-banner" role="note">
        <VolumeX size={18} />
        <div>
          <strong>Música sem anúncios em áudio — gratuito para todos</strong>
          <small style={{ display: 'block', marginTop: 2 }}>
            {AUDIO_ADS_POLICY.audioInterruptionsAllowed ? '' : 'Zero interrupções sonoras: '}
            ouça suas músicas favoritas continuamente sem propagandas de áudio entre as faixas.
          </small>
        </div>
      </div>

      {!hub.authenticated && (
        <p className="fine-print">
          Entre na sua conta Liquid Hub na aba <strong>Conta</strong> para sincronizar seus benefícios entre desktop e Android.
        </p>
      )}

      <div className="plus-plan-grid">
        {PLUS_PLAN_CATALOG.map(plan => {
          const isCurrent = plusStatus.planId === plan.id && (plan.id === 'free' || plusStatus.active);
          return (
            <article
              key={plan.id}
              className={`plus-plan-card ${isCurrent ? 'is-current' : ''}`}
            >
              <div className="plus-plan-card-head">
                <div>
                  <h3>{plan.name}</h3>
                  <small>{plan.tagline}</small>
                </div>
                <span className={`entity-badge ${isCurrent ? 'entity-badge-user' : ''}`}>
                  {isCurrent
                    ? 'Plano atual'
                    : plan.commercialStatus === 'planned'
                      ? 'Em breve'
                      : 'Disponível'}
                </span>
              </div>
              <ul className="plus-feature-list">
                {plan.highlights.map(item => (
                  <li key={item}>
                    <Check size={14} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="plus-plan-foot">
                <small className="subtle">
                  {plan.id === 'free'
                    ? 'Inclui reprodução musical, playlists, busca, letras e JAM ao vivo.'
                    : 'Disponível em breve.'}
                </small>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
