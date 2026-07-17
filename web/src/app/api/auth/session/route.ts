import { NextResponse } from "next/server";

import { getAuthSettings } from "@/lib/auth/store";
import { getCurrentUser, serializeCurrentUser, serializePublicSettings } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET() {
    const [user, settings] = await Promise.all([getCurrentUser(), getAuthSettings()]);
    return NextResponse.json({
        user: user ? serializeCurrentUser(user) : null,
        settings: serializePublicSettings(settings),
    });
}
