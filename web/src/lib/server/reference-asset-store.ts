import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

import { resolveServerDataPath } from "@/lib/server/data-dir";

const REFERENCE_ASSET_ROOT = resolveServerDataPath("reference-assets");
const REFERENCE_ASSET_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

export type StoredReferenceAsset = {
    token: string;
    bytes: number;
    mimeType: string;
};

export async function writeReferenceImageDataUrl(dataUrl: string): Promise<StoredReferenceAsset> {
    await cleanupExpiredReferenceAssets().catch(() => undefined);
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) throw new Error("参考图格式不正确");
    if (parsed.bytes.length > MAX_REFERENCE_IMAGE_BYTES) throw new Error("参考图不能超过 20MB");

    const token = `${Date.now()}-${randomUUID()}${extensionFromMime(parsed.mimeType)}`;
    const filePath = resolve(REFERENCE_ASSET_ROOT, token);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, parsed.bytes);
    return { token, bytes: parsed.bytes.length, mimeType: parsed.mimeType };
}

export async function readReferenceAsset(token: string) {
    const safeToken = basename(token || "");
    if (!safeToken || safeToken !== token || !isReferenceAssetToken(safeToken)) return null;

    const filePath = resolve(REFERENCE_ASSET_ROOT, safeToken);
    const root = resolve(REFERENCE_ASSET_ROOT);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return null;

    try {
        const fileStat = await stat(filePath);
        if (Date.now() - fileStat.mtimeMs > REFERENCE_ASSET_TTL_MS) {
            await unlink(filePath).catch(() => undefined);
            return null;
        }
        return { bytes: await readFile(filePath), mimeType: mimeTypeFromToken(safeToken), mtimeMs: fileStat.mtimeMs };
    } catch {
        return null;
    }
}

async function cleanupExpiredReferenceAssets() {
    await mkdir(REFERENCE_ASSET_ROOT, { recursive: true });
    const entries = await readdir(REFERENCE_ASSET_ROOT, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
        entries
            .filter((entry) => entry.isFile() && isReferenceAssetToken(entry.name))
            .map(async (entry) => {
                const filePath = resolve(REFERENCE_ASSET_ROOT, entry.name);
                const fileStat = await stat(filePath).catch(() => null);
                if (fileStat && now - fileStat.mtimeMs > REFERENCE_ASSET_TTL_MS) await unlink(filePath).catch(() => undefined);
            }),
    );
}

function parseImageDataUrl(dataUrl: string) {
    const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=\s]+)$/i);
    if (!match) return null;
    const mimeType = normalizeMimeType(match[1]);
    const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    return bytes.length ? { mimeType, bytes } : null;
}

function normalizeMimeType(value: string) {
    const mimeType = value.toLowerCase();
    return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function extensionFromMime(mimeType: string) {
    if (mimeType === "image/jpeg") return ".jpg";
    if (mimeType === "image/webp") return ".webp";
    if (mimeType === "image/gif") return ".gif";
    return ".png";
}

function mimeTypeFromToken(token: string) {
    const lower = token.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    return "image/png";
}

function isReferenceAssetToken(value: string) {
    return /^\d{10,}-[0-9a-f-]{36}\.(?:png|jpg|jpeg|webp|gif)$/i.test(value);
}
