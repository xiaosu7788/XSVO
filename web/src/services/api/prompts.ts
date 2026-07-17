import { compactApiParams, serializeApiParams } from "@/services/api/request";

export type Prompt = {
    id: string;
    scope?: "library" | "user";
    ownerUserId?: string;
    sourceId?: string;
    sourceName?: string;
    title: string;
    coverUrl: string;
    prompt: string;
    tags: string[];
    category: string;
    githubUrl?: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
};

export type PromptSourceStatus = {
    id: string;
    label: string;
    url: string;
    type: string;
    builtin: boolean;
    enabled: boolean;
    promptCount: number;
    lastSyncedAt: string;
};

export const ALL_PROMPTS_OPTION = "全部";

export type PromptListResponse = {
    items: Prompt[];
    tags: string[];
    categories: string[];
    sources: PromptSourceStatus[];
    total: number;
};

export async function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, source = ALL_PROMPTS_OPTION, page, pageSize, random = false }: { keyword?: string; tag?: string[]; category?: string; source?: string; page?: number; pageSize?: number; random?: boolean } = {}) {
    const params = serializeApiParams(
        compactApiParams({
            ...(keyword ? { keyword } : {}),
            ...(tag.length ? { tag } : {}),
            ...(category !== ALL_PROMPTS_OPTION ? { category } : {}),
            ...(source !== ALL_PROMPTS_OPTION ? { source } : {}),
            ...(random ? { random: "1" } : {}),
            ...(page ? { page } : {}),
            ...(pageSize ? { pageSize } : {}),
        }),
    );
    const response = await fetch(`/api/prompts${params.size ? `?${params}` : ""}`);
    if (!response.ok) throw new Error("获取提示词失败");
    return (await response.json()) as PromptListResponse;
}

export function formatPromptDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
