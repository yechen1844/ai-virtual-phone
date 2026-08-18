"use client";

// 独家特调 · 机括的常驻界面。
//
// 跟钩子的沙盒是两回事：钩子是"被叫起来跑一下就结束"的纯函数，
// 这里是"一直挂在屏幕上、有自己状态"的东西，所以必须常驻不重建——
// 每轮重新插一次的话，播放器会从头放、记忆区会滚回顶部、页签会跳回第一个。
//
// 能做的事是一张白名单，就这五条：写自己的存储、写记住的值、以玩家身份
// 发一句话、收起/展开自己。白名单以外的消息一律不理会。
// 位置由应用排布，界面只能选停靠位——不然三个机括一起糊满屏幕，输入框都点不到。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { MIX_DOCK_LABELS, type MixDock, type MixState } from "@/lib/mixology/types";
import { normalizeMechanismStore, type MixMechanismStore } from "@/lib/mixology/mechanism-protocol";

/** 界面能请求的动作，就这几条 */
type PanelCommand =
    | { name: "setStore"; store: unknown }
    | { name: "setState"; state: unknown }
    | { name: "say"; text: unknown }
    | { name: "setOpen"; open: unknown };

const MAX_SAY_LENGTH = 2_000;

function buildPanelDoc(html: string, state: MixState, store: MixMechanismStore): string {
    const bridge = `
<script>
(function(){
  "use strict";
  window.MIX_STATE = ${JSON.stringify(state)};
  window.MIX_STORE = ${JSON.stringify(store)};
  function send(name, extra){
    var msg = { source: "mix-panel", name: name };
    for (var k in extra) msg[k] = extra[k];
    try { parent.postMessage(msg, "*"); } catch (e) {}
  }
  // 界面能请求的全部动作
  window.mix = {
    setStore: function(obj){ send("setStore", { store: obj }); },
    setState: function(obj){ send("setState", { state: obj }); },
    say: function(text){ send("say", { text: String(text == null ? "" : text) }); },
    open: function(){ send("setOpen", { open: true }); },
    close: function(){ send("setOpen", { open: false }); }
  };
  // 记住的值有变化时，应用会推一份新的过来；界面可定义 onMixSync 接收
  window.addEventListener("message", function(event){
    var data = event.data;
    if (!data || data.source !== "mix-panel-host") return;
    window.MIX_STATE = data.state || {};
    window.MIX_STORE = data.store || {};
    if (typeof window.onMixSync === "function") {
      try { window.onMixSync(window.MIX_STATE, window.MIX_STORE); } catch (e) {}
    }
  });
})();
</` + `script>`;
    const body = /<html[\s>]/i.test(html)
        ? html
        : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>`
          // 界面要能显示图片、播放音频，所以比钩子的沙盒松一档；
          // 但依然没有 connect-src——fetch / XHR / WebSocket 发不出去。
          + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:"/>`
          + `<style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:#f2f0f7;font-family:system-ui,-apple-system,sans-serif;font-size:12px}input,textarea,button,select{max-width:100%;font-family:inherit;font-size:inherit}</style>`
          + `</head><body>${html}</body></html>`;
    // 桥接必须排在作者代码之前：放到 body 末尾的话，面板首屏读不到 MIX_STATE，
    // 要等第一次推送才显示出值来。
    return /<head[\s>]/i.test(body)
        ? body.replace(/<head([^>]*)>/i, `<head$1>${bridge}`)
        : bridge + body;
}

export function MixMechanismPanel({
    materialId,
    name,
    dock,
    html,
    state,
    store,
    onStore,
    onState,
    onSay,
}: {
    materialId: string;
    name: string;
    dock: MixDock;
    html: string;
    state: MixState;
    store: MixMechanismStore;
    onStore: (materialId: string, store: MixMechanismStore) => void;
    onState: (state: MixState) => void;
    onSay: (text: string) => void;
}) {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    // 悬浮球默认收起，其余停靠位默认展开
    const [open, setOpen] = useState(dock !== "float");

    // srcDoc 只在界面代码变化时重算：state/store 走消息推送，不能进这里，
    // 否则每次值一变 iframe 就重新加载，等于没有"常驻"
    const srcDoc = useMemo(() => buildPanelDoc(html, state, store), [html]); // eslint-disable-line react-hooks/exhaustive-deps

    const post = useCallback((payload: Record<string, unknown>) => {
        try {
            frameRef.current?.contentWindow?.postMessage({ source: "mix-panel-host", ...payload }, "*");
        } catch {
            // 递不进去就算了，下一次同步还会再试
        }
    }, []);

    useEffect(() => {
        post({ state, store });
    }, [state, store, post]);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
            const data = event.data as (Record<string, unknown> & { source?: string }) | null;
            if (!data || data.source !== "mix-panel") return;
            const command = data as unknown as PanelCommand;
            switch (command.name) {
                case "setStore":
                    onStore(materialId, normalizeMechanismStore(command.store));
                    break;
                case "setState": {
                    // 与钩子同一套把关：只收数字与短文本，其余丢掉
                    const raw = command.state;
                    if (!raw || typeof raw !== "object" || Array.isArray(raw)) break;
                    const patch: MixState = {};
                    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
                        const name2 = key.trim().slice(0, 40);
                        if (!name2) continue;
                        if (typeof value === "number" && Number.isFinite(value)) patch[name2] = value;
                        else if (typeof value === "string" && value.trim()) patch[name2] = value.trim().slice(0, 200);
                        if (Object.keys(patch).length >= 50) break;
                    }
                    if (Object.keys(patch).length) onState(patch);
                    break;
                }
                case "say": {
                    const text = String(command.text ?? "").trim().slice(0, MAX_SAY_LENGTH);
                    if (text) onSay(text);
                    break;
                }
                case "setOpen":
                    setOpen(command.open !== false);
                    break;
                default:
                    // 白名单以外一律不理会
                    break;
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [materialId, onStore, onState, onSay]);

    return (
        <div className="mix-panel" data-dock={dock} data-open={open ? "true" : undefined}>
            <button
                type="button"
                className="mix-panel-tab"
                onClick={() => setOpen((v) => !v)}
                aria-label={`${open ? "收起" : "展开"}${name}`}
                title={`${name} · ${MIX_DOCK_LABELS[dock]}`}
            >
                <span className="mix-panel-tab-name">{name}</span>
                {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            </button>
            {open ? (
                <iframe
                    ref={frameRef}
                    className="mix-panel-frame"
                    title={name}
                    sandbox="allow-scripts"
                    srcDoc={srcDoc}
                />
            ) : null}
        </div>
    );
}
