package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.webkit.CookieManager
import android.media.session.MediaSession
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * 推送前台服务：不依赖 Google 服务的自建长连接。
 *
 * 原理：用 WebView 里已登录的站点 Cookie 调用站点接口拿到
 * Supabase 地址 / anon key / 当前用户 id，然后用 OkHttp WebSocket
 * 直连 Supabase Realtime，订阅个人频道 shellpush:<userId>。
 * 服务端（push-generate / 测试按钮）发离线消息时会向该频道广播一份，
 * 本服务收到即弹系统通知——App 被杀也能收（前台服务存活期间）。
 */
class PushService : Service() {

    companion object {
        private const val LOG_TAG = "FloatShellPush"
        private const val CH_KEEPALIVE = "shell_keepalive"
        private const val CH_MESSAGES = "shell_messages"
        private const val CH_CALLS = "shell_calls"
        private const val NOTIF_FG_ID = 1
        /** 订阅 join 的 ref（用于识别 join 回执） */
        private const val JOIN_REF = "1"
        private var running = false

        fun start(context: Context) {
            if (running) return
            val intent = Intent(context, PushService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var socket: WebSocket? = null
    private var stopped = false
    private var msgSeq = 2
    private var notifId = 100
    private var shellSubRegistered = false
    /** 当前常驻通知文案：只在真的变化时才 notify，避免同一状态被反复刷新。 */
    private var currentNotifText: String? = null

    // 保活增强用的“活跃媒体会话”：不申请音频焦点、不实际播放任何声音，
    // 只让系统认为有个正在使用的媒体服务 → 整体存活优先级更高。
    // 正因为从不 requestAudioFocus / 从不 start 播放器，前台网页放歌/语音完全不受影响。
    private var mediaSession: MediaSession? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        createChannels()
        mediaSession = MediaSession(this, "float").apply { setActive(true) }
        startForeground(
            NOTIF_FG_ID,
            buildKeepAliveNotification("等待连接…"),
            if (Build.VERSION.SDK_INT >= 29)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            else 0,
        )
        thread(name = "shell-push-loop") { connectionLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        stopped = true
        running = false
        socket?.cancel()
        mediaSession?.release()
        mediaSession = null
        super.onDestroy()
    }

    // ── 连接循环：拿配置 → 连 WS → 断线退避重连 ──
    //
    // 稳定性要点（针对运营商掐长连接）：
    //  1) 配置拉取失败不能当成「未启用」——瞬时网络抖动只短暂退避，不干等 60 秒；
    //  2) 连接活过 1 分钟就算「稳定过」，退避立刻回到最短，避免反复被掐后一路涨到 120 秒；
    //  3) 短到 20 秒内就接回来的闪断，不改通知文案（避免刷屏），真的断了才提示。
    private fun connectionLoop() {
        var backoffSec = 5L
        while (!stopped) {
            when (val result = fetchConfig()) {
                is ConfigResult.NotConfigured -> {
                    updateKeepAlive("离线推送未启用")
                    sleepSec(60)
                    continue
                }
                is ConfigResult.Unreachable -> {
                    // 拉不到配置（网络问题，不是没配）：保持原文案，短退避后重试
                    Log.d(LOG_TAG, "connLoop: config unreachable, retry in 15s")
                    sleepSec(15)
                    continue
                }
                is ConfigResult.Ok -> {
                    val startedAt = System.currentTimeMillis()
                    val run = runSocket(result.config)
                    if (stopped) break
                    val stable = run.aliveMs >= 60_000
                    val disconnectedAt = System.currentTimeMillis()
                    if (stable) backoffSec = 5L
                    val delaySec = if (stable) 3L else backoffSec
                    Log.d(
                        LOG_TAG,
                        "connLoop: joined=${run.joinedOk} alive=${run.aliveMs}ms delay=${delaySec}s backoff=${backoffSec}s (total ${System.currentTimeMillis() - startedAt}ms)",
                    )
                    // 闪断：先用最短延迟抢回来；只有超过 20 秒还没接上才把文案改成重连中
                    sleepSec(delaySec)
                    if (stopped) break
                    if (System.currentTimeMillis() - disconnectedAt > 20_000) {
                        updateKeepAlive("连接断开，重连中…")
                    }
                    if (!stable) backoffSec = (backoffSec * 2).coerceAtMost(120)
                }
            }
        }
    }

    private data class PushConfig(
        val supabaseUrl: String,
        val anonKey: String,
        val userId: String,
        /** 离线推送中转地址（站点 /api/online/config 的 pushRelayUrl）；空串 = 直连 Supabase */
        val relayUrl: String = "",
    )

    /** 配置拉取结果：区分「真的没配置」与「网络暂时不通」，两者处理方式完全不同。 */
    private sealed class ConfigResult {
        data class Ok(val config: PushConfig) : ConfigResult()
        object NotConfigured : ConfigResult()
        object Unreachable : ConfigResult()
    }

    /** 取一个站点 JSON 接口；网络异常/非 2xx 都会抛异常（由调用方决定是重试还是当成未配置）。 */
    private fun fetchJson(path: String): JSONObject {
        val request = Request.Builder()
            .url("${MainActivity.SITE_URL}$path")
            .header("Accept", "application/json")
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}")
            val body = response.body?.string() ?: throw IllegalStateException("empty body")
            return JSONObject(body)
        }
    }

    /**
     * 获取连接参数。float 自托管模式（NEXT_PUBLIC_SELF_HOSTED_MODE=true）下，
     * 服务端不校验登录 Cookie，getCurrentAccount 直接返回 local_user 身份。
     * 因此壳不再强求站点 Cookie——否则免登录环境因 getCookie 为 null 永远
     * "未登录或站点不可达"，Realtime 长连接也建不起来。
     */
    private fun fetchConfig(): ConfigResult {
        return try {
            // 离线推送的身份必须与个人云服务端一致：个人云固定 OWNER_ID="owner"，
            // push-generate 只按 user_id=eq.owner 取订阅、广播到 shellpush:owner。
            // 此前硬编码 local_user，导致「喊 owner / 听 local_user」频道对不上，收不到广播。
            val userId = "owner"
            // 优先用「float 设置里配好的 Supabase」(recordSupabase 存 SharedPreferences)，否则回退服务器 /api/online/config
            val sp = getSharedPreferences("float_supabase", 0)
            var url = sp.getString("url", "")?.trim().orEmpty()
            var key = sp.getString("key", "")?.trim().orEmpty()
            // 中转地址单独存一份：站点暂时连不上时沿用上次拿到的，避免无声退化成直连
            val spPush = getSharedPreferences("float_push", 0)
            var relayUrl = ""

            // 站点配置每次都要问——中转地址只在这里下发，和本地有没有存 Supabase 凭据无关。
            // （早先只在本机没凭据时才请求，那样本地一旦存过凭据就永远拿不到中转地址。）
            val online = try {
                fetchJson("/api/online/config")
            } catch (e: Exception) {
                Log.d(LOG_TAG, "fetchConfig: /api/online/config failed: ${e.message}")
                if (url.isEmpty() || key.isEmpty()) return ConfigResult.Unreachable
                relayUrl = spPush.getString("relay", "")?.trim().orEmpty()
                null
            }
            if (online != null) {
                relayUrl = online.optString("pushRelayUrl").trim().trimEnd('/')
                spPush.edit().putString("relay", relayUrl).apply()
                if (url.isEmpty() || key.isEmpty()) {
                    if (online.optBoolean("configured")) {
                        url = online.optString("supabaseUrl")
                        key = online.optString("anonKey")
                    }
                }
            }
            if (url.isEmpty() || key.isEmpty()) {
                ConfigResult.NotConfigured
            } else {
                // 登记走个人云网关 ai-phone-push?action=subscribe 而不是站点 /api/push/subscribe：
                // 站点路由在自托管模式写的是 account.id=local_user，进不了 owner 的订阅清单；
                // 个人云网关才能写入 user_id='owner'，让 push-generate 取到并广播。
                registerShellSubscription(userId, url.trimEnd('/'), key)
                ConfigResult.Ok(PushConfig(url.trimEnd('/'), key, userId, relayUrl))
            }
        } catch (e: Exception) {
            Log.d(LOG_TAG, "fetchConfig error: ${e.message}")
            ConfigResult.Unreachable
        }
    }

    /**
     * 拼出要连的 WebSocket 地址。
     * - 没配中转：直连 Supabase Realtime；
     * - 配了中转：只把「主机」换成中转，path 与 apikey 原样带上——中转按 path 替我们转发到 Supabase。
     *   这样中转侧不需要知道任何密钥，客户端也只改一个主机名。
     * 中转地址若自带路径（如 wss://host/push），则原样使用，不再拼接。
     */
    private fun buildWsUrl(config: PushConfig): String {
        val directPath = "/realtime/v1/websocket?apikey=${config.anonKey}&vsn=1.0.0"
        val relay = config.relayUrl.trim().trimEnd('/')
        if (relay.isEmpty()) return config.supabaseUrl.replaceFirst("http", "ws") + directPath
        val schemeEnd = relay.indexOf("://")
        val hasOwnPath = schemeEnd >= 0 && relay.indexOf('/', schemeEnd + 3) >= 0
        return if (hasOwnPath) relay else relay + directPath
    }

    /**
     * 在【个人云】注册一条合成推送订阅（endpoint = shell:<userId>）。
     * 作用：让离线消息排期的"账号已订阅"门控放行（push-generate 按
     * user_id=eq.owner 拉订阅），并让服务端知道要往 shellpush:owner 广播；
     * 服务端不会对 shell: 开头的合成订阅做 Web Push 投递。
     *
     * 必须走个人云网关 action=subscribe（写 user_id='owner'），不能用站点
     * /api/push/subscribe（自托管下写 account.id=local_user，对不上 owner）。
     * 用壳持有（recordSupabase 从 cloud backup 推入）的 service_role 密钥做鉴权。
     */
    private fun registerShellSubscription(userId: String, supabaseUrl: String, serviceKey: String) {
        if (shellSubRegistered) return
        runCatching {
            val body = JSONObject()
                .put("endpoint", "shell:$userId")
                .put(
                    "keys",
                    JSONObject().put("p256dh", "shell").put("auth", "shell"),
                )
                .toString()
                .toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("$supabaseUrl/functions/v1/ai-phone-push?action=subscribe")
                .header("x-ai-phone-service-key", serviceKey)
                .header("x-ai-phone-origin", MainActivity.SITE_URL)
                .post(body)
                .build()
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) shellSubRegistered = true
            }
        }
    }

    /** 一条 WS 连接的运行结果：join 是否成功、以及 join 成功之后活了多久（毫秒）。 */
    private data class SocketRun(val joinedOk: Boolean, val aliveMs: Long)

    /** 跑一条 WebSocket 直到断开。 */
    private fun runSocket(config: PushConfig): SocketRun {
        // 直连 wss://<项目>.supabase.co/... 或经中转（站点下发的 pushRelayUrl）
        val wsUrl = buildWsUrl(config)
        Log.d(LOG_TAG, "runSocket: mode=${if (config.relayUrl.isNotEmpty()) "relay" else "direct"}")
        val topic = "realtime:shellpush:${config.userId}"
        val lock = Object()
        var joined = false
        var joinedAt = 0L
        var done = false
        // 任意下行帧都会刷新它：长时间没有任何下行说明连接已被中间设备悄悄掐断
        val lastInbound = AtomicLong(System.currentTimeMillis())

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(LOG_TAG, "onOpen: joining ${topic}")
                val join = JSONObject()
                    .put("topic", topic)
                    .put("event", "phx_join")
                    .put("ref", JOIN_REF)
                    .put(
                        "payload",
                        JSONObject().put(
                            "config",
                            JSONObject()
                                .put("broadcast", JSONObject().put("self", false))
                                .put("presence", JSONObject().put("key", "")),
                        ),
                    )
                webSocket.send(join.toString())
                // Phoenix 心跳（OkHttp pingInterval 是 TCP 层，这里是协议层）
                thread(name = "shell-push-heartbeat") {
                    while (!done && !stopped) {
                        sleepSec(25)
                        if (done || stopped) break
                        // 超过 90 秒（≈3 次心跳）没有任何下行帧 → 认为这条连接已经废了，
                        // 主动断开重连；比等 TCP 超时（可能几分钟）快得多。
                        if (System.currentTimeMillis() - lastInbound.get() > 90_000) {
                            Log.d(LOG_TAG, "heartbeat: no inbound for 90s, forcing reconnect")
                            runCatching { webSocket.cancel() }
                            break
                        }
                        runCatching {
                            webSocket.send(
                                JSONObject()
                                    .put("topic", "phoenix")
                                    .put("event", "heartbeat")
                                    .put("payload", JSONObject())
                                    .put("ref", (msgSeq++).toString())
                                    .toString(),
                            )
                        }
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                lastInbound.set(System.currentTimeMillis())
                runCatching {
                    val msg = JSONObject(text)
                    val event = msg.optString("event")

                    // join 回执：只有 status=ok 才算真的订阅成功（否则界面会假「已连接」而实际收不到消息）
                    if (event == "phx_reply" && msg.optString("ref") == JOIN_REF) {
                        val status = msg.optJSONObject("payload")?.optString("status")
                        if (status == "ok") {
                            joined = true
                            joinedAt = System.currentTimeMillis()
                            Log.d(LOG_TAG, "join ok: $topic")
                            updateKeepAlive("已连接，等待角色消息")
                        } else {
                            Log.d(LOG_TAG, "join rejected: status=$status")
                        }
                        return
                    }
                    if (event == "phx_error" || event == "phx_close") {
                        Log.d(LOG_TAG, "$event on $topic")
                        return
                    }
                    if (event != "broadcast") return
                    val payload = msg.optJSONObject("payload") ?: return
                    if (payload.optString("event") != "notify") return
                    val body = payload.optJSONObject("payload") ?: return
                    val title = body.optString("title").ifEmpty { "小手机" }
                    val text2 = body.optString("body").ifEmpty { "有新消息" }
                    // 来电：全屏来电通知（任何一步失败回落普通通知，主路不受影响）
                    if (body.optString("kind") == "call") {
                        val shown = runCatching {
                            showIncomingCallNotification(
                                body.optString("characterName").ifEmpty { title },
                                body.optString("sessionId"),
                                body.optLong("callTs", System.currentTimeMillis()),
                            )
                        }.isSuccess
                        if (shown) return
                    }
                    showMessageNotification(title, text2)
                    // 壳没有 Service Worker，收不到浏览器里的 "push_outbox_ready" 触发，
                    // 完整消息存在云端 push_outbox，光弹通知不会进聊天。这里在弹通知同时
                    // 通知网页调 window.__float_pull_outbox() 去拉取并合并 outbox。
                    runCatching {
                        val wv = MainActivity.webViewRef ?: return@runCatching
                        wv.post {
                            wv.evaluateJavascript(
                                "window.__float_pull_outbox && window.__float_pull_outbox()",
                                null,
                            )
                        }
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(LOG_TAG, "onClosed: code=$code reason=$reason")
                synchronized(lock) { done = true; lock.notifyAll() }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.d(LOG_TAG, "onFailure: ${t!!::class.java.simpleName} ${t.message} resp=${response?.code} ${response?.message}")
                synchronized(lock) { done = true; lock.notifyAll() }
            }
        }

        socket = client.newWebSocket(
            Request.Builder().url(wsUrl).build(),
            listener,
        )
        synchronized(lock) {
            while (!done && !stopped) runCatching { lock.wait(30_000) }
        }
        socket?.cancel()
        socket = null
        return SocketRun(joined, if (joined) System.currentTimeMillis() - joinedAt else 0L)
    }

    // ── 通知 ──
    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CH_KEEPALIVE, "后台连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "维持角色消息接收通道（可在此关闭常驻通知的显示）"
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CH_MESSAGES, "角色消息", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "角色发来的离线消息"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CH_CALLS, "角色来电", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "角色打来的语音电话（只振动，不响铃）"
                setSound(null, null)
                enableVibration(false) // 振动由 CallAlert 循环控制，渠道自带的一次性振动关掉
            },
        )
    }

    private fun contentIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE,
    )

    private fun buildKeepAliveNotification(text: String): Notification =
        NotificationCompat.Builder(this, CH_KEEPALIVE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("float")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()

    /** 更新常驻通知文案。文案没变就不重复 notify，避免同一状态反复刷新。 */
    private fun updateKeepAlive(text: String) {
        if (text == currentNotifText) return
        currentNotifText = text
        getSystemService(NotificationManager::class.java)
            .notify(NOTIF_FG_ID, buildKeepAliveNotification(text))
    }

    /**
     * 全屏来电通知：锁屏/熄屏直接弹 IncomingCallActivity，亮屏时是带
     * 接听/拒接按钮的 heads-up。振动循环 + 55s 超时未接由 CallAlert 管。
     */
    private fun showIncomingCallNotification(characterName: String, sessionId: String, callTs: Long) {
        val fullScreen = Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(IncomingCallActivity.EXTRA_SESSION_ID, sessionId)
            putExtra(IncomingCallActivity.EXTRA_CHARACTER_NAME, characterName)
            putExtra(IncomingCallActivity.EXTRA_CALL_TS, callTs)
        }
        val fullScreenPending = PendingIntent.getActivity(
            this, 60, fullScreen,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        fun buildAction(actionName: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
            this, code,
            Intent(this, CallActionReceiver::class.java).apply {
                action = actionName
                putExtra(CallActionReceiver.EXTRA_SESSION_ID, sessionId)
                putExtra(CallActionReceiver.EXTRA_CALL_TS, callTs)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(characterName)
            .setContentText("语音来电…")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreenPending, true)
            .setContentIntent(fullScreenPending)
            .addAction(0, "拒接", buildAction(CallActionReceiver.ACTION_DECLINE, 61))
            .addAction(0, "接听", buildAction(CallActionReceiver.ACTION_ANSWER, 62))
            .build()
        getSystemService(NotificationManager::class.java).notify(CallAlert.NOTIF_CALL_ID, notification)
        CallAlert.start(this, sessionId, characterName) {
            // 超时未接：收场 + 换一条"未接来电"普通通知（正文消息本来就会进聊天）
            CallAlert.stop(this)
            runCatching { showMissedCallNotification(characterName) }
        }
    }

    private fun showMissedCallNotification(characterName: String) {
        val notification = NotificationCompat.Builder(this, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(characterName)
            .setContentText("未接来电")
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        getSystemService(NotificationManager::class.java).notify(CallAlert.NOTIF_MISSED_ID, notification)
    }

    private fun showMessageNotification(title: String, body: String) {
        val notification = NotificationCompat.Builder(this, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        getSystemService(NotificationManager::class.java).notify(notifId++, notification)
        if (notifId > 400) notifId = 100
    }

    private fun sleepSec(sec: Long) {
        runCatching { Thread.sleep(sec * 1000) }
    }
}
