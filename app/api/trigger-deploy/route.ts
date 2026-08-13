import { NextRequest, NextResponse } from "next/server";

// GitHub Webhook → 触发 Vercel 重新部署
// 环境变量：VERCEL_TOKEN（Vercel API Token）
export async function POST(req: NextRequest) {
  const event = req.headers.get("x-github-event");
  if (event !== "push") {
    return NextResponse.json({ ok: true, message: "ignored: not push event" });
  }

  try {
    const body = await req.json();
    if (body.ref !== "refs/heads/main") {
      return NextResponse.json({ ok: true, message: "ignored: not main branch" });
    }

    const vercelToken = process.env.VERCEL_TOKEN;
    if (!vercelToken) {
      return NextResponse.json({ ok: false, error: "VERCEL_TOKEN not set" }, { status: 500 });
    }

    const projectId = "prj_ot3QDTmg0mPeTIHPe4TkGttGuPMY";
    const response = await fetch(
      `https://api.vercel.com/v13/deployments?projectId=${projectId}&forceNew=1`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${vercelToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "ai-virtual-phone",
          target: "production",
          gitSource: {
            type: "github",
            org: "yechen1844",
            repo: "ai-virtual-phone",
            ref: "main",
          },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json({ ok: false, error: data.error }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deployId: data.id, url: data.url });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
