import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AuthInputError } from "@/lib/auth/store";
import { resolveServerDataPath } from "@/lib/server/data-dir";

export type PromptScope = "library" | "user";

export type StoredPrompt = {
    id: string;
    scope: PromptScope;
    ownerUserId?: string;
    sourceId?: string;
    sourceName?: string;
    title: string;
    coverUrl: string;
    prompt: string;
    tags: string[];
    category: string;
    preview: string;
    githubUrl?: string;
    source?: string;
    createdAt: string;
    updatedAt: string;
};

export type PromptInput = {
    title?: string;
    coverUrl?: string;
    prompt?: string;
    tags?: string[] | string;
    category?: string;
    preview?: string;
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

type PromptSourceDefinition = Omit<PromptSourceStatus, "enabled" | "promptCount" | "lastSyncedAt">;

type PromptSourceSetting = {
    enabled: boolean;
    lastSyncedAt?: string;
};

type PromptDatabase = {
    version: 1;
    prompts: StoredPrompt[];
    seedSources: string[];
    promptSourceSettings: Record<string, PromptSourceSetting>;
};

type OriginalAuthorSeed = {
    id: string;
    title: string;
    coverUrl: string;
    prompt: string;
    tags: string[];
    category: string;
    preview: string;
    githubUrl: string;
};

type PromptListOptions = {
    scope: PromptScope;
    ownerUserId?: string;
    keyword?: string;
    tags?: string[];
    category?: string;
    source?: string;
    includeDisabledSources?: boolean;
    random?: boolean;
    page?: number;
    pageSize?: number;
};

const PROMPT_DATA_FILE = resolveServerDataPath("prompts.json");
const DEFAULT_COVER_URL = "";
const LEGACY_ORIGINAL_AUTHOR_SEED_SOURCE_PREFIX = `basketikun/${"in"}finite-canvas-prompts`;
const ORIGINAL_AUTHOR_SEED_SOURCE_PREFIX = "vozeb/original-author-prompts";
const ORIGINAL_AUTHOR_SEED_SOURCE = `${ORIGINAL_AUTHOR_SEED_SOURCE_PREFIX}:v3`;
const MANUAL_PROMPT_SOURCE_ID = "manual";
const PROMPT_SOURCE_DEFINITIONS: PromptSourceDefinition[] = [
    { id: MANUAL_PROMPT_SOURCE_ID, label: "手动添加", url: "", type: "本地", builtin: false },
    { id: "awesome-gpt-image", label: "Awesome GPT Image", url: "https://cdn.jsdelivr.net/gh/ZeroLu/awesome-gpt-image@main/README.zh-CN.md", type: "内容", builtin: true },
    { id: "awesome-gpt4o-image-prompts", label: "Awesome GPT-4o Image Prompts", url: "https://cdn.jsdelivr.net/gh/ImgEdify/Awesome-GPT4o-Image-Prompts@main/Prompts.html", type: "内容", builtin: true },
    { id: "youmind-gpt-image-2", label: "YouMind GPT Image 2", url: "https://cdn.jsdelivr.net/gh/YouMind-OpenLab/awesome-gpt-image-2@main/README_zh.md", type: "内容", builtin: true },
    { id: "youmind-nano-banana-pro", label: "YouMind Nano Banana Pro", url: "https://cdn.jsdelivr.net/gh/YouMind-OpenLab/awesome-nano-banana-pro-prompts@main/README_zh.md", type: "内容", builtin: true },
    { id: "davidwu-gpt-image2-prompts", label: "DavidWu GPT Image 2 Prompts", url: "https://cdn.jsdelivr.net/gh/davidwuw0811-boop/awesome-gpt-image2-prompts@main/prompts.json", type: "内容", builtin: true },
];
let mutationQueue = Promise.resolve();

export async function listPrompts(options: PromptListOptions) {
    const db = await readPromptDb({ includeSeeds: true });
    const keyword = (options.keyword || "").trim().toLowerCase();
    const tags = options.tags || [];
    const category = options.category || "";
    const source = options.source || "";
    const page = Math.max(1, options.page || 1);
    const pageSize = Math.max(1, Math.min(100, options.pageSize || 20));
    const enabledSourceIds = new Set(promptSourceStatuses(db).filter((item) => item.enabled).map((item) => item.id));
    const base = db.prompts
        .filter((item) => item.scope === options.scope)
        .filter((item) => (options.scope === "user" ? item.ownerUserId === options.ownerUserId : true))
        .filter((item) => options.includeDisabledSources || enabledSourceIds.has(promptSourceIdOf(item)))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const sourceBase = filterPrompts(base, { keyword: "", category: "", tags: [], source });
    const withoutTagFilter = filterPrompts(base, { keyword, category, tags: [], source });
    const filtered = options.random ? shufflePrompts(filterPrompts(base, { keyword, category, tags, source })) : filterPrompts(base, { keyword, category, tags, source });

    return {
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        tags: collectTags(withoutTagFilter),
        categories: collectCategories(sourceBase),
        sources: promptSourceStatuses(db).filter((item) => options.includeDisabledSources || item.enabled),
        total: filtered.length,
        scopeTotal: base.length,
    };
}

export async function listPromptSources() {
    const db = await readPromptDb({ includeSeeds: true });
    return promptSourceStatuses(db);
}

export async function updatePromptSourceEnabled(id: string, enabled: boolean) {
    return mutatePromptDb((db) => {
        const source = promptSourceDefinition(id);
        if (!source) throw new AuthInputError("提示词源不存在");
        db.promptSourceSettings = normalizePromptSourceSettings(db.promptSourceSettings);
        db.promptSourceSettings[id] = { ...db.promptSourceSettings[id], enabled: id === MANUAL_PROMPT_SOURCE_ID ? true : enabled };
        return promptSourceStatuses(db).find((item) => item.id === id)!;
    });
}

export async function refreshEnabledPromptSources() {
    return mutatePromptDb((db) => {
        const now = new Date().toISOString();
        db.promptSourceSettings = normalizePromptSourceSettings(db.promptSourceSettings);
        for (const source of PROMPT_SOURCE_DEFINITIONS) {
            if (db.promptSourceSettings[source.id]?.enabled) db.promptSourceSettings[source.id] = { ...db.promptSourceSettings[source.id], lastSyncedAt: now };
        }
        return promptSourceStatuses(db);
    });
}

function shufflePrompts(items: StoredPrompt[]) {
    const next = [...items];
    for (let index = next.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [next[index], next[randomIndex]] = [next[randomIndex], next[index]];
    }
    return next;
}

export async function listAllLibraryPrompts() {
    const db = await readPromptDb({ includeSeeds: true });
    const enabledSourceIds = new Set(promptSourceStatuses(db).filter((item) => item.enabled).map((item) => item.id));
    return db.prompts.filter((item) => item.scope === "library" && enabledSourceIds.has(promptSourceIdOf(item))).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function countAllLibraryPrompts() {
    const db = await readPromptDb({ includeSeeds: true });
    return db.prompts.filter((item) => item.scope === "library").length;
}

export async function createPrompt(scope: PromptScope, input: PromptInput, ownerUserId?: string) {
    return mutatePromptDb((db) => {
        const now = new Date().toISOString();
        const prompt = normalizePromptInput(input);
        const item: StoredPrompt = {
            id: randomUUID(),
            scope,
            ownerUserId: scope === "user" ? ownerUserId : undefined,
            sourceId: scope === "library" ? MANUAL_PROMPT_SOURCE_ID : undefined,
            sourceName: scope === "library" ? promptSourceDefinition(MANUAL_PROMPT_SOURCE_ID)?.label : undefined,
            title: prompt.title,
            coverUrl: prompt.coverUrl,
            prompt: prompt.prompt,
            tags: prompt.tags,
            category: prompt.category,
            preview: prompt.preview,
            createdAt: now,
            updatedAt: now,
        };
        db.prompts.push(item);
        return item;
    });
}

export async function updatePrompt(id: string, input: PromptInput, options: { scope: PromptScope; ownerUserId?: string }) {
    return mutatePromptDb((db) => {
        const item = db.prompts.find((prompt) => prompt.id === id && prompt.scope === options.scope && (options.scope === "library" || prompt.ownerUserId === options.ownerUserId));
        if (!item) throw new AuthInputError("提示词不存在");
        const next = normalizePromptInput({ ...item, ...input });
        item.title = next.title;
        item.coverUrl = next.coverUrl;
        item.prompt = next.prompt;
        item.tags = next.tags;
        item.category = next.category;
        item.preview = next.preview;
        item.updatedAt = new Date().toISOString();
        return item;
    });
}

export async function deletePrompt(id: string, options: { scope: PromptScope; ownerUserId?: string }) {
    return mutatePromptDb((db) => {
        const before = db.prompts.length;
        db.prompts = db.prompts.filter((prompt) => !(prompt.id === id && prompt.scope === options.scope && (options.scope === "library" || prompt.ownerUserId === options.ownerUserId)));
        if (db.prompts.length === before) throw new AuthInputError("提示词不存在");
        return { ok: true };
    });
}

function filterPrompts(items: StoredPrompt[], options: { keyword: string; category: string; tags: string[]; source: string }) {
    return items.filter((item) => {
        if (isActiveOption(options.source) && promptSourceIdOf(item) !== options.source) return false;
        if (isActiveOption(options.category) && item.category !== options.category) return false;
        if (options.tags.length && !options.tags.some((tag) => item.tags.includes(tag))) return false;
        if (!options.keyword) return true;
        return [item.title, item.prompt, item.category, item.sourceName || "", ...item.tags].join(" ").toLowerCase().includes(options.keyword);
    });
}

function normalizePromptInput(input: PromptInput) {
    const title = repairMojibakeText(input.title || "").trim();
    const prompt = repairMojibakeText(input.prompt || "").trim();
    if (!title) throw new AuthInputError("请输入标题");
    if (!prompt) throw new AuthInputError("请输入提示词内容");
    return {
        title: title.slice(0, 120),
        coverUrl: (input.coverUrl || DEFAULT_COVER_URL).trim(),
        prompt,
        tags: normalizeTags(input.tags),
        category:
            repairMojibakeText(input.category || "默认")
                .trim()
                .slice(0, 40) || "默认",
        preview: repairMojibakeText(input.preview || "").trim(),
    };
}

function normalizeTags(value: PromptInput["tags"]) {
    const raw = Array.isArray(value) ? value : String(value || "").split(/[,，\n]/);
    return Array.from(new Set(raw.map((tag) => repairMojibakeText(tag).trim().toLowerCase()).filter(Boolean))).slice(0, 12);
}

async function readPromptDb({ includeSeeds }: { includeSeeds: boolean }): Promise<PromptDatabase> {
    try {
        const raw = await readFile(PROMPT_DATA_FILE, "utf8");
        const db = JSON.parse(raw) as Partial<PromptDatabase>;
        const normalized: PromptDatabase = {
            version: 1,
            prompts: Array.isArray(db.prompts) ? db.prompts.map(normalizeStoredPrompt).filter(Boolean) : [],
            seedSources: Array.isArray(db.seedSources) ? db.seedSources.filter(Boolean) : [],
            promptSourceSettings: normalizePromptSourceSettings((db as Partial<PromptDatabase>).promptSourceSettings),
        };
        return includeSeeds ? ensureOriginalAuthorPrompts(normalized) : normalized;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            const empty = { version: 1 as const, prompts: [], seedSources: [], promptSourceSettings: normalizePromptSourceSettings(undefined) };
            return includeSeeds ? ensureOriginalAuthorPrompts(empty) : empty;
        }
        throw error;
    }
}

async function ensureOriginalAuthorPrompts(db: PromptDatabase) {
    if (db.seedSources.includes(ORIGINAL_AUTHOR_SEED_SOURCE)) return db;
    const seeds = (await import("@/lib/prompts/original-author-seeds.json")).default as OriginalAuthorSeed[];
    if (!seeds.length) return db;
    const now = new Date().toISOString();
    db.prompts = db.prompts.filter((item) => !isOriginalAuthorSeedSource(item.source));
    db.seedSources = db.seedSources.filter((source) => !isOriginalAuthorSeedSource(source));
    const existingIds = new Set(db.prompts.map((item) => item.id));
    const seededPrompts = seeds
        .map((seed): StoredPrompt => ({
            id: `original-${seed.id}`,
            scope: "library",
            title: seed.title,
            coverUrl: seed.coverUrl,
            prompt: seed.prompt,
            tags: normalizeTags(seed.tags),
            category: seed.category,
            preview: seed.preview,
            githubUrl: seed.githubUrl,
            sourceId: seed.category,
            sourceName: promptSourceDefinition(seed.category)?.label || seed.category,
            source: ORIGINAL_AUTHOR_SEED_SOURCE,
            createdAt: now,
            updatedAt: now,
        }))
        .filter((item) => !existingIds.has(item.id));
    db.prompts.push(...seededPrompts);
    db.seedSources = Array.from(new Set([...db.seedSources, ORIGINAL_AUTHOR_SEED_SOURCE]));
    await writePromptDb(db);
    return db;
}

async function mutatePromptDb<T>(mutator: (db: PromptDatabase) => T | Promise<T>) {
    const run = mutationQueue.then(async () => {
        const db = await readPromptDb({ includeSeeds: false });
        const result = await mutator(db);
        await writePromptDb(db);
        return result;
    });
    mutationQueue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

async function writePromptDb(db: PromptDatabase) {
    db.promptSourceSettings = normalizePromptSourceSettings(db.promptSourceSettings);
    await mkdir(dirname(PROMPT_DATA_FILE), { recursive: true });
    await writeFile(PROMPT_DATA_FILE, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

function normalizeStoredPrompt(value: StoredPrompt): StoredPrompt {
    const now = new Date().toISOString();
    const sourceId = normalizePromptSourceId(value);
    return {
        id: value.id || randomUUID(),
        scope: value.scope === "user" ? "user" : "library",
        ownerUserId: value.ownerUserId,
        sourceId,
        sourceName: value.sourceName || promptSourceDefinition(sourceId)?.label || sourceId,
        title: repairMojibakeText(value.title || "") || "未命名提示词",
        coverUrl: value.coverUrl || "",
        prompt: repairMojibakeText(value.prompt || ""),
        tags: normalizeTags(value.tags),
        category: repairMojibakeText(value.category || "") || "默认",
        preview: repairMojibakeText(value.preview || ""),
        githubUrl: value.githubUrl,
        source: value.source,
        createdAt: value.createdAt || now,
        updatedAt: value.updatedAt || value.createdAt || now,
    };
}

function normalizePromptSourceSettings(value?: Record<string, Partial<PromptSourceSetting>>): Record<string, PromptSourceSetting> {
    const settings: Record<string, PromptSourceSetting> = {};
    for (const source of PROMPT_SOURCE_DEFINITIONS) {
        const current = value?.[source.id];
        settings[source.id] = {
            enabled: source.id === MANUAL_PROMPT_SOURCE_ID ? true : current?.enabled !== false,
            lastSyncedAt: typeof current?.lastSyncedAt === "string" ? current.lastSyncedAt : "",
        };
    }
    return settings;
}

function promptSourceStatuses(db: PromptDatabase): PromptSourceStatus[] {
    const counts = new Map<string, number>();
    const syncedAt = new Map<string, string>();
    for (const prompt of db.prompts.filter((item) => item.scope === "library")) {
        const id = promptSourceIdOf(prompt);
        counts.set(id, (counts.get(id) || 0) + 1);
        const current = syncedAt.get(id) || "";
        if (!current || Date.parse(prompt.updatedAt) > Date.parse(current)) syncedAt.set(id, prompt.updatedAt);
    }
    const settings = normalizePromptSourceSettings(db.promptSourceSettings);
    return PROMPT_SOURCE_DEFINITIONS.map((source) => ({
        ...source,
        enabled: settings[source.id]?.enabled !== false,
        promptCount: counts.get(source.id) || 0,
        lastSyncedAt: settings[source.id]?.lastSyncedAt || syncedAt.get(source.id) || "",
    }));
}

function promptSourceDefinition(id: string) {
    return PROMPT_SOURCE_DEFINITIONS.find((source) => source.id === id);
}

function promptSourceIdOf(prompt: Pick<StoredPrompt, "sourceId" | "source" | "category">) {
    return normalizePromptSourceId(prompt);
}

function normalizePromptSourceId(prompt: Pick<StoredPrompt, "sourceId" | "source" | "category">) {
    if (prompt.sourceId && promptSourceDefinition(prompt.sourceId)) return prompt.sourceId;
    if (isOriginalAuthorSeedSource(prompt.source) && prompt.category && promptSourceDefinition(prompt.category)) return prompt.category;
    return MANUAL_PROMPT_SOURCE_ID;
}

function repairMojibakeText(value: string) {
    if (!looksLikeUtf8Mojibake(value)) return value;
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (!repaired || repaired.includes("\uFFFD")) return value;
    return textQualityScore(repaired) > textQualityScore(value) ? repaired : value;
}

function looksLikeUtf8Mojibake(value: string) {
    if (!value) return false;
    if (/[\u0080-\u009f]/.test(value)) return true;
    if (/[ÂÃ][\u0080-\u00ff]/.test(value)) return true;
    const markers = value.match(/[åæçèéäöüï½ð]/g)?.length || 0;
    return markers >= 2 && !/[\u4e00-\u9fff]/.test(value);
}

function textQualityScore(value: string) {
    const cjk = value.match(/[\u4e00-\u9fff]/g)?.length || 0;
    const controls = value.match(/[\u0080-\u009f]/g)?.length || 0;
    const replacements = value.match(/\uFFFD/g)?.length || 0;
    const mojibakeMarkers = value.match(/[ÂÃåæçèéäöüï½ð]/g)?.length || 0;
    return cjk * 4 - controls * 6 - replacements * 20 - mojibakeMarkers;
}

function collectTags(items: StoredPrompt[]) {
    return Array.from(new Set(items.flatMap((item) => item.tags).filter(isUsefulPromptTag)));
}

function collectCategories(items: StoredPrompt[]) {
    return Array.from(new Set(items.map((item) => item.category).filter(Boolean)));
}

function isActiveOption(value: string) {
    return value && value !== "全部" && value !== "all";
}

function isOriginalAuthorSeedSource(source?: string) {
    return Boolean(source?.startsWith(ORIGINAL_AUTHOR_SEED_SOURCE_PREFIX) || source?.startsWith(LEGACY_ORIGINAL_AUTHOR_SEED_SOURCE_PREFIX));
}

function isUsefulPromptTag(tag?: string) {
    const value = (tag || "").trim();
    if (!value || value.length > 24) return false;
    if (value.startsWith("@")) return false;
    if (/^aws?ome-?gpt/i.test(value)) return false;
    if (/^(moosl|openai)$/i.test(value)) return false;
    return true;
}
