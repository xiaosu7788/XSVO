import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getTextTask } from "@/lib/server/text-task-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { id } = await context.params;
    const task = getTextTask(id);
    if (!task || task.userId !== currentUser.id) return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });

    const headers = new Headers();
    if (typeof task.pointsRemaining === "number") {
        headers.set("x-vozeb-points-remaining", String(task.pointsRemaining));
        headers.set("x-xsvo-points-remaining", String(task.pointsRemaining));
    }
    return NextResponse.json(
        {
            task: {
                id: task.id,
                status: task.status,
                model: task.config.model,
                result: task.result,
                error: task.error,
            },
        },
        { headers },
    );
}
