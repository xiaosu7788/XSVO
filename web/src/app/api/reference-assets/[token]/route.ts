import { NextResponse } from "next/server";

import { readReferenceAsset } from "@/lib/server/reference-asset-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ token: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
    const { token } = await context.params;
    const asset = await readReferenceAsset(token);
    if (!asset) return NextResponse.json({ error: "参考图不存在或已过期" }, { status: 404 });

    return new NextResponse(asset.bytes, {
        headers: {
            "Content-Type": asset.mimeType,
            "Cache-Control": "public, max-age=86400",
            "Content-Length": String(asset.bytes.length),
        },
    });
}
