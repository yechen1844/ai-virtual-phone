"use client";

import { useEffect, useState } from "react";

// ── 临时诊断浮层（用完即删）──
// 键盘弹出时把关键视口数值显示在左上角，用来定位「键盘遮挡/追不上」到底断在哪一层：
//   ih    window.innerHeight（布局视口高度；resizes-content 生效时它应随键盘缩小）
//   vv    visualViewport.height（视觉视口高度）
//   ot    visualViewport.offsetTop
//   doc   documentElement.clientHeight
//   narrow/coarse  键盘补丁所依赖的媒体查询是否匹配（coarse=false 说明补丁会被跳过）
//   lift  --mobile-keyboard-lift：全局上移补丁实际施加的位移
//   barBottom / kbTop  输入栏底边 与 键盘顶边（差值 >0 表示被键盘压住多少）
const KB_PROBE_ENABLED = true;

export function KbProbe() {
    const [text, setText] = useState("");

    useEffect(() => {
        if (!KB_PROBE_ENABLED || typeof window === "undefined") return;
        const vv = window.visualViewport;
        let raf = 0;
        let timer = 0;

        const isEditable = () => {
            const el = document.activeElement as HTMLElement | null;
            if (!el) return false;
            return el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable;
        };

        const render = () => {
            raf = 0;
            if (!isEditable()) { setText(""); return; }
            const root = document.documentElement;
            const shell = document.querySelector<HTMLElement>(".phone-shell");
            const bar = document.querySelector<HTMLElement>('[data-ui="input"]');
            const lift = shell ? getComputedStyle(shell).getPropertyValue("--mobile-keyboard-lift").trim() : "";
            const coarse = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
            const narrow = window.matchMedia("(max-width: 500px)").matches;
            const kbTop = vv ? Math.round(vv.offsetTop + vv.height) : -1;
            const barBottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : -1;
            setText(
                `ih=${window.innerHeight} vv=${vv ? Math.round(vv.height) : -1} ot=${vv ? Math.round(vv.offsetTop) : -1} doc=${root.clientHeight}\n`
                + `narrow=${narrow} coarse=${coarse} lift=${lift || "0"}\n`
                + `barBottom=${barBottom} kbTop=${kbTop} 压住=${barBottom >= 0 && kbTop >= 0 ? barBottom - kbTop : "-"}`,
            );
        };

        const schedule = () => { if (!raf) raf = window.requestAnimationFrame(render); };
        const tick = () => { if (isEditable()) schedule(); };

        schedule();
        vv?.addEventListener("resize", schedule);
        vv?.addEventListener("scroll", schedule);
        window.addEventListener("resize", schedule);
        document.addEventListener("focusin", schedule);
        document.addEventListener("focusout", schedule);
        timer = window.setInterval(tick, 300);

        return () => {
            if (raf) window.cancelAnimationFrame(raf);
            if (timer) window.clearInterval(timer);
            vv?.removeEventListener("resize", schedule);
            vv?.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            document.removeEventListener("focusin", schedule);
            document.removeEventListener("focusout", schedule);
        };
    }, []);

    if (!text) return null;
    return (
        <div
            style={{
                position: "fixed",
                top: 0,
                left: 0,
                zIndex: 2147483647,
                background: "rgba(0,0,0,0.82)",
                color: "#7CFC7C",
                font: "11px/1.45 ui-monospace, monospace",
                padding: "4px 6px",
                borderRadius: "0 0 8px 0",
                whiteSpace: "pre",
                pointerEvents: "none",
            }}
        >
            {text}
        </div>
    );
}
