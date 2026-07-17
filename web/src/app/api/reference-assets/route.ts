import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { writeReferenceImageDataUrl } from "@/lib/server/reference-asset-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as { dataUrl?: unknown; type?: unknown };
    const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
    if (!dataUrl) return NextResponse.json({ error: "缺少参考图" }, { status: 400 });
    if (body.type && body.type !== "image") return NextResponse.json({ error: "当前仅支持参考图临时地址" }, { status: 400 });

    try {
        const asset = await writeReferenceImageDataUrl(dataUrl);
        return NextResponse.json({
            url: `${publicOrigin(request)}/api/reference-assets/${asset.token}`,
            token: asset.token,
            bytes: asset.bytes,
            mimeType: asset.mimeType,
        });
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "参考图临时保存失败" }, { status: 400 });
    }
}

function publicOrigin(request: Request) {
    const configured = normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL || "");
    if (configured) return configured;

    const url = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost || request.headers.get("host") || url.host;
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const proto = forwardedProto || url.protocol.replace(/:$/, "");
    return `${proto}://${host}`.replace(/\/+$/, "");
}

function normalizeOrigin(value: string) {
    try {
        const url = new URL(value.trim().replace(/\/+$/, ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        return url.origin;
    } catch {
        return "";
    }
}
