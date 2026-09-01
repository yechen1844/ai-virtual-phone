package app.floatphone.shell

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.UUID

/**
 * 蓝牙 BLE 桥：暴露 `window.FloatBle` 给网页。
 * 支持最常见 BLE 外设控制：扫描 / 连接 / 读写特征 / 通知订阅。
 * 所有回调通过 JS 函数字符串回调（页面自己定义）。
 *
 * 保活与此无关：不碰音频焦点、不播放任何声音（与 float 前台服务保活独立）。
 */
@SuppressLint("MissingPermission")
class FloatBleBridge(private val activity: MainActivity, private val webView: WebView) {

    private val main: Handler = Handler(Looper.getMainLooper())
    private val manager: BluetoothManager? =
        activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val adapter: BluetoothAdapter? = manager?.adapter
    private val gatts = HashMap<String, BluetoothGatt>()
    private val connected = HashSet<String>()

    private var scanCb: String? = null
    private var scanning = false

    // ───────────────── 状态 ─────────────────
    @JavascriptInterface
    fun status(): String {
        val j = JSONObject()
        j.put("supported", adapter != null)
        j.put("enabled", adapter?.isEnabled == true)
        j.put("scanSupported", adapter?.bluetoothLeScanner != null)
        j.put("gattCount", gatts.size)
        val info = JSONObject()
        for ((addr, g) in gatts) info.put(addr, gState(addr))
        j.put("devices", info)
        return j.toString()
    }

    private fun gState(address: String): String = when {
        address in connected -> "connected"
        address in gatts -> "connecting"
        else -> "disconnected"
    }

    // ───────────────── 扫描 ─────────────────
    @JavascriptInterface
    fun startScan(callback: String) {
        main.post { runCatching {
            val s = adapter?.bluetoothLeScanner
            if (adapter?.isEnabled != true || s == null || scanning) {
                emit(scanCb, err("蓝牙不可用或已在扫描"))
                return@post
            }
            scanCb = callback
            scanning = true
            val settings = android.bluetooth.le.ScanSettings.Builder()
                .setScanMode(android.bluetooth.le.ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()
            s.startScan(null, settings, scanCallbacks)
            emit(callback, ok("onScan", JSONObject().put("state", "started")))
        }.onFailure { emit(scanCb, err(it)) } }
    }

    @JavascriptInterface
    fun stopScan() {
        main.post {
            runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallbacks) }.onFailure { }
            scanning = false
            emit(scanCb, ok("onScan", JSONObject().put("state", "stopped")))
            scanCb = null
        }
    }

    private val scanCallbacks = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val j = JSONObject()
            j.put("name", result.device.name)
            j.put("address", result.device.address)
            j.put("rssi", result.rssi)
            emit(scanCb, ok("onScan", j))
        }
        override fun onScanFailed(errorCode: Int) {
            scanning = false
            emit(scanCb, err("扫描失败 code=$errorCode"))
        }
    }

    // ───────────────── 连接 / 断开 ─────────────────
    @JavascriptInterface
    fun connect(address: String, callback: String) {
        main.post {
            handle(address, callback) { gatt ->
                gatts[address] = gatt
                gatt.connect()
            }
        }
    }

    @JavascriptInterface
    fun disconnect(address: String) {
        main.post {
            gatts[address]?.disconnect()
            gatts[address]?.close()
            gatts.remove(address)
        }
    }

    // ───────────────── 读写特征 ─────────────────
    @JavascriptInterface
    fun readHex(address: String, service: String, char: String, callback: String) {
        main.post {
            handle(address, callback) { gatt ->
                val ch = findChar(gatt, service, char)
                if (ch == null) emit(callback, err("未找到特征 $char"))
                else gatt.readCharacteristic(ch)
            }
        }
    }

    @JavascriptInterface
    fun writeHex(address: String, service: String, char: String, hex: String, callback: String) {
        main.post {
            handle(address, callback) { gatt ->
                val ch = findChar(gatt, service, char)
                if (ch == null) { emit(callback, err("未找到特征 $char")); return@handle }
                val data = hexToBytes(hex)
                writeCbByChar[ch.uuid.toString() + ch.instanceId] = callback
                if (Build.VERSION.SDK_INT >= 33)
                    gatt.writeCharacteristic(ch, data, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
                else {
                    ch.value = data
                    gatt.writeCharacteristic(ch)
                }
            }
        }
    }

    // ───────────────── 通知订阅 ─────────────────
    @JavascriptInterface
    fun startNotify(address: String, service: String, char: String, onData: String) {
        main.post {
            handle(address, null) { gatt ->
                val ch = findChar(gatt, service, char)
                if (ch == null) return@handle
                notifyCbByChar[ch.uuid.toString() + ch.instanceId] = onData
                gatt.setCharacteristicNotification(ch, true)
                val desc = ch.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"))
                if (desc != null) {
                    desc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    gatt.writeDescriptor(desc)
                }
            }
        }
    }

    private val writeCbByChar = HashMap<String, String>()
    private val notifyCbByChar = HashMap<String, String>()

    private fun findChar(gatt: BluetoothGatt, service: String, char: String): android.bluetooth.BluetoothGattCharacteristic? {
        val svc = gatt.getService(service.let { uuid(it) } ?: return null) ?: return null
        return svc.getCharacteristic(uuid(char) ?: return null)
    }

    private fun uuid(s: String): UUID? = try { UUID.fromString(s.trim()) } catch (e: Exception) { null }

    private fun handle(address: String, callback: String?, op: (BluetoothGatt) -> Unit) {
        val gatt = gatts[address]
        if (gatt == null) {
            // 没有现成 gatt：先建立连接（需先拿到 device）
            val dev = adapter?.getRemoteDevice(address)
            if (dev == null) { callback?.let { emit(it, err("未找到设备 $address")) }; return }
            connectGatt(dev, callback, address)
            return
        }
        if (address !in connected) { callback?.let { emit(it, err("未连接 $address")) }; return }
        op(gatt)
    }

    private fun connectGatt(device: BluetoothDevice, callback: String?, address: String) {
        val gatt = device.connectGattCompat(activity, gattCallbackFor(address, callback)) ?: run {
            callback?.let { emit(it, err("连接失败 $address")) }
            return
        }
        gatts[address] = gatt
    }

    private fun gattCallbackFor(address: String, readyCb: String?): BluetoothGattCallback =
        object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    connected.add(address)
                    g.discoverServices()
                    readyCb?.let { emit(it, ok("onConnected", JSONObject().apply {
                        put("address", address); put("status", status)
                    })) }
                } else {
                    connected.remove(address)
                    runCatching { g.close() }.onFailure { }
                    gatts.remove(address)
                    readyCb?.let { emit(it, ok("onDisconnected", JSONObject().put("address", address))) }
                }
            }
            override fun onServicesDiscovered(g: BluetoothGatt, st: Int) {
                if (st == BluetoothGatt.GATT_SUCCESS && readyCb != null) emit(readyCb, ok("onServices", JSONObject().put("address", address)))
            }
            override fun onCharacteristicRead(g: BluetoothGatt, ch: android.bluetooth.BluetoothGattCharacteristic, st: Int) {
                readyCb?.let { emit(it, ok("onRead", JSONObject().apply {
                    put("address", address); put("uuid", ch.uuid.toString())
                    put("hex", bytesToHex(ch.value)); put("status", st)
                })) }
            }
            override fun onCharacteristicWrite(g: BluetoothGatt, ch: android.bluetooth.BluetoothGattCharacteristic, st: Int) {
                val k = ch.uuid.toString() + ch.instanceId
                writeCbByChar.remove(k)?.let { emit(it, ok("onWrite", JSONObject().apply {
                    put("address", address); put("uuid", ch.uuid.toString()); put("status", st)
                })) }
            }
            override fun onCharacteristicChanged(g: BluetoothGatt, ch: android.bluetooth.BluetoothGattCharacteristic) {
                val k = ch.uuid.toString() + ch.instanceId
                notifyCbByChar[k]?.let { emit(it, ok("onData", JSONObject().apply {
                    put("address", address); put("uuid", ch.uuid.toString())
                    put("hex", bytesToHex(ch.value))
                })) }
            }
        }

    // ───────────────── 工具 ─────────────────
    private fun ok(kind: String, data: JSONObject): String {
        val j = JSONObject()
        j.put("kind", kind); j.put("ok", true); j.put("data", data)
        return j.toString()
    }
    private fun err(msg: String): String {
        val j = JSONObject()
        j.put("ok", false); j.put("error", msg)
        return j.toString()
    }
    private fun err(e: Throwable): String = err(e.message ?: e.javaClass.simpleName)

    private fun emit(cb: String?, payload: String) {
        if (cb.isNullOrBlank()) return
        main.post {
            runCatching {
                webView.evaluateJavascript(
                    "(function(){try{(0,${cb})(${payload})}catch(e){console.error('FloatBle',e)}})()", null
                )
            }.onFailure { }
        }
    }

    private fun bytesToHex(b: ByteArray?): String {
        if (b == null) return ""
        val sb = StringBuilder(b.size * 2)
        for (x in b) sb.append(String.format("%02X", x))
        return sb.toString()
    }
    private fun hexToBytes(hex: String): ByteArray {
        val h = hex.trim().replace(" ", "")
        val out = ByteArray(h.length / 2)
        for (i in out.indices) out[i] = h.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        return out
    }
}

// 兼容不同 SDK 的 connectGatt（Android 13+ 带 transport 参数，旧版没有）
@SuppressLint("MissingPermission")
private fun BluetoothDevice.connectGattCompat(ctx: Context, cb: BluetoothGattCallback): BluetoothGatt? =
    if (Build.VERSION.SDK_INT >= 33)
        connectGatt(ctx, false, cb, BluetoothDevice.TRANSPORT_LE)
    else
        connectGatt(ctx, false, cb)