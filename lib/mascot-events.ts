// lib/mascot-events.ts
// Unified event bus for mascot ↔ app communication.

import { setMascotContext, type MascotPageContext } from "./mascot-context";

// ── Page → Mascot: context changed ──
export function notifyMascotPageContext(ctx: MascotPageContext) {
  setMascotContext(ctx);
  window.dispatchEvent(new CustomEvent("mascot-page-context", { detail: ctx }));
}

// ── Mascot → Page: fill a field ──
export function mascotFillField(data: { field: string; value: string; _batchId?: string }) {
  window.dispatchEvent(new CustomEvent("mascot-fill-field", { detail: data }));
}

// ── Mascot → Shell: navigate ──
export function mascotNavigate(app: string, mode?: string) {
  window.dispatchEvent(new CustomEvent("mascot-navigate", { detail: { app, mode } }));
}

// ── Mascot → Desktop: widgets / DIY templates changed in kv, re-hydrate ──
export const DESKTOP_WIDGETS_CHANGED_EVENT = "mascot-widgets-changed";

export function notifyDesktopWidgetsChanged() {
  window.dispatchEvent(new CustomEvent(DESKTOP_WIDGETS_CHANGED_EVENT));
}

// ── Mascot → UI: open DIY widget preview dialog ──
export const DIY_WIDGET_PREVIEW_EVENT = "mascot-diy-widget-preview";

export type DiyWidgetPreviewRequest = {
  templateId: string;
  name: string;
  size: string;
  htmlString: string;
};

export type DiyWidgetPreviewEventDetail = {
  request: DiyWidgetPreviewRequest;
  /** 由前端处理器置 true；派发后仍为 false 说明没有挂载弹窗宿主 */
  handled: boolean;
};

export function requestDiyWidgetPreview(request: DiyWidgetPreviewRequest): boolean {
  const detail: DiyWidgetPreviewEventDetail = { request, handled: false };
  window.dispatchEvent(new CustomEvent<DiyWidgetPreviewEventDetail>(DIY_WIDGET_PREVIEW_EVENT, { detail }));
  return detail.handled;
}

// ── Mascot → UI: open regex rule preview dialog ──
export const REGEX_PREVIEW_EVENT = "mascot-regex-preview";

export type RegexPreviewRequest = {
  /** 弹窗标题（通常是规则名） */
  title?: string;
  /** 规则所属正则组名（可选，仅展示用） */
  groupName?: string;
  /** 完整规则对象（findRegex/replaceString 等字段与存储结构一致） */
  rule: {
    id?: string;
    scriptName: string;
    findRegex: string;
    replaceString: string;
    tags?: string[];
    disabled?: boolean;
    placement?: number[];
    markdownOnly?: boolean;
    promptOnly?: boolean;
    runOnEdit?: boolean;
    substituteRegex?: number;
    trimStrings?: string[];
    minDepth?: number;
    maxDepth?: number;
  };
  /** 可选：弹窗初始示例文本；不传则用内置占位符示例 */
  sampleText?: string;
};

export type RegexPreviewEventDetail = {
  request: RegexPreviewRequest;
  /** 由前端处理器置 true；派发后仍为 false 说明没有挂载弹窗宿主 */
  handled: boolean;
};

export function requestRegexPreview(request: RegexPreviewRequest): boolean {
  const detail: RegexPreviewEventDetail = { request, handled: false };
  window.dispatchEvent(new CustomEvent<RegexPreviewEventDetail>(REGEX_PREVIEW_EVENT, { detail }));
  return detail.handled;
}
