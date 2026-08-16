import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";

// 独家特调 · 酒单/大厅 API：材料（mixology_items）与配方（mixology_recipes）共用一套路由，
// type=material|recipe 区分。全部经 service key 直连 Supabase REST，anon 无直读。

const MATERIAL_KINDS = ["character", "persona", "base", "flavor", "glass", "strength", "ticket", "garnish", "encore"] as const;

const ITEM_SUMMARY_COLUMNS = "id,kind,name,hook,cover,tags,author_id,author_name,like_count,save_count,view_count,comment_count,created_at,updated_at";
const ITEM_COLUMNS = `${ITEM_SUMMARY_COLUMNS},payload`;
const RECIPE_SUMMARY_COLUMNS = "id,name,intro,cover,char_name,part_names,author_id,author_name,like_count,save_count,view_count,comment_count,created_at,updated_at";
const RECIPE_COLUMNS = `${RECIPE_SUMMARY_COLUMNS},materials`;

const MAX_MATERIAL_PAYLOAD = 900_000;
const MAX_RECIPE_PAYLOAD = 2_500_000;

type HallType = "material" | "recipe";

const TABLES: Record<HallType, string> = {
  material: "mixology_items",
  recipe: "mixology_recipes",
};

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

function supabaseHeaders(config: { key: string }): HeadersInit {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
  };
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function clampCount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.round(amount));
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => cleanText(item, 24)).filter(Boolean).slice(0, 8);
  return [];
}

function encodeFilter(value: string): string {
  return encodeURIComponent(value);
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatSupabaseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && "cause" in err ? String((err as { cause?: unknown }).cause ?? "") : "";
  const details = `${message} ${cause}`;
  if (/getaddrinfo|EAI_AGAIN|ENOTFOUND/i.test(details)) return "Supabase 域名解析失败，请检查当前 Next 运行环境的网络/DNS。";
  if (/fetch failed/i.test(message)) return "无法连接 Supabase，请检查当前 Next 运行环境是否能访问 Supabase。";
  return message;
}

function isMissingTableError(message: string): boolean {
  return /mixology_items|mixology_recipes|mixology_likes|mixology_saves|mixology_comments/i.test(message)
    && /schema cache|Could not find the table|Could not find.*column|PGRST204|PGRST205|does not exist/i.test(message);
}

async function supabaseFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  const config = getSupabaseConfig();
  if (!config) return { ok: false, error: "missing_supabase_env", status: 503 };
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...supabaseHeaders(config),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = typeof data === "object" && data && "message" in data
      ? String((data as { message?: unknown }).message)
      : text || response.statusText;
    if (isMissingTableError(message)) {
      return {
        ok: false,
        error: "独家特调共享表尚未创建：请先在 Supabase SQL Editor 执行 docs/mixology-supabase.sql。",
        status: response.status,
      };
    }
    return { ok: false, error: message, status: response.status };
  }
  return { ok: true, data: data as T, status: response.status };
}

function parseType(value: unknown): HallType | null {
  return value === "material" || value === "recipe" ? value : null;
}

function normalizeEntry(type: HallType, value: unknown, options: { withPayload?: boolean } = {}): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const name = cleanText(record.name, 80);
  if (!id || !name) return null;
  const base = {
    id,
    name,
    authorId: cleanText(record.author_id, 160) || "anonymous",
    authorName: cleanText(record.author_name, 80) || "匿名调酒师",
    cover: cleanText(record.cover, 2_000_000),
    likeCount: clampCount(record.like_count),
    saveCount: clampCount(record.save_count),
    viewCount: clampCount(record.view_count),
    commentCount: clampCount(record.comment_count),
    createdAt: cleanText(record.created_at, 80),
    updatedAt: cleanText(record.updated_at, 80),
  };
  if (type === "material") {
    const kind = cleanText(record.kind, 20);
    if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) return null;
    return {
      ...base,
      kind,
      hook: cleanText(record.hook, 200),
      tags: normalizeTags(record.tags),
      ...(options.withPayload ? { payload: record.payload ?? null } : {}),
    };
  }
  return {
    ...base,
    intro: cleanText(record.intro, 400),
    charName: cleanText(record.char_name, 80),
    partNames: normalizeTags(record.part_names),
    ...(options.withPayload ? { materials: Array.isArray(record.materials) ? record.materials : [] } : {}),
  };
}

async function annotateMine(type: HallType, entries: Record<string, unknown>[], userId: string): Promise<void> {
  if (!userId || entries.length === 0) return;
  const [likes, saves] = await Promise.all([
    supabaseFetch<Array<{ target_id?: string }>>(
      `mixology_likes?target_type=eq.${type}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
    ),
    supabaseFetch<Array<{ target_id?: string }>>(
      `mixology_saves?target_type=eq.${type}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
    ),
  ]);
  const likedIds = new Set(likes.ok ? likes.data.map(item => item.target_id).filter(Boolean) : []);
  const savedIds = new Set(saves.ok ? saves.data.map(item => item.target_id).filter(Boolean) : []);
  for (const entry of entries) {
    entry.likedByMe = likedIds.has(entry.id as string);
    entry.savedByMe = savedIds.has(entry.id as string);
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const type = parseType(url.searchParams.get("type"));
    if (!type) return NextResponse.json({ ok: false, error: "missing_type", entries: [] }, { status: 400 });
    const account = await getCurrentAccount(request);
    const userId = account?.id || "";
    const table = TABLES[type];
    const requestedId = cleanText(url.searchParams.get("id"), 160);

    if (requestedId) {
      // 完整 payload 只发给登录用户：创作者的整卡源数据不做匿名裸发
      if (!account) return NextResponse.json({ ok: false, error: "请先登录账号再查看详情。" }, { status: 401 });
      const columns = type === "material" ? ITEM_COLUMNS : RECIPE_COLUMNS;
      const result = await supabaseFetch<unknown[]>(
        `${table}?id=eq.${encodeFilter(requestedId)}&deleted_at=is.null&select=${columns}&limit=1`,
      );
      if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
      const entry = normalizeEntry(type, result.data[0], { withPayload: true });
      if (!entry) return NextResponse.json({ ok: false, error: "没有找到这份内容。" }, { status: 404 });
      await annotateMine(type, [entry], userId);
      // 浏览量 +1（尽力而为，不阻塞返回）
      void supabaseFetch<unknown[]>(
        `${table}?id=eq.${encodeFilter(requestedId)}&deleted_at=is.null&select=id`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ view_count: clampCount(entry.viewCount) + 1 }),
        },
      );
      return NextResponse.json({ ok: true, entry });
    }

    const columns = type === "material" ? ITEM_SUMMARY_COLUMNS : RECIPE_SUMMARY_COLUMNS;
    const filters = [`deleted_at=is.null`, `select=${columns}`, "order=updated_at.desc", "limit=100"];
    if (type === "material") {
      const kind = cleanText(url.searchParams.get("kind"), 20);
      if ((MATERIAL_KINDS as readonly string[]).includes(kind)) filters.unshift(`kind=eq.${kind}`);
    }
    if (url.searchParams.get("mine") === "1") {
      if (!account) return NextResponse.json({ ok: true, entries: [] });
      filters.unshift(`author_id=eq.${encodeFilter(userId)}`);
    }
    const result = await supabaseFetch<unknown[]>(`${table}?${filters.join("&")}`);
    if (!result.ok) {
      if (/mixology-supabase\.sql/.test(result.error)) {
        return NextResponse.json({ ok: true, entries: [], setupRequired: true, error: result.error });
      }
      return NextResponse.json({ ok: false, error: result.error, entries: [] }, { status: result.status });
    }
    const entries = result.data
      .map(item => normalizeEntry(type, item))
      .filter(Boolean) as Record<string, unknown>[];
    await annotateMine(type, entries, userId);
    return NextResponse.json({ ok: true, entries });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err), entries: [] }, { status: getSupabaseConfig() ? 500 : 503 });
  }
}

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    if (!type) return NextResponse.json({ ok: false, error: "missing_type" }, { status: 400 });
    const name = cleanText(record.name, 80);
    if (!name) return NextResponse.json({ ok: false, error: "missing_name" }, { status: 400 });
    const now = new Date().toISOString();

    if (type === "material") {
      const kind = cleanText(record.kind, 20);
      if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) {
        return NextResponse.json({ ok: false, error: "unknown_material_kind" }, { status: 400 });
      }
      const payload = record.payload;
      if (!payload || typeof payload !== "object") {
        return NextResponse.json({ ok: false, error: "missing_payload" }, { status: 400 });
      }
      if (JSON.stringify(payload).length > MAX_MATERIAL_PAYLOAD) {
        return NextResponse.json({ ok: false, error: "材料太大了（封面图请压小一点）。" }, { status: 413 });
      }
      const insert = await supabaseFetch<unknown[]>(
        `mixology_items?select=${ITEM_COLUMNS}`,
        {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            id: createId("mxi"),
            kind,
            name,
            hook: cleanText(record.hook, 200),
            cover: cleanText(record.cover, 2_000_000),
            tags: normalizeTags(record.tags),
            payload,
            author_id: account.id,
            author_name: cleanText(record.authorName, 80) || account.displayName,
            created_at: now,
            updated_at: now,
          }),
        },
      );
      if (!insert.ok) return NextResponse.json({ ok: false, error: insert.error }, { status: insert.status });
      return NextResponse.json({ ok: true, entry: normalizeEntry("material", insert.data[0], { withPayload: true }) });
    }

    const materials = Array.isArray(record.materials) ? record.materials : [];
    if (materials.length === 0) {
      return NextResponse.json({ ok: false, error: "missing_materials" }, { status: 400 });
    }
    if (JSON.stringify(materials).length > MAX_RECIPE_PAYLOAD) {
      return NextResponse.json({ ok: false, error: "配方太大了（封面图请压小一点）。" }, { status: 413 });
    }
    const insert = await supabaseFetch<unknown[]>(
      `mixology_recipes?select=${RECIPE_COLUMNS}`,
      {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          id: createId("mxr"),
          name,
          intro: cleanText(record.intro, 400),
          cover: cleanText(record.cover, 2_000_000),
          char_name: cleanText(record.charName, 80),
          part_names: normalizeTags(record.partNames),
          materials,
          author_id: account.id,
          author_name: cleanText(record.authorName, 80) || account.displayName,
          created_at: now,
          updated_at: now,
        }),
      },
    );
    if (!insert.ok) return NextResponse.json({ ok: false, error: insert.error }, { status: insert.status });
    return NextResponse.json({ ok: true, entry: normalizeEntry("recipe", insert.data[0], { withPayload: true }) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getSupabaseConfig() ? 400 : 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    const id = cleanText(record.id, 160);
    if (!type || !id) return NextResponse.json({ ok: false, error: "missing_target" }, { status: 400 });
    const name = cleanText(record.name, 80);
    if (!name) return NextResponse.json({ ok: false, error: "missing_name" }, { status: 400 });

    // 只改内容，不动 like/save/view/comment 计数与 created_at——更新不该清零社交数据
    let payload: Record<string, unknown>;
    if (type === "material") {
      const kind = cleanText(record.kind, 20);
      if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) {
        return NextResponse.json({ ok: false, error: "unknown_material_kind" }, { status: 400 });
      }
      const materialPayload = record.payload;
      if (!materialPayload || typeof materialPayload !== "object") {
        return NextResponse.json({ ok: false, error: "missing_payload" }, { status: 400 });
      }
      if (JSON.stringify(materialPayload).length > MAX_MATERIAL_PAYLOAD) {
        return NextResponse.json({ ok: false, error: "材料太大了（封面图请压小一点）。" }, { status: 413 });
      }
      payload = {
        kind,
        name,
        hook: cleanText(record.hook, 200),
        cover: cleanText(record.cover, 2_000_000),
        tags: normalizeTags(record.tags),
        payload: materialPayload,
        updated_at: new Date().toISOString(),
      };
    } else {
      const materials = Array.isArray(record.materials) ? record.materials : [];
      if (materials.length === 0) {
        return NextResponse.json({ ok: false, error: "missing_materials" }, { status: 400 });
      }
      if (JSON.stringify(materials).length > MAX_RECIPE_PAYLOAD) {
        return NextResponse.json({ ok: false, error: "配方太大了（封面图请压小一点）。" }, { status: 413 });
      }
      payload = {
        name,
        intro: cleanText(record.intro, 400),
        cover: cleanText(record.cover, 2_000_000),
        char_name: cleanText(record.charName, 80),
        part_names: normalizeTags(record.partNames),
        materials,
        updated_at: new Date().toISOString(),
      };
    }

    const columns = type === "material" ? ITEM_COLUMNS : RECIPE_COLUMNS;
    const result = await supabaseFetch<unknown[]>(
      `${TABLES[type]}?id=eq.${encodeFilter(id)}&author_id=eq.${encodeFilter(account.id)}&deleted_at=is.null&select=${columns}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      },
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    if (!Array.isArray(result.data) || result.data.length === 0) {
      // 已被自己下架、或根本不是自己的——让客户端清掉本地的发布标记，改走重新发布
      return NextResponse.json({ ok: false, error: "没有找到可更新的发布内容，它可能已经下架了。", gone: true }, { status: 404 });
    }
    return NextResponse.json({ ok: true, entry: normalizeEntry(type, result.data[0], { withPayload: true }) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getSupabaseConfig() ? 400 : 503 });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    const id = cleanText(record.id, 160);
    const action = cleanText(record.action, 40);
    if (!type || !id) return NextResponse.json({ ok: false, error: "missing_target" }, { status: 400 });
    const table = TABLES[type];
    const userId = account.id;

    const currentResult = await supabaseFetch<unknown[]>(
      `${table}?id=eq.${encodeFilter(id)}&deleted_at=is.null&select=id,like_count,save_count`,
    );
    if (!currentResult.ok) return NextResponse.json({ ok: false, error: currentResult.error }, { status: currentResult.status });
    const current = currentResult.data[0] as Record<string, unknown> | undefined;
    if (!current) return NextResponse.json({ ok: false, error: "没有找到这份内容。" }, { status: 404 });

    let liked = false;
    let saved = false;
    let likeCount = clampCount(current.like_count);
    let saveCount = clampCount(current.save_count);

    if (action === "toggle_like") {
      const existing = await supabaseFetch<unknown[]>(
        `mixology_likes?target_type=eq.${type}&target_id=eq.${encodeFilter(id)}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
      );
      if (!existing.ok) return NextResponse.json({ ok: false, error: existing.error }, { status: existing.status });
      if (existing.data.length > 0) {
        const removed = await supabaseFetch<unknown[]>(
          `mixology_likes?target_type=eq.${type}&target_id=eq.${encodeFilter(id)}&user_id=eq.${encodeFilter(userId)}`,
          { method: "DELETE" },
        );
        if (!removed.ok) return NextResponse.json({ ok: false, error: removed.error }, { status: removed.status });
        likeCount = Math.max(0, likeCount - 1);
        liked = false;
      } else {
        const added = await supabaseFetch<unknown[]>(
          "mixology_likes",
          {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ target_type: type, target_id: id, user_id: userId }),
          },
        );
        if (!added.ok) return NextResponse.json({ ok: false, error: added.error }, { status: added.status });
        likeCount += 1;
        liked = true;
      }
    } else if (action === "save") {
      const existing = await supabaseFetch<unknown[]>(
        `mixology_saves?target_type=eq.${type}&target_id=eq.${encodeFilter(id)}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
      );
      if (!existing.ok) return NextResponse.json({ ok: false, error: existing.error }, { status: existing.status });
      if (existing.data.length === 0) {
        const added = await supabaseFetch<unknown[]>(
          "mixology_saves",
          {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ target_type: type, target_id: id, user_id: userId }),
          },
        );
        if (!added.ok) return NextResponse.json({ ok: false, error: added.error }, { status: added.status });
        saveCount += 1;
      }
      saved = true;
    } else {
      return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
    }

    const update = await supabaseFetch<unknown[]>(
      `${table}?id=eq.${encodeFilter(id)}&deleted_at=is.null&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ like_count: likeCount, save_count: saveCount }),
      },
    );
    if (!update.ok) return NextResponse.json({ ok: false, error: update.error }, { status: update.status });
    return NextResponse.json({ ok: true, liked, saved, likeCount, saveCount });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getSupabaseConfig() ? 400 : 503 });
  }
}

export async function DELETE(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    const id = cleanText(record.id, 160);
    if (!type || !id) return NextResponse.json({ ok: false, error: "missing_target" }, { status: 400 });
    const result = await supabaseFetch<unknown[]>(
      `${TABLES[type]}?id=eq.${encodeFilter(id)}&author_id=eq.${encodeFilter(account.id)}&deleted_at=is.null&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      },
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    if (!Array.isArray(result.data) || result.data.length === 0) {
      return NextResponse.json({ ok: false, error: "没有找到可下架的内容。" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getSupabaseConfig() ? 400 : 503 });
  }
}
