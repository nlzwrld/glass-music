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
import {
  createBeatDetectorState,
  stepBeatDetector,
} from '../../src/components/glass/BeatPulseOverlay';

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
    expect(tauriConf.bundle?.windows?.nsis?.headerImage).toBe('windows/nsis-header.bmp');
    expect(tauriConf.bundle?.windows?.nsis?.sidebarImage).toBe('windows/nsis-sidebar.bmp');
    expect(existsSync(resolve(root, 'src-tauri', 'windows', 'nsis-header.bmp'))).toBe(true);
    expect(existsSync(resolve(root, 'src-tauri', 'windows', 'nsis-sidebar.bmp'))).toBe(true);
    expect(readFileSync(resolve(root, 'src-tauri', 'windows', 'nsis-sidebar.bmp')).subarray(0, 2).toString('ascii')).toBe('BM');
  });

  it('triggers musical beat flashes on bass onsets, moves History/Settings to topbar profile menu, and ships minimalist download site', () => {
    let state = createBeatDetectorState();
    // Calm passage keeps flash at 0
    state = stepBeatDetector(state, { bass: 0.05, mid: 0.05, energy: 0.05 }, 16.6);
    expect(state.flash).toBe(0);

    // Kick drum transient spikes flash cleanly and advances fluid orbital phase
    const phaseBefore = state.phase;
    state = stepBeatDetector(state, { bass: 0.82, subBass: 0.88, mid: 0.4, energy: 0.7 }, 16.6);
    expect(state.flash).toBeGreaterThan(0.5);
    expect(state.bass).toBeGreaterThan(0.3);
    expect(state.phase).toBeGreaterThan(phaseBefore);
    expect(state.cooldownMs).toBeGreaterThan(0);

    // Silence decays flash smoothly
    const afterDecay = stepBeatDetector(state, { bass: 0, subBass: 0, mid: 0, energy: 0 }, 200);
    expect(afterDecay.flash).toBeLessThan(state.flash);

    const root = process.cwd();
    // Beat Pulse layer MUST sit strictly underneath the UI (.beat-pulse-layer z-index: 0, .optical-root z-index: 1)
    const pulseCss = readFileSync(resolve(root, 'src', 'styles', 'beat-pulse.css'), 'utf8');
    expect(pulseCss).toMatch(/\.beat-pulse-layer\s*\{[^}]*z-index:\s*0/);
    expect(pulseCss).toMatch(/html\[data-ui-style='beat'\]\s+\.optical-root\s*\{[^}]*z-index:\s*1/);
    const sidebarSrc = readFileSync(resolve(root, 'src', 'components', 'sidebar', 'Sidebar.tsx'), 'utf8');
    expect(sidebarSrc).not.toContain("['history', 'Histórico'");
    expect(sidebarSrc).not.toContain("['settings', 'Configurações'");

    const topbarSrc = readFileSync(resolve(root, 'src', 'components', 'glass', 'GlassSearch.tsx'), 'utf8');
    expect(topbarSrc).toContain('Perfil e configurações');
    expect(topbarSrc).toContain('Histórico');
    expect(topbarSrc).toContain('Configurações');

    expect(existsSync(resolve(root, 'site', 'index.html'))).toBe(true);
    expect(existsSync(resolve(root, 'site', 'styles.css'))).toBe(true);
    expect(existsSync(resolve(root, 'site', 'app.js'))).toBe(true);
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
      expect(serviceKt).toContain('EXTRA_ARTWORK_URL');
      expect(serviceKt).toContain('METADATA_KEY_ALBUM_ART');
      // Regression guard: service must NEVER steal Android AudioFocus from Chromium WebView
      expect(serviceKt).not.toContain('requestAudioFocus');
      expect(serviceKt).not.toContain('AudioFocusRequest');
      expect(serviceKt).toContain('private var inForeground = false');

      const mainKt = readFileSync(
        join(appMain, 'java', 'com', 'nlzwrld', 'liquidhub', 'MainActivity.kt'),
        'utf8',
      );
      expect(mainKt).toContain('addJavascriptInterface(LiquidHubAndroidBridge(this), "LiquidHubAndroid")');
      expect(mainKt).toContain('LiquidHubMediaPlaybackService.isCurrentlyPlaying()');
      expect(mainKt).toContain('liquid:app-foreground');
      expect(mainKt).toContain('@JvmOverloads');
      expect(mainKt).toContain('resumeTimers()');
      expect(mainKt).toContain('playbackWanted');
      expect(mainKt).toContain('override fun onStop()');

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

      // Verify native Android WebView bridge syncing (including artworkUrl & immediate seek jump)
      resetAndroidNativeSyncCache();
      const updatePlayback = vi.fn();
      const stopPlayback = vi.fn();
      const prevWindow = (globalThis as { window?: unknown }).window;
      (globalThis as { window?: unknown }).window = {
        LiquidHubAndroid: { updatePlayback, stopPlayback },
      };
      try {
        const sampleTrack = {
          id: 'youtube:abc12345678',
          source: 'youtube' as const,
          sourceId: 'abc12345678',
          kind: 'track' as const,
          title: 'Neon Drift',
          artist: 'Liquid Artist',
          album: 'Beta Album',
          artwork: 'https://i.ytimg.com/vi/abc12345678/mqdefault.jpg',
          duration: 180,
          addedAt: Date.now(),
        };
        const nowSpy = vi.spyOn(Date, 'now');
        let clock = 1_700_000_000_000;
        nowSpy.mockImplementation(() => clock);
        try {
          syncMediaSessionMetadata(sampleTrack, true, 12.5, 180, null);
          expect(updatePlayback).toHaveBeenCalledTimes(1);
          expect(updatePlayback).toHaveBeenCalledWith(
            'Neon Drift',
            'Liquid Artist',
            'Beta Album',
            true,
            12500,
            180000,
            'https://i.ytimg.com/vi/abc12345678/mqdefault.jpg',
          );
          // Normal progressive playback ticks must NOT spam native updatePlayback / startForegroundService
          clock += 2_500;
          syncMediaSessionMetadata(sampleTrack, true, 15.0, 180, null);
          clock += 3_500;
          syncMediaSessionMetadata(sampleTrack, true, 18.5, 180, null);
          clock += 6_000;
          syncMediaSessionMetadata(sampleTrack, true, 24.5, 180, null);
          expect(updatePlayback).toHaveBeenCalledTimes(1);

          // Genuine seek jump (>2.5s divergence from expected elapsed playback) triggers instant lockscreen update
          syncMediaSessionMetadata(sampleTrack, true, 65.0, 180, null);
          expect(updatePlayback).toHaveBeenCalledTimes(2);
          expect(updatePlayback).toHaveBeenLastCalledWith(
            'Neon Drift',
            'Liquid Artist',
            'Beta Album',
            true,
            65000,
            180000,
            'https://i.ytimg.com/vi/abc12345678/mqdefault.jpg',
          );

          // Pausing immediately syncs playing=false
          syncMediaSessionMetadata(sampleTrack, false, 65.0, 180, null);
          expect(updatePlayback).toHaveBeenCalledTimes(3);
          expect(updatePlayback).toHaveBeenLastCalledWith(
            'Neon Drift',
            'Liquid Artist',
            'Beta Album',
            false,
            65000,
            180000,
            'https://i.ytimg.com/vi/abc12345678/mqdefault.jpg',
          );

          syncMediaSessionMetadata(null, false, 0, 0, null);
          expect(stopPlayback).toHaveBeenCalledTimes(1);
        } finally {
          nowSpy.mockRestore();
        }
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

  it('verifies multiplatform parity: 5-tab mobile nav, audio ducking, syncable preferences & unified release workflow', async () => {
    // 1. Mobile bottom nav must expose Home, Search, Library (not empty collection!), JAM and Profile
    const mobileNavSrc = readFileSync(
      join(process.cwd(), 'src', 'components', 'mobile', 'MobileBottomNav.tsx'),
      'utf8',
    );
    expect(mobileNavSrc).toContain("setPage('home')");
    expect(mobileNavSrc).toContain("setPage('search')");
    expect(mobileNavSrc).toContain("setPage('library')");
    expect(mobileNavSrc).toContain("setPage('jam')");
    expect(mobileNavSrc).not.toContain("setPage('collection')");

    // 2. Audio ducking lowers and restores cleanly on transient duck -> gain
    let duckedState = false;
    const focus = createAudioFocusManager({
      isPlaying: () => true,
      play: () => {},
      pause: () => {},
      setDucking: d => {
        duckedState = d;
      },
    });
    focus.handleAudioFocusChange('duck');
    expect(duckedState).toBe(true);
    focus.handleAudioFocusChange('gain');
    expect(duckedState).toBe(false);

    // 3. Cross-platform preferences filter excludes device-local fields
    const { pickSyncablePreferences } = await import('../../src/stores/accounts');
    const synced = pickSyncablePreferences({
      theme: 'dark',
      uiStyle: 'beat',
      accent: '#7c5cff',
      shuffleMode: 'smart',
      volume: 85,
      tray: true,
      startup: true,
      onlineConsent: true,
    });
    expect(synced).toEqual({
      theme: 'dark',
      uiStyle: 'beat',
      accent: '#7c5cff',
      shuffleMode: 'smart',
    });
    expect('volume' in synced).toBe(false);
    expect('tray' in synced).toBe(false);
    expect('startup' in synced).toBe(false);

    // 4. Unified release workflow builds Windows + Android APK/AAB and attaches APK to versioned GitHub Release
    const releaseYml = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    expect(releaseYml).toContain('build-windows:');
    expect(releaseYml).toContain('build-android:');
    expect(releaseYml).toContain('Liquid.Hub_${RELEASE_VERSION}_arm64.apk');
    expect(releaseYml).toContain('--extra-asset "$APK"');
    expect(releaseYml).toContain('android-beta');

    // 5. Real multiplatform sync roundtrip: Device A (Windows) <-> Device B (Android) via ZeroTrustAuthEngine
    const engine = new ZeroTrustAuthEngine({
      argon2Params: { memory: 1024, passes: 1, parallelism: 1, tagLength: 16 },
      clock: () => Date.now(),
    });
    const registered = engine.registerUser('multisync', 'SyncStrongPassword!2026');
    const userId = registered.id;
    // Windows saves playlist + tracks (local track must be stripped) + likes + syncable preferences (device-local keys stripped)
    const pushWin = engine.saveUserLibrary(userId, {
      playlists: [{ id: 'pl-1', name: 'Treino', trackIds: ['youtube:dQw4w9WgXcQ'] }],
      tracks: [
        { id: 'youtube:dQw4w9WgXcQ', source: 'youtube', title: 'Track 1', artist: 'Artist 1' },
        { id: 'local:secret', source: 'local', title: 'Local Only', artist: 'PC' },
      ],
      likes: ['youtube:dQw4w9WgXcQ'],
      preferences: {
        theme: 'dark',
        uiStyle: 'beat',
        accent: '#7c5cff',
        volume: 99,
        startup: true,
      },
    });
    expect(pushWin.ok).toBe(true);
    expect(pushWin.updatedAt).toBeGreaterThan(0);

    // Android pulls the exact synced library & preferences without local files or Windows-only keys
    const pullAndroid = engine.getUserLibrary(userId);
    expect(pullAndroid.playlists).toHaveLength(1);
    expect(pullAndroid.tracks).toHaveLength(1);
    expect((pullAndroid.tracks[0] as { id: string }).id).toBe('youtube:dQw4w9WgXcQ');
    expect(pullAndroid.likes).toEqual(['youtube:dQw4w9WgXcQ']);
    expect(pullAndroid.preferences).toEqual({
      theme: 'dark',
      uiStyle: 'beat',
      accent: '#7c5cff',
    });
  });
});
