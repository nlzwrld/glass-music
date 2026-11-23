import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
`;

const PROGUARD_RULES = `
# Liquid Hub Android Beta — preserve WebView JavascriptInterface & Media Service
-keepclassmembers class com.nlzwrld.liquidhub.** {
  @android.webkit.JavascriptInterface <methods>;
}
-keep class com.nlzwrld.liquidhub.media.LiquidHubMediaPlaybackService { *; }
`;

function buildMediaServiceKotlin(applicationId) {
  return `package ${applicationId}.media

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.webkit.WebView
import ${applicationId}.MainActivity
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class LiquidHubMediaPlaybackService : Service() {
    companion object {
        const val CHANNEL_ID = "liquid_hub_playback"
        const val NOTIFICATION_ID = 4102
        const val ACTION_UPDATE = "${applicationId}.action.MEDIA_UPDATE"
        const val ACTION_PLAY = "${applicationId}.action.MEDIA_PLAY"
        const val ACTION_PAUSE = "${applicationId}.action.MEDIA_PAUSE"
        const val ACTION_TOGGLE = "${applicationId}.action.MEDIA_TOGGLE"
        const val ACTION_NEXT = "${applicationId}.action.MEDIA_NEXT"
        const val ACTION_PREVIOUS = "${applicationId}.action.MEDIA_PREVIOUS"
        const val ACTION_STOP = "${applicationId}.action.MEDIA_STOP"

        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_ALBUM = "album"
        const val EXTRA_PLAYING = "playing"
        const val EXTRA_POSITION_MS = "positionMs"
        const val EXTRA_DURATION_MS = "durationMs"
        const val EXTRA_ARTWORK_URL = "artworkUrl"

        private val mainHandler = Handler(Looper.getMainLooper())
        private val playingFlag = AtomicBoolean(false)
        private val runningFlag = AtomicBoolean(false)
        @Volatile
        private var webViewRef: WeakReference<WebView>? = null

        fun attachWebView(webView: WebView?) {
            webViewRef = if (webView != null) WeakReference(webView) else null
        }

        fun isCurrentlyPlaying(): Boolean = playingFlag.get()
        fun isRunning(): Boolean = runningFlag.get()

        fun dispatchMediaAction(action: String, positionMs: Long? = null) {
            val escapedAction = action.replace("\\\\", "\\\\\\\\").replace("'", "\\\\'")
            val detail = if (positionMs != null) {
                "{ action: '$escapedAction', positionMs: $positionMs }"
            } else {
                "{ action: '$escapedAction' }"
            }
            val script = "window.dispatchEvent(new CustomEvent('liquid:android-media', { detail: $detail }));"
            evaluateInWebView(script)
        }

        fun dispatchAudioFocus(state: String) {
            val escaped = state.replace("\\\\", "\\\\\\\\").replace("'", "\\\\'")
            val script = "window.dispatchEvent(new CustomEvent('liquid:audio-focus', { detail: { state: '$escaped' } }));"
            evaluateInWebView(script)
        }

        private fun evaluateInWebView(script: String) {
            mainHandler.post {
                val webView = webViewRef?.get() ?: return@post
                try {
                    webView.evaluateJavascript(script, null)
                } catch (_: Throwable) {
                    // WebView may be detached during shutdown
                }
            }
        }
    }

    private lateinit var mediaSession: MediaSession
    private lateinit var audioManager: AudioManager
    private var audioFocusRequest: AudioFocusRequest? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var noisyReceiverRegistered = false

    private var currentTitle: String = "Liquid Hub"
    private var currentArtist: String = ""
    private var currentAlbum: String = "Liquid Hub"
    private var currentPlaying: Boolean = false
    private var currentPositionMs: Long = 0L
    private var currentDurationMs: Long = 0L
    private var currentArtworkUrl: String = ""
    @Volatile
    private var currentArtworkBitmap: Bitmap? = null
    private val artworkExecutor = Executors.newSingleThreadExecutor()

    private val becomingNoisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
                if (currentPlaying) {
                    currentPlaying = false
                    playingFlag.set(false)
                    releaseWakeLock()
                    updateSessionAndNotification()
                    dispatchAudioFocus("bluetooth_disconnect")
                }
            }
        }
    }

    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> dispatchAudioFocus("loss_transient")
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> dispatchAudioFocus("duck")
            AudioManager.AUDIOFOCUS_LOSS -> {
                abandonAudioFocus()
                dispatchAudioFocus("loss_permanent")
            }
            AudioManager.AUDIOFOCUS_GAIN -> dispatchAudioFocus("gain")
        }
    }

    override fun onCreate() {
        super.onCreate()
        runningFlag.set(true)
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        ensureNotificationChannel()

        mediaSession = MediaSession(this, "LiquidHubMediaSession").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() {
                    dispatchMediaAction("play")
                }

                override fun onPause() {
                    dispatchMediaAction("pause")
                }

                override fun onSkipToNext() {
                    dispatchMediaAction("next")
                }

                override fun onSkipToPrevious() {
                    dispatchMediaAction("previous")
                }

                override fun onSeekTo(pos: Long) {
                    dispatchMediaAction("seek", pos)
                }

                override fun onStop() {
                    dispatchMediaAction("stop")
                    stopPlaybackService()
                }
            })
            isActive = true
        }

        val noisyFilter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(becomingNoisyReceiver, noisyFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(becomingNoisyReceiver, noisyFilter)
        }
        noisyReceiverRegistered = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY -> dispatchMediaAction("play")
            ACTION_PAUSE -> dispatchMediaAction("pause")
            ACTION_TOGGLE -> dispatchMediaAction("toggle")
            ACTION_NEXT -> dispatchMediaAction("next")
            ACTION_PREVIOUS -> dispatchMediaAction("previous")
            ACTION_STOP -> {
                dispatchMediaAction("stop")
                stopPlaybackService()
                return START_NOT_STICKY
            }
            ACTION_UPDATE, null -> {
                if (intent != null) {
                    currentTitle = intent.getStringExtra(EXTRA_TITLE)?.take(120).orEmpty().ifBlank { "Liquid Hub" }
                    currentArtist = intent.getStringExtra(EXTRA_ARTIST)?.take(120).orEmpty()
                    currentAlbum = intent.getStringExtra(EXTRA_ALBUM)?.take(120).orEmpty().ifBlank { "Liquid Hub" }
                    currentPlaying = intent.getBooleanExtra(EXTRA_PLAYING, false)
                    currentPositionMs = intent.getLongExtra(EXTRA_POSITION_MS, 0L).coerceAtLeast(0L)
                    currentDurationMs = intent.getLongExtra(EXTRA_DURATION_MS, 0L).coerceAtLeast(0L)
                    val nextArt = intent.getStringExtra(EXTRA_ARTWORK_URL)?.trim().orEmpty()
                    if (nextArt != currentArtworkUrl) {
                        currentArtworkUrl = nextArt
                        currentArtworkBitmap = null
                        if (nextArt.startsWith("https://")) {
                            loadArtworkAsync(nextArt)
                        }
                    }
                }
                playingFlag.set(currentPlaying)
                if (currentPlaying) {
                    requestAudioFocus()
                    acquireWakeLock()
                } else {
                    releaseWakeLock()
                }
                updateSessionAndNotification()
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!currentPlaying) {
            stopPlaybackService()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        runningFlag.set(false)
        playingFlag.set(false)
        releaseWakeLock()
        abandonAudioFocus()
        if (noisyReceiverRegistered) {
            try {
                unregisterReceiver(becomingNoisyReceiver)
            } catch (_: Throwable) {
            }
            noisyReceiverRegistered = false
        }
        try {
            mediaSession.isActive = false
            mediaSession.release()
        } catch (_: Throwable) {
        }
        try {
            artworkExecutor.shutdownNow()
        } catch (_: Throwable) {
        }
        super.onDestroy()
    }

    private fun loadArtworkAsync(urlStr: String) {
        artworkExecutor.execute {
            try {
                val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 4000
                    readTimeout = 4000
                    instanceFollowRedirects = true
                }
                if (conn.responseCode in 200..299) {
                    val raw = conn.inputStream.use { it.readBytes() }
                    if (raw.isNotEmpty() && raw.size <= 1_500_000) {
                        val decoded = BitmapFactory.decodeByteArray(raw, 0, raw.size)
                        if (decoded != null) {
                            val scaled = if (decoded.width > 320 || decoded.height > 320) {
                                Bitmap.createScaledBitmap(decoded, 320, 320, true)
                            } else {
                                decoded
                            }
                            if (currentArtworkUrl == urlStr && runningFlag.get()) {
                                currentArtworkBitmap = scaled
                                mainHandler.post {
                                    if (runningFlag.get() && currentArtworkUrl == urlStr) {
                                        updateSessionAndNotification()
                                    }
                                }
                            }
                        }
                    }
                }
                conn.disconnect()
            } catch (_: Throwable) {
            }
        }
    }

    private fun stopPlaybackService() {
        currentPlaying = false
        playingFlag.set(false)
        releaseWakeLock()
        abandonAudioFocus()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Reprodução de música",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Controles de reprodução em segundo plano do Liquid Hub"
                    setShowBadge(false)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    setSound(null, null)
                    enableVibration(false)
                }
                manager.createNotificationChannel(channel)
            }
        }
    }

    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
                audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener(audioFocusListener, mainHandler)
                    .build()
            }
            audioFocusRequest?.let { audioManager.requestAudioFocus(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                audioFocusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            )
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(audioFocusListener)
        }
    }

    private fun acquireWakeLock() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LiquidHub:PlaybackWakeLock").apply {
                    setReferenceCounted(false)
                }
            }
            if (wakeLock?.isHeld != true) {
                wakeLock?.acquire(4L * 60L * 60L * 1000L)
            }
        } catch (_: Throwable) {
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Throwable) {
        }
    }

    private fun servicePendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, LiquidHubMediaPlaybackService::class.java).apply {
            this.action = action
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getService(this, requestCode, intent, flags)
    }

    private fun buildNotification(): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentIntent = PendingIntent.getActivity(
            this,
            100,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val prevAction = Notification.Action.Builder(
            android.R.drawable.ic_media_previous,
            "Anterior",
            servicePendingIntent(ACTION_PREVIOUS, 101)
        ).build()

        val playPauseAction = if (currentPlaying) {
            Notification.Action.Builder(
                android.R.drawable.ic_media_pause,
                "Pausar",
                servicePendingIntent(ACTION_PAUSE, 102)
            ).build()
        } else {
            Notification.Action.Builder(
                android.R.drawable.ic_media_play,
                "Reproduzir",
                servicePendingIntent(ACTION_PLAY, 103)
            ).build()
        }

        val nextAction = Notification.Action.Builder(
            android.R.drawable.ic_media_next,
            "Próxima",
            servicePendingIntent(ACTION_NEXT, 104)
        ).build()

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val style = Notification.MediaStyle()
            .setMediaSession(mediaSession.sessionToken)
            .setShowActionsInCompactView(0, 1, 2)

        val built = builder
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist.ifBlank { "Liquid Hub" })
            .setSubText(currentAlbum)
            .setContentIntent(contentIntent)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(currentPlaying)
            .setOnlyAlertOnce(true)
            .addAction(prevAction)
            .addAction(playPauseAction)
            .addAction(nextAction)
            .setStyle(style)
        currentArtworkBitmap?.let { built.setLargeIcon(it) }
        return built.build()
    }

    private fun updateSessionAndNotification() {
        val actions = PlaybackState.ACTION_PLAY or
            PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or
            PlaybackState.ACTION_SKIP_TO_PREVIOUS or
            PlaybackState.ACTION_SEEK_TO or
            PlaybackState.ACTION_STOP

        val playbackState = PlaybackState.Builder()
            .setActions(actions)
            .setState(
                if (currentPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                currentPositionMs,
                if (currentPlaying) 1.0f else 0.0f
            )
            .build()
        mediaSession.setPlaybackState(playbackState)

        val metaBuilder = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, currentAlbum)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, currentDurationMs)
        currentArtworkBitmap?.let {
            metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it)
        }
        mediaSession.setMetadata(metaBuilder.build())

        val notification = buildNotification()
        if (currentPlaying) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_DETACH)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.notify(NOTIFICATION_ID, notification)
        }
    }
}
`;
}

function buildMainActivityKotlin(applicationId) {
  return `package ${applicationId}

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.core.content.ContextCompat
import ${applicationId}.media.LiquidHubMediaPlaybackService

class MainActivity : TauriActivity() {
    private var activeWebView: WebView? = null
    private var requestedNotificationPermission = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawable(ColorDrawable(Color.parseColor("#0B0E11")))
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        activeWebView = webView
        webView.setBackgroundColor(Color.parseColor("#0B0E11"))
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        webView.addJavascriptInterface(LiquidHubAndroidBridge(this), "LiquidHubAndroid")
        LiquidHubMediaPlaybackService.attachWebView(webView)
    }

    override fun onPause() {
        super.onPause()
        // Keep WebView audio and playback queue timers alive when screen locks or app is backgrounded
        if (LiquidHubMediaPlaybackService.isCurrentlyPlaying()) {
            activeWebView?.onResume()
        }
    }

    override fun onResume() {
        super.onResume()
        activeWebView?.onResume()
        activeWebView?.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('liquid:app-foreground'));",
            null
        )
    }

    override fun onDestroy() {
        LiquidHubMediaPlaybackService.attachWebView(null)
        if (isFinishing) {
            stopService(Intent(this, LiquidHubMediaPlaybackService::class.java))
        }
        activeWebView = null
        super.onDestroy()
    }

    internal fun ensureNotificationPermissionOnce() {
        if (requestedNotificationPermission || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        requestedNotificationPermission = true
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            runOnUiThread {
                try {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { }
                } catch (_: Throwable) {
                }
            }
        }
    }

    private class LiquidHubAndroidBridge(private val activity: MainActivity) {
        @JavascriptInterface
        fun isNativeBridgeReady(): Boolean = true

        @JavascriptInterface
        @JvmOverloads
        fun updatePlayback(
            title: String?,
            artist: String?,
            album: String?,
            playing: Boolean,
            positionMs: Long,
            durationMs: Long,
            artworkUrl: String? = null
        ) {
            if (!playing && !LiquidHubMediaPlaybackService.isRunning()) {
                return
            }
            if (playing) {
                activity.ensureNotificationPermissionOnce()
            }
            val intent = Intent(activity, LiquidHubMediaPlaybackService::class.java).apply {
                action = LiquidHubMediaPlaybackService.ACTION_UPDATE
                putExtra(LiquidHubMediaPlaybackService.EXTRA_TITLE, title ?: "Liquid Hub")
                putExtra(LiquidHubMediaPlaybackService.EXTRA_ARTIST, artist ?: "")
                putExtra(LiquidHubMediaPlaybackService.EXTRA_ALBUM, album ?: "Liquid Hub")
                putExtra(LiquidHubMediaPlaybackService.EXTRA_PLAYING, playing)
                putExtra(LiquidHubMediaPlaybackService.EXTRA_POSITION_MS, positionMs)
                putExtra(LiquidHubMediaPlaybackService.EXTRA_DURATION_MS, durationMs)
                putExtra(LiquidHubMediaPlaybackService.EXTRA_ARTWORK_URL, artworkUrl ?: "")
            }
            try {
                if (playing && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent)
                } else {
                    activity.startService(intent)
                }
            } catch (_: Throwable) {
            }
        }

        @JavascriptInterface
        fun stopPlayback() {
            val intent = Intent(activity, LiquidHubMediaPlaybackService::class.java).apply {
                action = LiquidHubMediaPlaybackService.ACTION_STOP
            }
            try {
                activity.startService(intent)
            } catch (_: Throwable) {
            }
        }
    }
}
`;
}

export function patchAndroidManifest(xml, config) {
  let out = xml;
  const permissions = Array.from(
    new Set([...(config.permissions || []), 'android.permission.POST_NOTIFICATIONS']),
  );

  for (const perm of permissions) {
    if (!out.includes(`android:name="${perm}"`)) {
      out = out.replace(
        /<application\b/,
        `    <uses-permission android:name="${perm}" />\n\n    <application`,
      );
    }
  }

  if (!out.includes('android:networkSecurityConfig=')) {
    out = out.replace(
      /<application\b/,
      '<application\n        android:networkSecurityConfig="@xml/network_security_config"',
    );
  }

  if (!out.includes('android:launchMode=')) {
    out = out.replace(
      /<activity\b/,
      '<activity\n            android:launchMode="singleTask"',
    );
  }

  if (!out.includes('android:scheme="liquidhub"')) {
    const hosts = config.deepLinks?.[0]?.hosts || ['auth', 'jam', 'profile', 'playlist', 'track'];
    const dataTags = hosts
      .map(host => `                <data android:scheme="liquidhub" android:host="${host}" />`)
      .join('\n');
    const deepLinkFilter = `\n            <intent-filter>\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n${dataTags}\n            </intent-filter>`;
    out = out.replace(/(<\/activity>)/, `${deepLinkFilter}\n        $1`);
  }

  if (!out.includes('LiquidHubMediaPlaybackService')) {
    const serviceBlock = `\n        <service\n            android:name=".media.LiquidHubMediaPlaybackService"\n            android:exported="false"\n            android:foregroundServiceType="mediaPlayback">\n            <intent-filter>\n                <action android:name="android.intent.action.MEDIA_BUTTON" />\n            </intent-filter>\n        </service>`;
    out = out.replace(/(<\/application>)/, `${serviceBlock}\n    $1`);
  }

  return out;
}

export function patchAppBuildGradle(gradle, config) {
  let out = gradle;
  const minSdk = Number(config.minSdkVersion || 26);
  const targetSdk = Number(config.targetSdkVersion || 35);
  const compileSdk = Math.max(Number(config.compileSdkVersion || 36), 36);
  const versionCode = Number(process.env.LIQUID_ANDROID_VERSION_CODE || config.versionCode || 20200);
  const versionName = String(
    process.env.LIQUID_ANDROID_VERSION_NAME || config.versionName || '2.2.0-beta.1',
  );

  out = out.replace(/compileSdk\s*=\s*\d+/, m => {
    const existing = Number(m.match(/\d+/)?.[0] || 0);
    return `compileSdk = ${Math.max(existing, compileSdk)}`;
  });
  out = out.replace(/minSdk\s*=\s*\d+/, `minSdk = ${minSdk}`);
  out = out.replace(/targetSdk\s*=\s*\d+/, `targetSdk = ${targetSdk}`);
  out = out.replace(/versionCode\s*=\s*[^\n]+/, `versionCode = ${versionCode}`);
  out = out.replace(/versionName\s*=\s*[^\n]+/, `versionName = "${versionName}"`);

  if (!out.includes('LIQUID_ANDROID_KEYSTORE_PATH')) {
    const signingBlock = `
    signingConfigs {
        val ksPath = System.getenv("LIQUID_ANDROID_KEYSTORE_PATH")
        if (!ksPath.isNullOrBlank()) {
            create("release") {
                storeFile = file(ksPath)
                storePassword = System.getenv("LIQUID_ANDROID_KEYSTORE_PASS") ?: ""
                keyAlias = System.getenv("LIQUID_ANDROID_KEY_ALIAS") ?: "liquidhub"
                keyPassword = System.getenv("LIQUID_ANDROID_KEY_PASS") ?: ""
            }
        }
    }
`;
    out = out.replace(/buildTypes\s*\{/, `${signingBlock}\n    buildTypes {`);
    out = out.replace(
      /((?:getByName\("release"\)|release)\s*\{)/,
      `$1\n            if (!System.getenv("LIQUID_ANDROID_KEYSTORE_PATH").isNullOrBlank()) {\n                signingConfig = signingConfigs.getByName("release")\n            }`,
    );
  }

  return out;
}

export function setupAndroidProject(rootDir = process.cwd(), options = {}) {
  const configPath = resolve(rootDir, 'src-tauri', 'android-beta.json');
  if (!existsSync(configPath)) {
    throw new Error(`Configuração ausente: ${configPath}`);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const androidDir = options.androidDir || resolve(rootDir, 'src-tauri', 'gen', 'android');
  const appDir = resolve(androidDir, 'app');
  if (!existsSync(appDir)) {
    throw new Error(
      `Projeto Android ainda não inicializado em ${androidDir}. Execute "pnpm tauri android init --ci" primeiro.`,
    );
  }

  const appId = config.applicationId || 'com.nlzwrld.liquidhub';
  const pkgSegments = appId.split('.');
  const javaRoot = resolve(appDir, 'src', 'main', 'java', ...pkgSegments);

  // 1. Network security config (allow loopback 127.0.0.1 HTTP for Rust media proxy only)
  const netSecPath = resolve(appDir, 'src', 'main', 'res', 'xml', 'network_security_config.xml');
  mkdirSync(dirname(netSecPath), { recursive: true });
  writeFileSync(netSecPath, NETWORK_SECURITY_CONFIG_XML, 'utf8');

  // 2. Patch AndroidManifest.xml
  const manifestPath = resolve(appDir, 'src', 'main', 'AndroidManifest.xml');
  if (!existsSync(manifestPath)) {
    throw new Error(`AndroidManifest.xml ausente em ${manifestPath}`);
  }
  const manifestContent = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, patchAndroidManifest(manifestContent, config), 'utf8');

  // 3. Write LiquidHubMediaPlaybackService.kt
  const servicePath = resolve(javaRoot, 'media', 'LiquidHubMediaPlaybackService.kt');
  mkdirSync(dirname(servicePath), { recursive: true });
  writeFileSync(servicePath, buildMediaServiceKotlin(appId), 'utf8');

  // 4. Write MainActivity.kt (WebView JS bridge + background audio continuity)
  const mainActivityPath = resolve(javaRoot, 'MainActivity.kt');
  mkdirSync(dirname(mainActivityPath), { recursive: true });
  writeFileSync(mainActivityPath, buildMainActivityKotlin(appId), 'utf8');

  // 5. Patch app/build.gradle.kts (SDK versions, versionCode/versionName, signingConfigs)
  const gradlePath = resolve(appDir, 'build.gradle.kts');
  if (existsSync(gradlePath)) {
    const gradleContent = readFileSync(gradlePath, 'utf8');
    writeFileSync(gradlePath, patchAppBuildGradle(gradleContent, config), 'utf8');
  }

  // 6. Append ProGuard keep rules for JavascriptInterface & Media Service
  const proguardPath = resolve(appDir, 'proguard-rules.pro');
  const existingProguard = existsSync(proguardPath) ? readFileSync(proguardPath, 'utf8') : '';
  if (!existingProguard.includes('LiquidHubMediaPlaybackService')) {
    writeFileSync(proguardPath, `${existingProguard.trimEnd()}\n${PROGUARD_RULES}`, 'utf8');
  }

  return {
    ok: true,
    androidDir,
    applicationId: appId,
    filesUpdated: [
      manifestPath,
      netSecPath,
      servicePath,
      mainActivityPath,
      gradlePath,
      proguardPath,
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = setupAndroidProject(process.cwd());
  console.log(JSON.stringify(result, null, 2));
}
