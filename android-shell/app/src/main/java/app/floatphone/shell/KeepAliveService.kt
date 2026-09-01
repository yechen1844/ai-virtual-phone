package app.floatphone.shell

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.core.app.NotificationCompat

/**
 * float 保活服务（纯本地，不依赖账号/网络）：
 *  - 前台服务 + 常驻通知（系统认为是媒体类前台服务）
 *  - 内置 20s 静音音频本地循环 → "正在播放"，存活优先级高
 *  - 系统级悬浮球（SYSTEM_ALERT_WINDOW overlay）——关闭 float 界面后仍在
 *  [KeepAliveService] 同时承载保活与悬浮球，网页经 JS 桥启停。
 */
class KeepAliveService : Service() {

    companion object {
        private const val CH = "float_keepalive"
        private const val NOTIF_ID = 81
        /** companion 持有当前实例，供 JS 桥调用（避免跨线程查 findService） */
        @Volatile var instance: KeepAliveService? = null

        fun start(c: Context) {
            val i = Intent(c, KeepAliveService::class.java)
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i) else c.startService(i)
        }
        fun stop(c: Context) {
            c.stopService(Intent(c, KeepAliveService::class.java))
        }
    }

    private var player: MediaPlayer? = null
    private var wm: WindowManager? = null
    private var ball: View? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        startForeground(
            NOTIF_ID,
            buildNotif("保活运行中"),
            if (Build.VERSION.SDK_INT >= 29)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            else 0,
        )
        startSilenceLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Settings.canDrawOverlays(this)) ensureBall()
        return START_STICKY
    }

    override fun onDestroy() {
        player?.release(); player = null
        removeBall()
        instance = null
        super.onDestroy()
    }

    // ── 静音音频循环保活 ──
    private fun startSilenceLoop() {
        runCatching {
            val p = MediaPlayer.create(this, R.raw.silence)
            p.isLooping = true
            p.setVolume(0f, 0f)
            p.start()
            player = p
        }.onFailure {
            player = null
        }
    }

    // ── 悬浮球（系统 overlay）──
    @SuppressLint("ClickableViewAccessibility")
    fun showBall() {
        if (ball != null) return
        if (!Settings.canDrawOverlays(this)) return
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val size = (resources.displayMetrics.density * 56).toInt()
        val lp = WindowManager.LayoutParams(
            size, size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP or Gravity.START; x = 0; y = 300 }
        val tv = TextView(this).apply {
            text = "🎮"
            textSize = 28f
            gravity = Gravity.CENTER
            setBackgroundColor(0xCC2C2C50)
        }
        val origin = IntArray(2)
        tv.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { v.getLocationInWindow(origin); false }
                MotionEvent.ACTION_MOVE -> {
                    val lp2 = lp
                    lp2.x = origin[0] + e.rawX.toInt() - v.left
                    lp2.y = origin[1] + e.rawY.toInt() - v.top
                    wm?.updateViewLayout(v, lp2)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    val dx = e.rawX - origin[0]
                    val dy = e.rawY - origin[1]
                    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
                        rIPToFront()
                    }
                    true
                }
                else -> false
            }
        }
        try { wm?.addView(tv, lp); ball = tv } catch (e: Exception) { ball = null }
    }

    fun hideBall() { removeBall() }

    private fun removeBall() {
        ball?.let { runCatching { wm?.removeView(it) } }
        ball = null
    }

    private fun rIPToFront() {
        val i = Intent(this, MainActivity::class.java).addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        )
        startActivity(i)
    }

    // ── 通知 ──
    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CH, "float 保活", NotificationManager.IMPORTANCE_MIN)
        )
    }

    private fun buildNotif(text: String): Notification =
        NotificationCompat.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("float")
            .setContentText(text)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, 0,
                    Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE,
                )
            )
            .build()
}