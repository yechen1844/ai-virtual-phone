"use client";

import { useState } from "react";
import { BookOpenText, Minus, Plus, Repeat2, Settings } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import {
    loadReadingInteractionConfig,
    saveReadingInteractionConfig,
    type ReadingInteractionConfig,
    type ReadingParagraphMode,
    type ReadingViewMode,
} from "@/lib/reading-storage";

const PARAGRAPH_MODE_OPTIONS: { value: ReadingParagraphMode; label: string; desc: string }[] = [
    { value: "auto", label: "自动", desc: "自动识别书的段落格式（推荐）" },
    { value: "blank", label: "空行", desc: "段落之间有空行（标准导出格式）" },
    { value: "indent", label: "段首缩进", desc: "每段以全角空格缩进、无空行" },
    { value: "line", label: "每行一段", desc: "纯回车换行分段落（无空行无缩进）" },
];

const VIEW_MODE_OPTIONS: { value: ReadingViewMode; label: string; desc: string }[] = [
    { value: "page", label: "翻页", desc: "一屏一页，左右点击/滑动翻页" },
    { value: "scroll", label: "滚动", desc: "连续滚动阅读，上下滑动翻读" },
];

const RETRY_MIN = 0;
const RETRY_MAX = 5;

type Props = {
    onClose: () => void;
};

/** 阅读交互设置：导入段落划分 / 阅读模式 / 自动批注失败静默重试次数 */
export function ReadingInteractionDialog({ onClose }: Props) {
    const [config, setConfig] = useState<ReadingInteractionConfig>(() => loadReadingInteractionConfig());
    const [saving, setSaving] = useState(false);

    const handleSave = () => {
        setSaving(true);
        saveReadingInteractionConfig(config);
        setSaving(false);
        // 阅读器保持挂载，通过事件让它在下次显示时同步新配置
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("reading-interaction-config-changed"));
        }
        onClose();
    };

    const setRetry = (delta: number) => {
        setConfig((prev) => ({
            ...prev,
            annotationRetryCount: Math.max(RETRY_MIN, Math.min(RETRY_MAX, prev.annotationRetryCount + delta)),
        }));
    };

    return (
        <ContentDialog
            title="阅读设置"
            confirmLabel={saving ? "保存中..." : "保存"}
            cancelLabel="取消"
            onConfirm={handleSave}
            onCancel={onClose}
        >
            <div className="reading-settings-grid">
                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Settings size={15} />
                        <span>导入段落划分</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>导入 TXT 小说时如何划分段落。选错可在导入后重新导入生效。</span>
                    </p>
                    <div className="reading-option-grid">
                        {PARAGRAPH_MODE_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                className={`reading-option-card ${config.paragraphMode === opt.value ? "is-active" : ""}`}
                                onClick={() => setConfig((prev) => ({ ...prev, paragraphMode: opt.value }))}
                            >
                                <span className="reading-option-card-label">{opt.label}</span>
                                <span className="reading-option-card-desc">{opt.desc}</span>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <BookOpenText size={15} />
                        <span>阅读模式</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>切换后重新打开书籍生效。</span>
                    </p>
                    <div className="reading-option-grid reading-option-grid--two">
                        {VIEW_MODE_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                className={`reading-option-card ${config.readingMode === opt.value ? "is-active" : ""}`}
                                onClick={() => setConfig((prev) => ({ ...prev, readingMode: opt.value }))}
                            >
                                <span className="reading-option-card-label">{opt.label}</span>
                                <span className="reading-option-card-desc">{opt.desc}</span>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Repeat2 size={15} />
                        <span>自动批注失败重试</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>生成失败时静默重试的次数，全部失败后才提示错误。</span>
                    </p>
                    <div className="reading-retry-row">
                        <button
                            type="button"
                            className="reading-retry-btn"
                            onClick={() => setRetry(-1)}
                            disabled={config.annotationRetryCount <= RETRY_MIN}
                            aria-label="减少重试次数"
                        >
                            <Minus size={15} strokeWidth={2} />
                        </button>
                        <span className="reading-retry-value">
                            {config.annotationRetryCount}
                            <em>次</em>
                        </span>
                        <button
                            type="button"
                            className="reading-retry-btn"
                            onClick={() => setRetry(1)}
                            disabled={config.annotationRetryCount >= RETRY_MAX}
                            aria-label="增加重试次数"
                        >
                            <Plus size={15} strokeWidth={2} />
                        </button>
                    </div>
                </section>
            </div>
        </ContentDialog>
    );
}
