import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROXY_BYTES = 300 * 1024 * 1024;
const MEDIA_PROXY_TIMEOUT_MS = 30 * 1000;

export async function GET(request: Request) {
    return proxyMedia(request, "GET");
}

export async function HEAD(request: Request) {
    return proxyMedia(request, "HEAD");
}

async function proxyMedia(request: Request, method: "GET" | "HEAD") {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const target = readTargetUrl(request);
    if (!target) return NextResponse.json({ error: "Invalid media url" }, { status: 400 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_PROXY_TIMEOUT_MS);
    try {
        const range = request.headers.get("range");
        const upstream = await fetch(target.toString(), {
            method,
            headers: {
                "User-Agent": "XSVO-Media-Proxy/1.0",
                ...(range ? { Range: range } : {}),
            },
            cache: "no-store",
            redirect: "follow",
            signal: controller.signal,
        });

        if (!upstream.ok && upstream.status !== 206) {
            return NextResponse.json({ error: "Media fetch failed" }, { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 });
        }

        const contentLength = Number(upstream.headers.get("content-length") || 0);
        if (contentLength > MAX_PROXY_BYTES) return NextResponse.json({ error: "Media is too large" }, { status: 413 });

        const headers = mediaHeaders(upstream.headers);
        if (method === "HEAD") return new NextResponse(null, { status: upstream.status, headers });
        return new NextResponse(upstream.body, { status: upstream.status, headers });
    } catch {
        return NextResponse.json({ error: "Media fetch failed" }, { status: 502 });
    } finally {
        clearTimeout(timer);
    }
}

function readTargetUrl(request: Request) {
    const raw = new URL(request.url).searchParams.get("url") || "";
    let target: URL;
    try {
        target = new URL(raw);
    } catch {
        return null;
    }
    if (!["http:", "https:"].includes(target.protocol)) return null;
    if (isBlockedHost(target.hostname)) return null;
    return target;
}

function mediaHeaders(source: Headers) {
    const headers = new Headers();
    const contentType = source.get("content-type") || "application/octet-stream";
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", "private, max-age=600");
    for (const key of ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
        const value = source.get(key);
        if (value) headers.set(key, value);
    }
    return headers;
}

function isBlockedHost(hostname: string) {
    const host = hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
    const parts = host.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}
