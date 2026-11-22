import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  resetAndroidNativeSyncCache,
  syncMediaSessionMetadata,
} from '../../src/lib/androidBeta';
import {
  VISITOR_VISUAL_AD_SPEC,
  canVisitorPerformAction,
  shouldShowVisitorVisualAd,
} from '../../src/components/glass/VisitorVisualAdBanner';
// @ts-expect-error ESM script module
import { validateAndroidBetaConfig } from '../../scripts/android-beta.mjs';
// @ts-expect-error ESM script module
import { setupAndroidProject } from '../../scripts/android-setup.mjs';

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

  it('patches generated Tauri Android project idempotently with foreground MediaSession service, deep links, network security & signing', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'liquid-android-setup-'));
    try {
      const appMain = join(tempRoot, 'app', 'src', 'main');
      mkdirSync(appMain, { recursive: true });
      writeFileSync(
        join(appMain, 'AndroidManifest.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="Liquid Hub">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`,
        'utf8',
      );
      writeFileSync(
        join(tempRoot, 'app', 'build.gradle.kts'),
        `android {
    compileSdk = 34
    defaultConfig {
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}`,
        'utf8',
      );

      const first = setupAndroidProject(process.cwd(), { androidDir: tempRoot });
      expect(first.ok).toBe(true);
      expect(first.applicationId).toBe('com.nlzwrld.liquidhub');

      const manifest = readFileSync(join(appMain, 'AndroidManifest.xml'), 'utf8');
      expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK');
      expect(manifest).toContain('android.permission.BLUETOOTH_CONNECT');
      expect(manifest).toContain('android.permission.WAKE_LOCK');
      expect(manifest).toContain('android:networkSecurityConfig="@xml/network_security_config"');
      expect(manifest).toContain('android:launchMode="singleTask"');
      expect(manifest).toContain('android:scheme="liquidhub"');
      expect(manifest).toContain('.media.LiquidHubMediaPlaybackService');
      expect(manifest).toContain('android:foregroundServiceType="mediaPlayback"');

      const netSec = readFileSync(
        join(appMain, 'res', 'xml', 'network_security_config.xml'),
        'utf8',
      );
      expect(netSec).toContain('cleartextTrafficPermitted="false"');
      expect(netSec).toContain('<domain includeSubdomains="false">127.0.0.1</domain>');

      const serviceKt = readFileSync(
        join(appMain, 'java', 'com', 'nlzwrld', 'liquidhub', 'media', 'LiquidHubMediaPlaybackService.kt'),
        'utf8',
      );
      expect(serviceKt).toContain('FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK');
      expect(serviceKt).toContain('ACTION_AUDIO_BECOMING_NOISY');
      expect(serviceKt).toContain('PARTIAL_WAKE_LOCK');
      expect(serviceKt).toContain('liquid:android-media');

      const mainKt = readFileSync(
        join(appMain, 'java', 'com', 'nlzwrld', 'liquidhub', 'MainActivity.kt'),
        'utf8',
      );
      expect(mainKt).toContain('addJavascriptInterface(LiquidHubAndroidBridge(this), "LiquidHubAndroid")');
      expect(mainKt).toContain('LiquidHubMediaPlaybackService.isCurrentlyPlaying()');

      const gradle = readFileSync(join(tempRoot, 'app', 'build.gradle.kts'), 'utf8');
      expect(gradle).toContain('minSdk = 26');
      expect(gradle).toContain('targetSdk = 35');
      expect(gradle).toContain('compileSdk = 36');
      expect(gradle).toContain('LIQUID_ANDROID_KEYSTORE_PATH');

      // Second run must be idempotent without duplicating manifest entries
      setupAndroidProject(process.cwd(), { androidDir: tempRoot });
      const manifestAfter = readFileSync(join(appMain, 'AndroidManifest.xml'), 'utf8');
      expect(manifestAfter.match(/LiquidHubMediaPlaybackService/g)?.length).toBe(1);
      expect(manifestAfter.match(/android:scheme="liquidhub"/g)?.length).toBe(5);

      // Verify native Android WebView bridge syncing
      resetAndroidNativeSyncCache();
      const updatePlayback = vi.fn();
      const stopPlayback = vi.fn();
      const prevWindow = (globalThis as { window?: unknown }).window;
      (globalThis as { window?: unknown }).window = {
        LiquidHubAndroid: { updatePlayback, stopPlayback },
      };
      try {
        syncMediaSessionMetadata(
          {
            id: 'youtube:abc12345678',
            source: 'youtube',
            sourceId: 'abc12345678',
            kind: 'track',
            title: 'Neon Drift',
            artist: 'Liquid Artist',
            album: 'Beta Album',
            duration: 180,
            addedAt: Date.now(),
          },
          true,
          12.5,
          180,
          null,
        );
        expect(updatePlayback).toHaveBeenCalledWith(
          'Neon Drift',
          'Liquid Artist',
          'Beta Album',
          true,
          12500,
          180000,
        );
        syncMediaSessionMetadata(null, false, 0, 0, null);
        expect(stopPlayback).toHaveBeenCalledTimes(1);
      } finally {
        (globalThis as { window?: unknown }).window = prevWindow;
        resetAndroidNativeSyncCache();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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
