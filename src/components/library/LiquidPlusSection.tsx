import { useState } from 'react';
import {
  Check,
  VolumeX,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { AUDIO_ADS_POLICY, PLUS_PLAN_CATALOG } from '../../../shared/plus';
import { useAccounts } from '../../stores/accounts';

export function LiquidPlusSection() {
  const plusStatus = useAccounts(s => s.plusStatus);
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
        <strong>
          {AUDIO_ADS_POLICY.audioInterruptionsAllowed
            ? 'Planos Liquid Plus'
            : 'Sem anúncios em áudio'}
        </strong>
      </div>

      <div className="plus-plan-grid">
        {PLUS_PLAN_CATALOG.map(plan => {
          const isCurrent = plusStatus.planId === plan.id && (plan.id === 'free' || plusStatus.active);
          return (
            <article
              key={plan.id}
              className={`plus-plan-card ${isCurrent ? 'is-current' : ''}`}
            >
              <div className="plus-plan-card-head">
                <h3>{plan.name}</h3>
                <span className={`entity-badge ${isCurrent ? 'entity-badge-user' : ''}`}>
                  {isCurrent
                    ? 'Atual'
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
            </article>
          );
        })}
      </div>
    </section>
  );
}
