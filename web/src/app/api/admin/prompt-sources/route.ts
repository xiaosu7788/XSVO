import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { isAuthInputError } from "@/lib/auth/store";
import { readJsonBody } from "@/lib/auth/request";
import { listPromptSources, refreshEnabledPromptSources, updatePromptSourceEnabled } from "@/lib/prompts/store";

export const runtime = "nodejs";

export async function GET() {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (currentUser.role !== "admin") return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    return NextResponse.json({ sources: await listPromptSources() });
}

export async function PATCH(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (currentUser.role !== "admin") return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    try {
        const body = await readJsonBody<{ id?: string; enabled?: boolean; refresh?: boolean }>(request);
        if (body.refresh) return NextResponse.json({ sources: await refreshEnabledPromptSources() });
        if (!body.id || typeof body.enabled !== "boolean") return NextResponse.json({ error: "参数不完整" }, { status: 400 });
        const source = await updatePromptSourceEnabled(body.id, body.enabled);
        return NextResponse.json({ source, sources: await listPromptSources() });
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Update prompt source failed", error);
        return NextResponse.json({ error: "更新提示词源失败" }, { status: 500 });
    }
}
