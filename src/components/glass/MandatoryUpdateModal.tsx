import { ArrowUpCircle, Download, ExternalLink, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useUpdateNotice } from '../../lib/updates';
import { useApp, cleanError } from '../../stores/app';
import { LiquidHubLogo } from '../brand/LiquidHubLogo';

export function MandatoryUpdateModal() {
  const mandatory = useUpdateNotice(s => s.mandatory);
  const clientVersion = useUpdateNotice(s => s.clientVersion);
  const minSupportedVersion = useUpdateNotice(s => s.minSupportedVersion);
  const availableVersion = useUpdateNotice(s => s.availableVersion);
  const updateUrl = useUpdateNotice(s => s.updateUrl);
  const releaseNotes = useUpdateNotice(s => s.releaseNotes);
  const reason = useUpdateNotice(s => s.reason);
  const packageIntegrity = useUpdateNotice(s => s.packageIntegrity);
  const installing = useUpdateNotice(s => s.installing);

  if (!mandatory) return null;

  const handleExportBackup = async () => {
    try {
      const ok = await window.glass.exportLibrary();
      if (ok) {
        useApp.getState().message('Backup da biblioteca exportado com segurança.');
      }
    } catch (e) {
      useApp.getState().message(cleanError(e));
    }
  };

  return (
    <div
      className="auth-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mandatory-update-title"
      style={{ zIndex: 10000 }}
    >
      <div className="auth-modal-card glass-surface-heavy" style={{ maxWidth: 520 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <LiquidHubLogo size={42} variant="dark" />
          <div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                padding: '3px 9px',
                borderRadius: 999,
                background: 'rgba(245, 158, 11, 0.16)',
                color: '#fbbf24',
                marginBottom: 4,
              }}
            >
              <ArrowUpCircle size={13} />
              Atualização obrigatória de compatibilidade
            </div>
            <h2 id="mandatory-update-title" style={{ margin: 0, fontSize: 19 }}>
              Atualize o Liquid Hub para continuar
            </h2>
          </div>
        </div>

        <p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.55, opacity: 0.9 }}>
          {reason ||
            `Sua versão atual (${clientVersion}) não é compatível com o protocolo mínimo exigido (${minSupportedVersion}). Suas playlists, downloads offline e configurações locais estão preservados.`}
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 8,
            padding: 12,
            borderRadius: 12,
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            marginBottom: 14,
            fontSize: 12,
          }}
        >
          <div>
            <div style={{ opacity: 0.65 }}>Versão instalada</div>
            <strong style={{ fontSize: 14 }}>v{clientVersion}</strong>
          </div>
          <div>
            <div style={{ opacity: 0.65 }}>Versão mínima</div>
            <strong style={{ fontSize: 14, color: '#fbbf24' }}>v{minSupportedVersion}</strong>
          </div>
          <div>
            <div style={{ opacity: 0.65 }}>Versão disponível</div>
            <strong style={{ fontSize: 14, color: '#38bdf8' }}>
              v{availableVersion || minSupportedVersion}
            </strong>
          </div>
        </div>

        {releaseNotes && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              fontSize: 12.5,
              lineHeight: 1.5,
              marginBottom: 14,
              opacity: 0.85,
            }}
          >
            {releaseNotes}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            opacity: 0.78,
            marginBottom: 16,
          }}
        >
          <ShieldCheck size={15} style={{ color: '#34d399', flexShrink: 0 }} />
          <span>
            Pacote assinado e verificado via <strong>{packageIntegrity}</strong> com backup
            automático pré-instalação.
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            className="button primary"
            disabled={installing}
            onClick={() => void useUpdateNotice.getState().installNow()}
            style={{ width: '100%', justifyContent: 'center', padding: '10px 16px' }}
          >
            {installing ? (
              <>
                <LoaderCircle size={15} className="spinner" />
                Baixando e verificando pacote assinado…
              </>
            ) : (
              <>
                <ArrowUpCircle size={15} />
                Atualizar agora pelo canal oficial
              </>
            )}
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="button ghost"
              onClick={() => void handleExportBackup()}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              <Download size={14} />
              Exportar backup da biblioteca
            </button>
            {updateUrl && (
              <button
                type="button"
                className="button ghost"
                onClick={() => void window.glass.external(updateUrl)}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                <ExternalLink size={14} />
                Abrir canal oficial
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
