const REPO = 'nlzwrld/glass-music';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function isAndroidDevice() {
  return /\bAndroid\b/i.test(navigator.userAgent || '');
}

async function hydrateReleases() {
  const androidPreferred = isAndroidDevice();
  const primaryBtn = document.getElementById('primary-download-btn');
  const primaryLabel = document.getElementById('primary-download-label');
  const secondaryBtn = document.getElementById('secondary-download-btn');
  const secondaryLabel = document.getElementById('secondary-download-label');
  const pill = document.getElementById('live-version-pill');

  const winBtn = document.getElementById('win-download-btn');
  const winVer = document.getElementById('win-version');
  const winSize = document.getElementById('win-size');

  const apkBtn = document.getElementById('android-apk-btn');
  const aabBtn = document.getElementById('android-aab-btn');
  const androidVer = document.getElementById('android-version');
  const androidSize = document.getElementById('android-size');

  let winUrl = `https://github.com/${REPO}/releases/latest`;
  let winTag = '';
  let apkUrl = `https://github.com/${REPO}/releases/tag/android-beta`;
  let androidTag = '';

  try {
    const [winRes, androidRes] = await Promise.allSettled([
      fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      }),
      fetch(`https://api.github.com/repos/${REPO}/releases/tags/android-beta`, {
        headers: { Accept: 'application/vnd.github+json' },
      }),
    ]);

    let foundApkInLatest = false;
    if (winRes.status === 'fulfilled' && winRes.value.ok) {
      const rel = await winRes.value.json();
      winTag = rel.tag_name || '';
      const assets = rel.assets || [];
      const exe = assets.find(a => /\.exe$/i.test(a.name));
      if (exe?.browser_download_url) {
        winUrl = exe.browser_download_url;
        if (winBtn) winBtn.href = winUrl;
        if (winSize && exe.size) winSize.textContent = `${formatBytes(exe.size)} · 64-bit`;
      }
      if (winVer && winTag) winVer.textContent = winTag;

      const latestApk = assets.find(a => /\.apk$/i.test(a.name));
      const latestAab = assets.find(a => /\.aab$/i.test(a.name));
      if (latestApk?.browser_download_url) {
        foundApkInLatest = true;
        apkUrl = latestApk.browser_download_url;
        if (apkBtn) apkBtn.href = apkUrl;
        if (androidSize && latestApk.size) androidSize.textContent = `${formatBytes(latestApk.size)} · arm64`;
        if (androidVer && winTag) androidVer.textContent = winTag;
      }
      if (latestAab?.browser_download_url && aabBtn) {
        aabBtn.href = latestAab.browser_download_url;
      }
    }

    if (!foundApkInLatest && androidRes.status === 'fulfilled' && androidRes.value.ok) {
      const rel = await androidRes.value.json();
      androidTag = rel.name || 'Android Beta';
      const apk = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
      const aab = (rel.assets || []).find(a => /\.aab$/i.test(a.name));
      if (apk?.browser_download_url) {
        apkUrl = apk.browser_download_url;
        if (apkBtn) apkBtn.href = apkUrl;
        if (androidSize && apk.size) androidSize.textContent = `${formatBytes(apk.size)} · arm64`;
      }
      if (aab?.browser_download_url && aabBtn) {
        aabBtn.href = aab.browser_download_url;
      }
      const match = /\(([^)]+)\)/.exec(androidTag);
      if (androidVer) androidVer.textContent = match ? match[1] : 'Beta';
    }
  } catch {
    // Fallback links to GitHub Releases remain valid offline/rate-limited
  }

  if (pill && winTag) {
    pill.textContent = `${winTag} · Windows e Android Beta`;
  }

  if (androidPreferred) {
    if (primaryBtn) primaryBtn.href = apkUrl;
    if (primaryLabel) primaryLabel.textContent = 'Baixar para Android (Beta)';
    if (secondaryBtn) secondaryBtn.href = winUrl;
    if (secondaryLabel) secondaryLabel.textContent = `Windows ${winTag || '(.exe)'}`;
  } else {
    if (primaryBtn) primaryBtn.href = winUrl;
    if (primaryLabel) primaryLabel.textContent = `Baixar para Windows${winTag ? ` (${winTag})` : ''}`;
    if (secondaryBtn) secondaryBtn.href = apkUrl;
    if (secondaryLabel) secondaryLabel.textContent = 'Android Beta (.apk)';
  }
}

void hydrateReleases();
