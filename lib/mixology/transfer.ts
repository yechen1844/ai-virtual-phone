// lib/mixology/transfer.ts
// 独家特调 · 材料的离线搬运：导出成 JSON 文件、从 JSON 文件导入。
// 官网大厅之外的第二条路——备份、私下发给朋友、跨设备迁移都不用联网。

import {
    MIX_SLOT_ORDER,
    createMixId,
    type MixMaterial,
    type MixMaterialKind,
} from "./types";

const FILE_MARK = "float-mixology-material";
const FILE_VERSION = 1;

type MixTransferFile = {
    mark: typeof FILE_MARK;
    version: number;
    material: MixMaterial;
};

function safeFileName(name: string): string {
    // 文件名里不能出现的字符统一换成下划线；中文保留
    const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
    return cleaned || "material";
}

/** 导出一件材料为 .json 文件（浏览器直接下载） */
export function exportMixMaterial(material: MixMaterial): void {
    const payload: MixTransferFile = { mark: FILE_MARK, version: FILE_VERSION, material };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(material.name)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isMixKind(value: unknown): value is MixMaterialKind {
    return typeof value === "string" && (MIX_SLOT_ORDER as string[]).includes(value);
}

/**
 * 解析导入的 JSON 文本。
 * 兼容三种写法：本工具导出的带壳文件、裸材料对象、以及一次多件的数组。
 * 导入一律换新 id，避免覆盖酒柜里的同名旧件。
 */
export function parseMixMaterialsFromJson(text: string): MixMaterial[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("这不是一个有效的 JSON 文件。");
    }

    const candidates: unknown[] = [];
    const collect = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(collect);
            return;
        }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (record.mark === FILE_MARK && record.material) {
            collect(record.material);
            return;
        }
        candidates.push(record);
    };
    collect(parsed);

    const now = Date.now();
    const materials: MixMaterial[] = [];
    for (const candidate of candidates) {
        const record = candidate as Record<string, unknown>;
        if (!isMixKind(record.kind)) continue;
        const name = typeof record.name === "string" ? record.name.trim() : "";
        if (!name) continue;
        // 角色卡至少要有一句开场白，否则开不了局
        if (record.kind === "character") {
            const openings = Array.isArray(record.openings)
                ? record.openings.filter((o): o is string => typeof o === "string" && Boolean(o.trim()))
                : [];
            if (openings.length === 0) continue;
            materials.push({
                ...(record as unknown as MixMaterial),
                id: createMixId("mixmat"),
                publishedId: undefined,
                name,
                openings,
                createdAt: now,
                updatedAt: now,
            } as MixMaterial);
            continue;
        }
        materials.push({
            ...(record as unknown as MixMaterial),
            id: createMixId("mixmat"),
            publishedId: undefined,
            name,
            createdAt: now,
            updatedAt: now,
        } as MixMaterial);
    }

    if (materials.length === 0) {
        throw new Error("文件里没有能认出来的材料。");
    }
    return materials;
}
