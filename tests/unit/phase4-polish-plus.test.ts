import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../../shared/auth';
import {
  AUDIO_ADS_POLICY,
  PLUS_PLAN_CATALOG,
  defaultFreePlusStatus,
  resolvePlusEntitlements,
  type LiquidPlusStatus,
} from '../../shared/plus';
import {
  computePkceS256Challenge,
  createBroker,
  ZeroTrustAuthEngine,
} from '../../server/broker';
import { handleCloudflareJamFetch, JamRoomDO, type CfJamEnv } from '../../server/jam';
import {
  MOTION_DURATION,
  MOTION_EASE,
  backdropMotion,
  drawerMotion,
  menuMotion,
  modalMotion,
  motionTransition,
  pageMotion,
  toastMotion,
} from '../../src/lib/motion';
import {
  MAX_WEBGL_SURFACES,
  glassVisualPresets,
  resolveGlassQualityTier,
} from '../../src/components/glass/v3/model';

const ROOT = process.cwd();
const TEST_ARGON2 = { memory: 1024, passes: 1, parallelism: 1, tagLength: 16 };

describe('Phase 4 — Transições Spotify, Liquid Glass, Reorganização das Configurações, Nova Logo & Liquid Plus', () => {
  it('centralizes Spotify-grade motion tokens and collapses animations to 0ms under reduced motion', () => {
    expect(MOTION_DURATION.page).toBeGreaterThan(0);
    expect(MOTION_DURATION.menu).toBeGreaterThan(0);
    expect(MOTION_DURATION.modal).toBeGreaterThan(0);
    expect(MOTION_DURATION.panel).toBeGreaterThan(0);
    expect(MOTION_EASE.standard).toEqual([0.22, 1, 0.36, 1]);
    expect(MOTION_EASE.emphasized).toEqual([0.2, 0, 0, 1]);

    const activeTrans = motionTransition(false, MOTION_DURATION.panel);
    expect(activeTrans.duration).toBe(MOTION_DURATION.panel);
    expect(activeTrans.ease).toEqual(MOTION_EASE.standard);

    const reducedTrans = motionTransition(true, MOTION_DURATION.panel);
    expect(reducedTrans.duration).toBe(0);

    for (const preset of [
      pageMotion(true),
      menuMotion(true),
      modalMotion(true),
      backdropMotion(true),
      drawerMotion(true, 'x'),
      drawerMotion(true, 'y'),
      toastMotion(true),
    ]) {
      expect(preset.initial).toBe(false);
      expect(preset.transition.duration).toBe(0);
    }

    expect(pageMotion(false).initial).toEqual({ opacity: 0, y: 4 });
    expect(drawerMotion(false, 'x').initial).toEqual({ opacity: 0, x: 16 });
    expect(drawerMotion(false, 'y').initial).toEqual({ opacity: 0, y: 18 });
  });

  it('resolves Liquid Glass quality tiers, hardware/accessibility fallbacks and enforces WebGL surface cap', () => {
    expect(MAX_WEBGL_SURFACES).toBe(12);
    expect(Object.keys(glassVisualPresets)).toEqual(['liquid', 'crystal', 'frosted', 'battery']);

    // Capable desktop GPU in auto mode -> WebGL balanced
    expect(
      resolveGlassQualityTier({
        requested: 'auto',
        uiStyle: 'glass',
        performanceMode: false,
        rendererName: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)',
        maxTextureSize: 16384,
        hardwareConcurrency: 8,
        deviceMemory: 16,
        isMobileTouch: false,
      }),
    ).toEqual({ quality: 'balanced', engine: 'webgl', reason: 'auto' });

    // Explicit high tier on capable hardware -> WebGL high
    expect(
      resolveGlassQualityTier({
        requested: 'high',
        uiStyle: 'glass',
        performanceMode: false,
        rendererName: 'NVIDIA RTX 4070',
        maxTextureSize: 16384,
        hardwareConcurrency: 12,
        deviceMemory: 16,
      }),
    ).toEqual({ quality: 'high', engine: 'webgl', reason: 'high' });

    // Automatic downgrades to economy + CSS fallback
    expect(
      resolveGlassQualityTier({
        requested: 'auto',
        uiStyle: 'matte',
        performanceMode: false,
      }),
    ).toEqual({ quality: 'economy', engine: 'css', reason: 'matte' });

    expect(
      resolveGlassQualityTier({
        requested: 'high',
        uiStyle: 'glass',
        performanceMode: true,
      }),
    ).toEqual({ quality: 'economy', engine: 'css', reason: 'performance' });

    expect(
      resolveGlassQualityTier({
        requested: 'high',
        uiStyle: 'glass',
        performanceMode: false,
        prefersContrastMore: true,
      }),
    ).toEqual({ quality: 'economy', engine: 'css', reason: 'contrast' });

    expect(
      resolveGlassQualityTier({
        requested: 'high',
        uiStyle: 'glass',
        performanceMode: false,
        prefersReducedTransparency: true,
      }),
    ).toEqual({ quality: 'economy', engine: 'css', reason: 'reduced-transparency' });

    expect(
      resolveGlassQualityTier({
        requested: 'auto',
        uiStyle: 'glass',
        performanceMode: false,
        isMobileTouch: true,
      }),
    ).toEqual({ quality: 'economy', engine: 'css', reason: 'mobile-touch' });

    expect(
      resolveGlassQualityTier({
        requested: 'auto',
        uiStyle: 'glass',
        performanceMode: false,
        rendererName: 'Google SwiftShader',
        maxTextureSize: 8192,
        hardwareConcurrency: 8,
      }),
    ).toEqual({ quality: 'economy', engine: 'css', reason: 'software-gpu' });

    expect(
      resolveGlassQualityTier({
        requested: 'auto',
        uiStyle: 'glass',
        performanceMode: false,
        rendererName: 'Intel Iris',
        maxTextureSize: 2048,
        hardwareConcurrency: 8,
      }),
    ).toEqual({ quality: 'economy', engine: 'css', reason: 'low-texture' });

    expect(
      resolveGlassQualityTier({
        requested: 'auto',
        uiStyle: 'glass',
        performanceMode: false,
        rendererName: 'Intel UHD',
        maxTextureSize: 8192,
        hardwareConcurrency: 2,
      }),
    ).toEqual({ quality: 'economy', engine: 'css', reason: 'low-cpu' });

    expect(
      resolveGlassQualityTier({
        requested: 'auto',
        uiStyle: 'glass',
        performanceMode: false,
        rendererName: 'Intel UHD',
        maxTextureSize: 8192,
        hardwareConcurrency: 4,
        deviceMemory: 2,
      }),
    ).toEqual({ quality: 'economy', engine: 'css', reason: 'low-memory' });

    const rendererSrc = readFileSync(
      join(ROOT, 'src/components/glass/v3/renderer.ts'),
      'utf8',
    );
    expect(rendererSrc).toContain('MAX_WEBGL_SURFACES');
    expect(rendererSrc).toContain('.slice(0,MAX_WEBGL_SURFACES)');
  });

  it('enforces native ad-free audio playback policy and deterministic Liquid Plus entitlements', () => {
    expect(AUDIO_ADS_POLICY.audioInterruptionsAllowed).toBe(false);
    expect(AUDIO_ADS_POLICY.nativeAdFreeMusic).toBe(true);
    expect(AUDIO_ADS_POLICY.visualAdsMutedByDefault).toBe(true);
    expect(AUDIO_ADS_POLICY.explicitUnmuteRequired).toBe(true);

    expect(PLUS_PLAN_CATALOG.map(p => p.id)).toEqual(['free', 'plus_monthly', 'plus_annual']);
    expect(PLUS_PLAN_CATALOG.every(p => p.checkoutEnabled === false)).toBe(true);

    const now = 1_760_000_000_000;
    const freeRes = resolvePlusEntitlements('free', 'none', now, null);
    expect(freeRes.active).toBe(false);
    expect(freeRes.effectivePlanId).toBe('free');
    expect(freeRes.entitlements.nativeAudioAdFree).toBe(true);
    expect(freeRes.entitlements.adFreeVisual).toBe(false);

    const activeMonthly = resolvePlusEntitlements('plus_monthly', 'active', now, now + 86_400_000);
    expect(activeMonthly.active).toBe(true);
    expect(activeMonthly.effectivePlanId).toBe('plus_monthly');
    expect(activeMonthly.entitlements.nativeAudioAdFree).toBe(true);
    expect(activeMonthly.entitlements.adFreeVisual).toBe(true);
    expect(activeMonthly.entitlements.exclusiveThemes).toBe(true);
    expect(activeMonthly.entitlements.advancedGlassPresets).toBe(true);
    expect(activeMonthly.entitlements.detailedListeningStats).toBe(true);

    const trialingAnnual = resolvePlusEntitlements('plus_annual', 'trialing', now, null);
    expect(trialingAnnual.active).toBe(true);
    expect(trialingAnnual.effectivePlanId).toBe('plus_annual');

    const expiredMonthly = resolvePlusEntitlements('plus_monthly', 'active', now, now - 1);
    expect(expiredMonthly.active).toBe(false);
    expect(expiredMonthly.effectivePlanId).toBe('free');
    expect(expiredMonthly.effectiveStatus).toBe('expired');
    expect(expiredMonthly.entitlements.adFreeVisual).toBe(false);
    expect(expiredMonthly.entitlements.nativeAudioAdFree).toBe(true);

    const canceled = resolvePlusEntitlements('plus_monthly', 'canceled', now, null);
    expect(canceled.active).toBe(false);
    expect(canceled.effectivePlanId).toBe('free');
    expect(canceled.effectiveStatus).toBe('canceled');

    expect(defaultFreePlusStatus(false).audioAdsPolicy.audioInterruptionsAllowed).toBe(false);
  });

  it('serves /v1/plus/plans and /v1/plus/status across Node broker, ZeroTrustAuthEngine and Cloudflare DO while rejecting client self-upgrade', async () => {
    let now = 1_760_000_000_000;
    const engine = new ZeroTrustAuthEngine({
      clock: () => now,
      argon2Params: TEST_ARGON2,
    });
    try {
      engine.registerUser('plus_tester', 'StrongPlusPassword!2026');
      const user = engine.store.findUserByUsername('plus_tester')!;

      expect(engine.getPlusStatus(null).authenticated).toBe(false);
      expect(engine.getPlusStatus(user.userId)).toMatchObject({
        authenticated: true,
        planId: 'free',
        status: 'none',
        active: false,
        checkoutEnabled: false,
      });

      // Server-side authoritative grant activates Liquid Plus entitlements
      engine.store.setUserSubscription(
        user.userId,
        {
          planId: 'plus_monthly',
          status: 'active',
          source: 'promo',
          currentPeriodEnd: now + 60_000,
        },
        now,
      );
      const granted = engine.getPlusStatus(user.userId);
      expect(granted.active).toBe(true);
      expect(granted.planId).toBe('plus_monthly');
      expect(granted.entitlements.adFreeVisual).toBe(true);
      expect(granted.source).toBe('promo');

      // Advance clock past expiration -> automatically downgrades to free
      now += 120_000;
      const afterExpiry = engine.getPlusStatus(user.userId);
      expect(afterExpiry.active).toBe(false);
      expect(afterExpiry.planId).toBe('free');
      expect(afterExpiry.status).toBe('expired');
      expect(afterExpiry.entitlements.adFreeVisual).toBe(false);
      expect(afterExpiry.entitlements.nativeAudioAdFree).toBe(true);
    } finally {
      engine.close();
    }

    // Node HTTP Broker verification
    const server = createBroker(
      {
        BROKER_ACCESS_TOKEN: 'phase4-broker-secret-token-value-1234',
        SOUNDCLOUD_CLIENT_ID: 'sc-id',
        SOUNDCLOUD_CLIENT_SECRET: 'sc-secret',
      },
      vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
      Date.now,
      { argon2Params: TEST_ARGON2 },
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const plansRes = await fetch(`${base}/v1/plus/plans`);
      expect(plansRes.status).toBe(200);
      const plansJson = (await plansRes.json()) as {
        checkoutEnabled: boolean;
        audioAdsPolicy: typeof AUDIO_ADS_POLICY;
      };
      expect(plansJson.checkoutEnabled).toBe(false);
      expect(plansJson.audioAdsPolicy.audioInterruptionsAllowed).toBe(false);

      const guestStatusRes = await fetch(`${base}/v1/plus/status`);
      expect(guestStatusRes.status).toBe(200);
      const guestStatus = (await guestStatusRes.json()) as LiquidPlusStatus;
      expect(guestStatus.authenticated).toBe(false);
      expect(guestStatus.planId).toBe('free');

      // Register authenticated user and query /v1/plus/status
      const verifier = randomBytes(32).toString('base64url');
      const challenge = computePkceS256Challenge(verifier);
      const regRes = await fetch(`${base}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'node_plus_user',
          email: 'node.plus@example.com',
          displayName: 'Node Plus User',
          password: 'StrongPasswordNode!2026',
          client_id: 'liquid-hub-desktop',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          termsVersion: CURRENT_TERMS_VERSION,
          privacyVersion: CURRENT_PRIVACY_VERSION,
        }),
      });
      const { code } = (await regRes.json()) as { code: string };
      const tokRes = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: 'liquid-hub-desktop',
          code_verifier: verifier,
        }),
      });
      const { access_token } = (await tokRes.json()) as { access_token: string };

      const authStatusRes = await fetch(`${base}/v1/plus/status`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      expect(authStatusRes.status).toBe(200);
      const authStatus = (await authStatusRes.json()) as LiquidPlusStatus;
      expect(authStatus.authenticated).toBe(true);
      expect(authStatus.planId).toBe('free');

      // Client self-upgrade attempts must be rejected with 405
      const spoofRes = await fetch(`${base}/v1/plus/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ planId: 'plus_monthly', status: 'active' }),
      });
      expect(spoofRes.status).toBe(405);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    // Cloudflare Worker + Durable Object parity
    let authDo: JamRoomDO | null = null;
    const cfEnv: CfJamEnv = {
      BROKER_PUBLIC_URL: 'https://liquid-hub-jam.nlzezwrld.workers.dev',
      JAM_ROOMS: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (req: Request) => {
            if (!authDo) {
              authDo = new JamRoomDO(
                {
                  storage: {
                    get: async () => undefined,
                    put: async () => {},
                    deleteAll: async () => {},
                    setAlarm: async () => {},
                  },
                  acceptWebSocket: () => {},
                  getWebSockets: () => [],
                },
                cfEnv,
              );
            }
            return authDo.fetch(req);
          },
        }),
      },
    };
    const cfPlans = await handleCloudflareJamFetch(
      new Request('https://liquid-hub-jam.nlzezwrld.workers.dev/v1/plus/plans'),
      cfEnv,
    );
    expect(cfPlans.status).toBe(200);
    const cfStatus = await handleCloudflareJamFetch(
      new Request('https://liquid-hub-jam.nlzezwrld.workers.dev/v1/plus/status'),
      cfEnv,
    );
    expect(cfStatus.status).toBe(200);
    const cfSpoof = await handleCloudflareJamFetch(
      new Request('https://liquid-hub-jam.nlzezwrld.workers.dev/v1/plus/status', {
        method: 'POST',
      }),
      cfEnv,
    );
    expect(cfSpoof.status).toBe(405);
  });

  it('provides the new Liquid Hub headphone + liquid droplet logo component and all 5 brand preview SVGs without overwriting final binary icons prematurely', () => {
    const logoSrc = readFileSync(
      join(ROOT, 'src/components/brand/LiquidHubLogo.tsx'),
      'utf8',
    );
    expect(logoSrc).toContain('useId');
    expect(logoSrc).toContain('LiquidHubLogo');
    expect(logoSrc).toContain('viewBox="0 0 64 64"');

    const brandFiles = [
      'public/brand/liquid-hub-dark.svg',
      'public/brand/liquid-hub-light.svg',
      'public/brand/liquid-hub-mono.svg',
      'public/brand/liquid-hub-android-adaptive.svg',
      'public/brand/liquid-hub-splash.svg',
    ];
    for (const rel of brandFiles) {
      const full = join(ROOT, rel);
      expect(existsSync(full), `${rel} must exist`).toBe(true);
      const svg = readFileSync(full, 'utf8');
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
    }

    for (const consumer of [
      'src/components/glass/Welcome.tsx',
      'src/components/auth/AuthModal.tsx',
      'src/app/App.tsx',
      'src/pages/Settings.tsx',
    ]) {
      expect(readFileSync(join(ROOT, consumer), 'utf8')).toContain('LiquidHubLogo');
    }
    expect(readFileSync(join(ROOT, 'src/app/App.tsx'), 'utf8')).toContain('titlebar-brand');
  });

  it('reorganizes Settings into 9 clean searchable categories while preserving Phase 2 & Phase 3A removal invariants', () => {
    const settingsSrc = readFileSync(join(ROOT, 'src/pages/Settings.tsx'), 'utf8');
    for (const cat of [
      "'account'",
      "'appearance'",
      "'playback'",
      "'audio'",
      "'notifications'",
      "'privacy'",
      "'storage'",
      "'plus'",
      "'about'",
    ]) {
      expect(settingsSrc).toContain(cat);
    }
    expect(settingsSrc).toContain('Filtrar configurações');
    expect(settingsSrc).toContain('LiquidPlusSection');
    expect(settingsSrc).toContain('BrandPreviewGallery');

    // Non-regression guards required by Phase 2 and Phase 3A
    expect(settingsSrc).not.toContain('OfflineSettings');
    expect(settingsSrc).not.toContain('Armazenamento offline');
    expect(settingsSrc).not.toContain('Limpar downloads');
    expect(settingsSrc).not.toContain('JamSettings');
  });

  it('enforces UI polish: top-left Liquid Hub brand, logo-only origin badges, no Para você refresh, Beat Pulse toggle option, and collapsible Contas vinculadas', () => {
    const appearanceSrc = readFileSync(join(ROOT, 'src/components/glass/Appearance.tsx'), 'utf8');
    expect(appearanceSrc).not.toContain("['beat', 'Pulso']");
    expect(appearanceSrc).toContain('label="Efeito Pulse"');

    const catalogSrc = readFileSync(join(ROOT, 'src/components/library/OnlineCatalog.tsx'), 'utf8');
    expect(catalogSrc).not.toContain('Atualizar recomendações e descobertas');

    const trackListSrc = readFileSync(join(ROOT, 'src/components/library/TrackList.tsx'), 'utf8');
    expect(trackListSrc).toContain('displayAlbumTitle');
    expect(trackListSrc).not.toContain('compact={!!track.album}');

    const accountSrc = readFileSync(
      join(ROOT, 'src/components/library/AccountConnections.tsx'),
      'utf8',
    );
    expect(accountSrc).toContain('Contas vinculadas');
    expect(accountSrc).toContain('Plataformas vinculadas');
    expect(accountSrc).toContain('identitiesOpen');
    expect(accountSrc).toContain('platformsOpen');
    expect(accountSrc).toContain('editProfileOpen');
  });
});
