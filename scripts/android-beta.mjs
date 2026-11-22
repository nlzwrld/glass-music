import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setupAndroidProject } from './android-setup.mjs';

export function validateAndroidBetaConfig(rootDir = process.cwd()) {
  const configPath = resolve(rootDir, 'src-tauri', 'android-beta.json');
  if (!existsSync(configPath)) {
    throw new Error('Configuração src-tauri/android-beta.json ausente.');
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const requiredPerms = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.WAKE_LOCK',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.BLUETOOTH_CONNECT',
  ];
  for (const perm of requiredPerms) {
    if (!Array.isArray(config.permissions) || !config.permissions.includes(perm)) {
      throw new Error(`Permissão obrigatória ausente no manifesto Android Beta: ${perm}`);
    }
  }
  const hasMediaService =
    Array.isArray(config.services) &&
    config.services.some(s => s.foregroundServiceType === 'mediaPlayback');
  if (!hasMediaService) {
    throw new Error('Serviço foreground mediaPlayback ausente em src-tauri/android-beta.json.');
  }
  if (!config.buildTargets?.apk || !config.buildTargets?.aab) {
    throw new Error('Targets de build APK e AAB devem estar declarados.');
  }
  const sdkEnv = {
    ANDROID_HOME: Boolean(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT),
    NDK_HOME: Boolean(process.env.NDK_HOME || process.env.ANDROID_NDK_HOME),
    JAVA_HOME: Boolean(process.env.JAVA_HOME),
  };
  return {
    ok: true,
    applicationId: config.applicationId,
    versionName: config.versionName,
    minSdkVersion: config.minSdkVersion,
    targetSdkVersion: config.targetSdkVersion,
    permissionsCount: config.permissions.length,
    sdkEnv,
    apkCommand: config.buildTargets.apk.command,
    aabCommand: config.buildTargets.aab.command,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2] || 'check';
  const summary = validateAndroidBetaConfig();
  if (mode === 'check') {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }
  if (mode === 'setup') {
    const res = setupAndroidProject(process.cwd());
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
  if (mode === 'apk' || mode === 'aab') {
    if (!summary.sdkEnv.ANDROID_HOME) {
      console.error(
        `ANDROID_HOME / ANDROID_SDK_ROOT não detectado no ambiente atual. Manifesto validado (${summary.applicationId} ${summary.versionName}); configure o Android SDK/NDK e execute: pnpm android:${mode}`,
      );
      process.exit(1);
    }
    const genDir = resolve(process.cwd(), 'src-tauri', 'gen', 'android');
    if (!existsSync(genDir)) {
      const initRes = spawnSync('pnpm', ['tauri', 'android', 'init', '--ci'], {
        stdio: 'inherit',
        shell: true,
      });
      if ((initRes.status ?? 1) !== 0) {
        process.exit(initRes.status ?? 1);
      }
    }
    setupAndroidProject(process.cwd());
    const flag = mode === 'apk' ? '--apk' : '--aab';
    const res = spawnSync('pnpm', ['tauri', 'android', 'build', flag], {
      stdio: 'inherit',
      shell: true,
    });
    process.exit(res.status ?? 1);
  }
}
