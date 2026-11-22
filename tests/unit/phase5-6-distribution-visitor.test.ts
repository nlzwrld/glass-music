import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_VERSION,
  MIN_SUPPORTED_VERSION,
  compareSemVer,
  evaluateVersionPolicy,
  parseSemVer,
} from '../../shared/version';
import { defaultFreePlusStatus, resolvePlusEntitlements } from '../../shared/plus';
import { ZeroTrustAuthEngine, handleFetchAuthRequest } from '../../server/broker';
import {
  ANDROID_BETA_MANIFEST_SUMMARY,
  createAudioFocusManager,
  isAndroidPlatform,
  isMobileViewport,
  registerMediaSessionBridge,
} from '../../src/lib/androidBeta';
import {
  VISITOR_VISUAL_AD_SPEC,
  canVisitorPerformAction,
  shouldShowVisitorVisualAd,
} from '../../src/components/glass/VisitorVisualAdBanner';
// @ts-expect-error ESM script module
import { validateAndroidBetaConfig } from '../../scripts/android-beta.mjs';

describe('Phase 5 & 6 — Distribution, Mandatory Updates, Installer Hooks, Android Beta & Visitor Mode', () => {
  it('evaluates semantic versions and mandatory minimum version policies accurately (Seção 18)', () => {
    expect(parseSemVer('v2.2.0')).toEqual([2, 2, 0]);
    expect(compareSemVer('2.2.0', '2.1.9')).toBe(1);
    expect(compareSemVer('2.1.0', '2.2.0')).toBe(-1);
    expect(compareSemVer('2.2.0', '2.2.0')).toBe(0);

    const compatible = evaluateVersionPolicy({
      clientVersion: APP_VERSION,
      minSupportedVersion: MIN_SUPPORTED_VERSION,
      platform: 'windows',
    });
    expect(compatible.compatible).toBe(true);
    expect(compatible.mandatoryUpdate).toBe(false);
    expect(compatible.packageIntegrity.algorithm).toBe('Minisign-Ed25519+SHA-256');
    expect(compatible.packageIntegrity.signatureRequired).toBe(true);

    const outdated = evaluateVersionPolicy({
      clientVersion: '2.0.5',
      minSupportedVersion: '2.2.0',
      platform: 'android',
    });
    expect(outdated.compatible).toBe(false);
    expect(outdated.mandatoryUpdate).toBe(true);
    expect(outdated.reason).toContain('2.0.5');
    expect(outdated.reason).toContain('2.2.0');
  });

  it('enforces 426 client_update_required on outdated X-Liquid-Client-Version headers while keeping /v1/version open (Seção 18)', async () => {
    const engine = new ZeroTrustAuthEngine();
    engine.setMinSupportedVersion('2.2.0');
    const emptyOAuth = {
      authorizeUrl: '',
      tokenUrl: '',
      userInfoUrl: '',
      emailsUrl: '',
      clientId: '',
      clientSecret: '',
      scopes: '',
      redirectUri: '',
      jwksUrl: '',
      issuer: '',
    };
    const baseOAuthProviders = {
      discord: emptyOAuth,
      github: emptyOAuth,
      google: emptyOAuth,
    };

    // Outdated client can still query /v1/version to discover the update URL and minimum version
    const versionReq = new Request(
      'https://broker.liquid.test/v1/version?clientVersion=2.0.1&platform=windows',
      {
        method: 'GET',
        headers: { 'X-Liquid-Client-Version': '2.0.1' },
      },
    );
    const versionRes = await handleFetchAuthRequest({
      request: versionReq,
      auth: engine,
      baseOAuthProviders,
    });
    expect(versionRes).not.toBeNull();
    expect(versionRes!.status).toBe(200);
    const policy = await versionRes!.json();
    expect(policy.compatible).toBe(false);
    expect(policy.mandatoryUpdate).toBe(true);
    expect(policy.minSupportedVersion).toBe('2.2.0');

    // Outdated client is blocked with 426 on protected API endpoints
    const blockedReq = new Request('https://broker.liquid.test/v1/plus/plans', {
      method: 'GET',
      headers: { 'X-Liquid-Client-Version': '2.0.1' },
    });
    const blockedRes = await handleFetchAuthRequest({
      request: blockedReq,
      auth: engine,
      baseOAuthProviders,
    });
    expect(blockedRes).not.toBeNull();
    expect(blockedRes!.status).toBe(426);
    const blockedBody = await blockedRes!.json();
    expect(blockedBody.code).toBe('client_update_required');
    expect(blockedBody.minSupportedVersion).toBe('2.2.0');

    // Current client succeeds
    const okReq = new Request('https://broker.liquid.test/v1/plus/plans', {
      method: 'GET',
      headers: { 'X-Liquid-Client-Version': '2.2.0' },
    });
    const okRes = await handleFetchAuthRequest({
      request: okReq,
      auth: engine,
      baseOAuthProviders,
    });
    expect(okRes).not.toBeNull();
    expect(okRes!.status).toBe(200);
  });

  it('wires custom NSIS installer & maintenance hooks in tauri.conf.json and hooks.nsh (Seção 19)', () => {
    const root = process.cwd();
    const hooksPath = resolve(root, 'src-tauri', 'windows', 'hooks.nsh');
    const tauriConfPath = resolve(root, 'src-tauri', 'tauri.conf.json');
    expect(existsSync(hooksPath)).toBe(true);
    const hooksContent = readFileSync(hooksPath, 'utf8');
    expect(hooksContent).toContain('NSIS_HOOK_PREINSTALL');
    expect(hooksContent).toContain('NSIS_HOOK_POSTINSTALL');
    expect(hooksContent).toContain('install-integrity.json');
    expect(hooksContent).toContain('NSIS_HOOK_POSTUNINSTALL');

    const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
    expect(tauriConf.bundle?.windows?.nsis?.installerHooks).toBe('windows/hooks.nsh');
  });

  it('validates Android Beta manifest, MediaSession controls, and transient audio-focus recovery (Seção 3)', () => {
    const summary = validateAndroidBetaConfig(process.cwd());
    expect(summary.ok).toBe(true);
    expect(summary.applicationId).toBe(ANDROID_BETA_MANIFEST_SUMMARY.applicationId);
    expect(summary.permissionsCount).toBe(
      ANDROID_BETA_MANIFEST_SUMMARY.requiredPermissions.length,
    );

    expect(isAndroidPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(true);
    expect(isAndroidPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isMobileViewport(390, 'Mozilla/5.0 (Windows NT 10.0)')).toBe(true);
    expect(isMobileViewport(1280, 'Mozilla/5.0 (Windows NT 10.0)')).toBe(false);

    const registered = new Map<string, (...args: unknown[]) => void>();
    const fakeMediaSession = {
      setActionHandler: vi.fn((action: string, handler: ((...args: unknown[]) => void) | null) => {
        if (handler) registered.set(action, handler);
        else registered.delete(action);
      }),
    } as unknown as MediaSession;

    let played = 0;
    let paused = 0;
    let nextCalled = 0;
    const cleanup = registerMediaSessionBridge(
      {
        onPlay: () => {
          played += 1;
        },
        onPause: () => {
          paused += 1;
        },
        onPreviousTrack: () => {},
        onNextTrack: () => {
          nextCalled += 1;
        },
      },
      fakeMediaSession,
    );

    expect(registered.has('play')).toBe(true);
    expect(registered.has('pause')).toBe(true);
    expect(registered.has('nexttrack')).toBe(true);
    registered.get('play')?.();
    registered.get('nexttrack')?.();
    expect(played).toBe(1);
    expect(nextCalled).toBe(1);
    cleanup();
    expect(registered.size).toBe(0);

    // Transient audio focus loss pauses and auto-resumes on gain; bluetooth disconnect does not auto-resume
    let isPlaying = true;
    const focus = createAudioFocusManager({
      isPlaying: () => isPlaying,
      play: () => {
        isPlaying = true;
      },
      pause: () => {
        isPlaying = false;
      },
    });
    focus.handleAudioFocusChange('loss_transient');
    expect(isPlaying).toBe(false);
    expect(focus.wasInterrupted()).toBe(true);
    focus.handleAudioFocusChange('gain');
    expect(isPlaying).toBe(true);
    expect(focus.wasInterrupted()).toBe(false);

    focus.handleAudioFocusChange('bluetooth_disconnect');
    expect(isPlaying).toBe(false);
    focus.handleAudioFocusChange('gain');
    expect(isPlaying).toBe(false);
    expect(paused).toBe(0);
  });

  it('enforces Visitor Mode permissions and visual-only non-audio ad policy (Seção 21)', () => {
    expect(VISITOR_VISUAL_AD_SPEC.mutedByDefault).toBe(true);
    expect(VISITOR_VISUAL_AD_SPEC.hasAudioElement).toBe(false);
    expect(VISITOR_VISUAL_AD_SPEC.interruptsMusicPlayback).toBe(false);

    // Visitor allowed vs blocked actions
    const visitor = { visitorMode: true, authenticated: false };
    expect(canVisitorPerformAction('browse', visitor).allowed).toBe(true);
    expect(canVisitorPerformAction('search', visitor).allowed).toBe(true);
    expect(canVisitorPerformAction('playback', visitor).allowed).toBe(true);
    expect(canVisitorPerformAction('public_profile', visitor).allowed).toBe(true);
    expect(canVisitorPerformAction('local_playlist', visitor).allowed).toBe(true);
    expect(canVisitorPerformAction('jam', visitor).allowed).toBe(false);
    expect(canVisitorPerformAction('collaborative_playlist', visitor).allowed).toBe(false);
    expect(canVisitorPerformAction('cloud_sync', visitor).allowed).toBe(false);

    // Visual ad banner visibility: shown only for unauthenticated visitor without Liquid Plus
    expect(
      shouldShowVisitorVisualAd({
        visitorMode: true,
        authenticated: false,
        plusStatus: defaultFreePlusStatus(false),
      }),
    ).toBe(true);

    // Hidden when authenticated
    expect(
      shouldShowVisitorVisualAd({
        visitorMode: false,
        authenticated: true,
        plusStatus: defaultFreePlusStatus(true),
      }),
    ).toBe(false);

    // Hidden when Liquid Plus active (adFreeVisual = true)
    const resolvedPlus = resolvePlusEntitlements(
      'plus_monthly',
      'active',
      Date.now(),
      Date.now() + 86_400_000,
    );
    const activePlus = {
      ...defaultFreePlusStatus(true),
      planId: resolvedPlus.effectivePlanId,
      status: resolvedPlus.effectiveStatus,
      active: resolvedPlus.active,
      entitlements: resolvedPlus.entitlements,
    };
    expect(
      shouldShowVisitorVisualAd({
        visitorMode: true,
        authenticated: false,
        plusStatus: activePlus,
      }),
    ).toBe(false);
  });
});
