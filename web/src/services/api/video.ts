import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { refreshUserPointsIfSystem, syncUserPointsFromHeaders } from "@/services/api/points";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; error?: { message?: string } };
type ApiVideoResponse = VideoResponse | { code?: number; data?: VideoResponse | null; msg?: string };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; last_frame_url?: string } | null;
};
type ApiEnvelope<T> = T | { code?: number; data?: T | null; msg?: string };
type RequestOptions = { signal?: AbortSignal };
type ResolvedVideoMediaUrl = { url: string; remoteUrl?: string };

export type VideoGenerationResult = { blob?: Blob; url?: string; remoteUrl?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "generation"; model: string; pollPath?: string; resultUrl?: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

const GLOBAL_AIOPC_VIDEO_CREATE_PATH = "/videos/videos";
const GLOBAL_AIOPC_VIDEO_RESULT_PATH = "/result";
const VIDEO_CREATE_PATHS = ["/video/generations", "/videos/generations", GLOBAL_AIOPC_VIDEO_CREATE_PATH];
const VIDEO_URL_KEYS = [
    "video_url",
    "videoUrl",
    "media_url",
    "mediaUrl",
    "play_url",
    "playUrl",
    "stream_url",
    "streamUrl",
    "source_url",
    "sourceUrl",
    "content_url",
    "contentUrl",
    "output_url",
    "outputUrl",
    "download_url",
    "downloadUrl",
    "file_url",
    "fileUrl",
    "asset_url",
    "assetUrl",
    "result_url",
    "resultUrl",
    "src",
    "url",
    "uri",
];
const VIDEO_CONTAINER_KEYS = ["data", "result", "results", "response", "payload", "content", "output", "outputs", "video", "videos", "media", "asset", "assets", "file", "files", "artifact", "artifacts", "items", "task", "job"];
const TASK_ID_KEYS = ["task_id", "taskId", "id", "job_id", "jobId", "request_id", "requestId", "generation_id", "generationId"];
const TASK_STATUS_KEYS = ["status", "state", "task_status", "taskStatus"];
const VIDEO_CREATE_ERROR_PREFIX = "视频任务创建失败：";
const VIDEO_QUERY_ERROR_PREFIX = "视频任务查询失败：";
const VIDEO_STAGE_ERROR_PREFIX = "上游生成阶段失败：";

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    return waitForVideoGenerationTask(config, task, options);
}

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    const delayMs = task.provider === "seedance" ? 5000 : 2500;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") {
            await refreshUserPointsIfSystem(resolveModelRequestConfig(config, task.model).apiSource);
            throw new Error(state.error);
        }
        if (attempt === 119) {
            await refreshUserPointsIfSystem(resolveModelRequestConfig(config, task.model).apiSource);
            throw new Error(`${task.provider === "seedance" ? "Seedance " : ""}视频生成超时，请稍后重试`);
        }
        await delay(delayMs, options?.signal);
    }
    await refreshUserPointsIfSystem(resolveModelRequestConfig(config, task.model).apiSource);
    throw new Error("视频生成超时，请稍后重试");
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    assertVideoConfig(requestConfig, requestConfig.model);
    const protocol = requestConfig.advancedConfig?.protocol === "sub2api" ? "auto" : requestConfig.advancedConfig?.protocol || "auto";
    if (protocol === "seedance" || (protocol === "auto" && isSeedanceVideoConfig(requestConfig))) {
        return createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    }
    if (protocol === "globalaiopc" || protocol === "compatible") {
        return createCompatibleVideoTask(requestConfig, selectedModel, prompt, references, options, videoReferences, audioReferences);
    }
    if (videoReferences.length || audioReferences.length) {
        if (isGlobalAiOpcVideoConfig(requestConfig, selectedModel)) {
            return createCompatibleVideoTask(requestConfig, selectedModel, prompt, references, options, videoReferences, audioReferences);
        }
        throw new Error("当前视频接口不支持参考视频或参考音频，请切换到 Seedance 2.0 / 火山 Agent Plan 模型，或移除参考素材");
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "generation" && task.resultUrl) {
        return { status: "completed", result: await videoResultFromUrl(resolveVideoMediaUrl(requestConfig, task.resultUrl, aiApiUrl(requestConfig, task.pollPath || VIDEO_CREATE_PATHS[0])), options) };
    }
    if (task.provider === "seedance") return pollSeedanceTask(requestConfig, task, options);
    if (task.provider === "generation") return pollCompatibleVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return { ...(await uploadMediaFile(result.blob, "video")), remoteUrl: result.remoteUrl };
    if (result.url) return { url: result.url, remoteUrl: result.remoteUrl || result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
    throw new Error("视频接口没有返回可播放的视频");
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    try {
        const body = new FormData();
        body.append("model", modelOptionName(model));
        body.append("prompt", prompt);
        body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
        if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
        body.append("resolution_name", normalizeVideoResolution(config.vquality));
        body.append("preset", "normal");
        const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
        files.forEach((file) => {
            body.append("input_reference[]", file);
            body.append("input_reference", file);
        });
        const response = await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal });
        syncUserPointsFromHeaders(response.headers, config.apiSource);
        const immediateUrl = findMediaUrl(response.data);
        if (immediateUrl) {
            await refreshUserPointsIfSystem(config.apiSource);
            return { id: `direct:${Date.now()}`, provider: "generation", model, pollPath: "/videos", resultUrl: immediateUrl };
        }
        const created = unwrapVideoResponse(response.data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        await refreshUserPointsIfSystem(config.apiSource);
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        const errorMessage = readAxiosError(error, "视频任务创建失败");
        if (config.advancedConfig?.protocol !== "openai" && shouldFallbackToCompatibleVideo(error, errorMessage)) return createCompatibleVideoTask(config, model, prompt, references, options);
        await refreshUserPointsIfSystem(config.apiSource);
        throw new Error(videoCreationError(errorMessage));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const statusResponse = await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal });
        const video = unwrapVideoResponse(statusResponse.data);
        if (video.status === "completed") {
            const contentUrl = aiApiUrl(config, `/videos/${task.id}/content`);
            const content = await axios.get<Blob>(contentUrl, { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data, remoteUrl: resolveOpenAiContentRemoteUrl(config, contentUrl, readHeader(statusResponse.headers, "x-vozeb-upstream-url")) } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: videoStageError(video.error?.message || "视频生成失败") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(videoQueryError(readAxiosError(error, "视频任务查询失败")));
    }
}

async function createCompatibleVideoTask(
    config: AiConfig,
    model: string,
    prompt: string,
    references: ReferenceImage[],
    options?: RequestOptions,
    videoReferences: ReferenceVideo[] = [],
    audioReferences: ReferenceAudio[] = [],
): Promise<VideoGenerationTask> {
    let lastError = "";
    for (const path of compatibleVideoCreatePaths(config, model)) {
        const payloads = await buildCompatibleVideoPayloadVariants(config, model, prompt, references, path, videoReferences, audioReferences);
        for (const payload of payloads) {
            try {
                const response = await axios.post<ApiEnvelope<Record<string, unknown>>>(aiApiUrl(config, path), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal });
                syncUserPointsFromHeaders(response.headers, config.apiSource);
                const created = unwrapEnvelope(response.data, "视频接口没有返回任务") as Record<string, unknown>;
                if (references.length && readTaskMode(created) === "t2v") {
                    lastError = "video task was created without accepting reference images";
                    continue;
                }
                const id = readTaskId(created);
                const immediateUrl = readConfiguredMediaUrl(config, created) || findMediaUrl(created);
                if (immediateUrl) {
                    await refreshUserPointsIfSystem(config.apiSource);
                    return { id: id || `direct:${Date.now()}`, provider: "generation", model, pollPath: path, resultUrl: immediateUrl };
                }
                if (!id) throw new Error("视频接口没有返回任务 ID");
                await refreshUserPointsIfSystem(config.apiSource);
                return { id, provider: "generation", model, pollPath: path };
            } catch (error) {
                const message = readAxiosError(error, "视频任务创建失败");
                lastError = message;
                if (shouldFallbackToCompatibleVideo(error, message)) break;
                if (shouldRetryCompatibleVideoPayload(error, message)) continue;
                await refreshUserPointsIfSystem(config.apiSource);
                throw new Error(videoCreationError(message));
            }
        }
    }
    await refreshUserPointsIfSystem(config.apiSource);
    throw new Error(videoCreationError(lastError || "视频任务创建失败"));
}

function compatibleVideoCreatePaths(config: AiConfig, model: string) {
    const configuredPath = normalizeAdvancedVideoPath(config.advancedConfig?.createPath);
    const defaultPaths = isGlobalAiOpcVideoConfig(config, model) ? [GLOBAL_AIOPC_VIDEO_CREATE_PATH, ...VIDEO_CREATE_PATHS.filter((path) => path !== GLOBAL_AIOPC_VIDEO_CREATE_PATH)] : VIDEO_CREATE_PATHS;
    return uniqueStrings([configuredPath, ...defaultPaths]);
}

function isGlobalAiOpcVideoConfig(config: AiConfig, model: string) {
    if (config.advancedConfig?.protocol === "globalaiopc") return true;
    if (normalizeAdvancedVideoPath(config.advancedConfig?.createPath).toLowerCase().endsWith(GLOBAL_AIOPC_VIDEO_CREATE_PATH)) return true;
    const baseUrl = config.baseUrl.toLowerCase();
    const modelName = modelOptionName(model).toLowerCase();
    return baseUrl.includes("globalaiopc.com") || baseUrl.includes("aizfw.cn") || baseUrl.includes("kyyreactapiserver") || ["videos", "videos_stable", "videos_stable_fast"].includes(modelName);
}

async function pollCompatibleVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const requestUrls = compatibleVideoPollUrls(config, task);
    let lastError = "";
    for (const requestUrl of requestUrls) {
        try {
            const response = await axios.get<ApiEnvelope<Record<string, unknown>>>(requestUrl, { headers: aiHeaders(config), signal: options?.signal });
            const state = unwrapEnvelope(response.data, "视频接口没有返回任务") as Record<string, unknown>;
            const status = readConfiguredTaskStatus(config, state) || readTaskStatus(state);
            const videoUrl = readConfiguredMediaUrl(config, state) || findMediaUrl(state);
            if (videoUrl && (!status || isCompletedStatus(status) || !isPendingStatus(status))) {
                const resolvedUrl = resolveVideoMediaUrl(config, videoUrl, readHeader(response.headers, "x-vozeb-upstream-url") || requestUrl);
                return { status: "completed", result: await videoResultFromUrl(resolvedUrl, options) };
            }
            if (isCompletedStatus(status)) return { status: "failed", error: videoStageError("视频任务完成但没有返回视频地址") };
            if (isFailedStatus(status)) return { status: "failed", error: videoStageError(readTaskError(state) || "视频生成失败") };
            return { status: "pending" };
        } catch (error) {
            const message = readAxiosError(error, "视频任务查询失败");
            lastError = message;
            if (!shouldFallbackToCompatibleVideo(error, message)) throw new Error(videoQueryError(message));
        }
    }
    throw new Error(videoQueryError(lastError || "视频任务查询失败"));
}

function compatibleVideoPollUrls(config: AiConfig, task: VideoGenerationTask) {
    return compatibleVideoPollPaths(config, task).map((path) => aiApiUrl(config, applyTaskIdToVideoPath(path, task.id)));
}

function compatibleVideoPollPaths(config: AiConfig, task: VideoGenerationTask) {
    const configuredPath = normalizeAdvancedVideoPath(config.advancedConfig?.queryPath);
    const paths = task.pollPath === GLOBAL_AIOPC_VIDEO_CREATE_PATH ? [configuredPath, GLOBAL_AIOPC_VIDEO_RESULT_PATH, task.pollPath, ...VIDEO_CREATE_PATHS] : [configuredPath, task.pollPath || VIDEO_CREATE_PATHS[0], ...VIDEO_CREATE_PATHS];
    return uniqueStrings(paths);
}

function applyTaskIdToVideoPath(path: string, taskId: string) {
    const encodedTaskId = encodeURIComponent(taskId);
    const templated = path.replace(/\{(?:task_id|taskId|id)\}/g, encodedTaskId).replace(/:(?:task_id|taskId|id)\b/g, encodedTaskId);
    if (templated !== path) return templated;
    return `${path.replace(/\/+$/, "")}/${encodedTaskId}`;
}

function normalizeAdvancedVideoPath(value?: string) {
    const path = (value || "").trim();
    if (!path) return "";
    return path.startsWith("/") ? path : `/${path}`;
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality, modelOptionName(model)),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const response = await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal });
        syncUserPointsFromHeaders(response.headers, config.apiSource);
        const created = unwrapSeedanceTask(response.data);
        if (!created.id) throw new Error("Seedance 接口没有返回任务 ID");
        await refreshUserPointsIfSystem(config.apiSource);
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        await refreshUserPointsIfSystem(config.apiSource);
        throw new Error(videoCreationError(readAxiosError(error, "Seedance 任务创建失败")));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const requestUrl = seedanceApiUrl(config, task.id);
        const response = await axios.get<ApiEnvelope<SeedanceTask>>(requestUrl, { headers: aiHeaders(config), signal: options?.signal });
        const state = unwrapSeedanceTask(response.data);
        if (state.status === "succeeded") {
            const url = state.content?.video_url ? resolveVideoMediaUrl(config, state.content.video_url, readHeader(response.headers, "x-vozeb-upstream-url") || requestUrl) : "";
            if (!url) return { status: "failed", error: videoStageError("Seedance 任务成功但没有返回视频 URL") };
            return { status: "completed", result: await videoResultFromUrl(url, options) };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: videoStageError(state.error?.message || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}`) };
        return { status: "pending" };
    } catch (error) {
        throw new Error(videoQueryError(readAxiosError(error, "Seedance 任务查询失败")));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance 参考视频单个时长需要在 2-15 秒之间");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考视频总时长不能超过 15 秒");
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考音频总时长不能超过 15 秒");
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildCompatibleVideoPayloadVariants(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], path: string, videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = []) {
    const qingyanVideoConfig = isQingyanVideoConfig(config, model);
    const publicUrlReferenceMode = shouldUsePublicVideoReferenceUrls(config, path, qingyanVideoConfig);
    const imageSources = await Promise.all(
        references
            .slice(0, 9)
            .map((reference) => (path === GLOBAL_AIOPC_VIDEO_CREATE_PATH ? Promise.resolve(resolveGlobalAiOpcImageSources(reference)) : publicUrlReferenceMode ? resolveQingyanImageSources(reference) : resolveCompatibleImageSources(reference))),
    );
    const images = uniqueStrings(imageSources.flat());
    if (path === GLOBAL_AIOPC_VIDEO_CREATE_PATH && references.length && !images.length) {
        throw new Error("GlobalAiOpc 视频接口的参考图需要公网图片 URL，当前本地参考图无法直接提交给上游");
    }
    if (path !== GLOBAL_AIOPC_VIDEO_CREATE_PATH && publicUrlReferenceMode && references.length && !images.length) {
        throw new Error("\u53c2\u8003\u56fe\u9700\u8981\u516c\u7f51\u56fe\u7247 URL\uff1b\u672c\u5730\u5f00\u53d1 localhost \u4e0d\u80fd\u76f4\u63a5\u63d0\u4ea4\u7ed9\u4e0a\u6e38\uff0c\u8bf7\u90e8\u7f72\u540e\u914d\u7f6e NEXT_PUBLIC_SITE_URL");
    }
    const publicReferenceVideos = uniqueStrings(videoReferences.slice(0, 3).flatMap(resolveGlobalAiOpcMediaReferenceSources));
    const publicReferenceAudios = uniqueStrings(audioReferences.slice(0, 3).flatMap(resolveGlobalAiOpcMediaReferenceSources));
    const referenceVideos = path === GLOBAL_AIOPC_VIDEO_CREATE_PATH ? publicReferenceVideos : [];
    const referenceAudios = path === GLOBAL_AIOPC_VIDEO_CREATE_PATH ? publicReferenceAudios : [];
    if (path === GLOBAL_AIOPC_VIDEO_CREATE_PATH && videoReferences.length && !referenceVideos.length) {
        throw new Error("GlobalAiOpc 视频接口的参考视频需要公网视频 URL，当前本地参考视频无法直接提交给上游");
    }
    if (path === GLOBAL_AIOPC_VIDEO_CREATE_PATH && audioReferences.length && !referenceAudios.length) {
        throw new Error("GlobalAiOpc 视频接口的参考音频需要公网音频 URL，当前本地参考音频无法直接提交给上游");
    }
    const duration = path === GLOBAL_AIOPC_VIDEO_CREATE_PATH ? normalizeGlobalAiOpcVideoDuration(config.videoSeconds) : normalizeCompatibleVideoDuration(config.videoSeconds);
    const ratio = normalizeCompatibleVideoRatio(config.size);
    const quality = normalizeCompatibleVideoQuality(config.vquality);
    const size = normalizeVideoSize(config.size) || "1280x720";
    const dimensions = normalizeCompatibleVideoDimensions(config.size);
    const mediaPayloads = path === GLOBAL_AIOPC_VIDEO_CREATE_PATH ? buildGlobalAiOpcVideoMediaPayloads(images) : qingyanVideoConfig ? buildQingyanVideoMediaPayloads(images) : buildCompatibleVideoMediaPayloads(images);
    const templatePayloads = buildAdvancedVideoTemplatePayloads(config, model, prompt, {
        duration,
        ratio,
        resolution: normalizeVideoResolution(config.vquality),
        quality,
        size,
        width: dimensions.width,
        height: dimensions.height,
        images,
        referenceVideos: publicReferenceVideos,
        referenceAudios: publicReferenceAudios,
    });
    if (path === GLOBAL_AIOPC_VIDEO_CREATE_PATH) {
        const payloads = mediaPayloads.map((mediaPayload) => ({
            model: modelOptionName(model),
            prompt,
            duration,
            ratio,
            resolution: normalizeVideoResolution(config.vquality),
            autoFace: false,
            ...(referenceVideos.length ? { referenceVideos } : {}),
            ...(referenceAudios.length ? { referenceAudios } : {}),
            ...mediaPayload,
        }));
        return uniquePayloads([...templatePayloads, ...payloads]);
    }
    const base = {
        model: modelOptionName(model),
        prompt,
        n: 1,
        size,
        width: dimensions.width,
        height: dimensions.height,
        response_format: "url",
        ratio,
        aspect_ratio: ratio,
        resolution: normalizeVideoResolution(config.vquality),
        quality,
        async: true,
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };
    const payloads = mediaPayloads.flatMap((mediaPayload) => [
        { ...base, ...mediaPayload, duration },
        { ...base, ...mediaPayload, seconds: String(duration), duration },
        { ...base, ...mediaPayload, seconds: String(duration) },
    ]);
    return uniquePayloads([...templatePayloads, ...payloads]);
}

type AdvancedVideoTemplateContext = {
    duration: number;
    ratio: string;
    resolution: string;
    quality: string;
    size: string;
    width: number;
    height: number;
    images: string[];
    referenceVideos: string[];
    referenceAudios: string[];
};

function buildAdvancedVideoTemplatePayloads(config: AiConfig, model: string, prompt: string, context: AdvancedVideoTemplateContext) {
    const template = (config.advancedConfig?.requestTemplate || "").trim();
    if (!template || (!template.startsWith("{") && !template.startsWith("["))) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(template);
    } catch {
        return [];
    }

    const variables: Record<string, unknown> = {
        model: modelOptionName(model),
        prompt,
        duration: context.duration,
        seconds: String(context.duration),
        ratio: context.ratio,
        aspect_ratio: context.ratio,
        resolution: context.resolution,
        quality: context.quality,
        size: context.size,
        width: context.width,
        height: context.height,
        image: context.images[0] || "",
        images: context.images,
        referenceImage: context.images[0] || "",
        referenceImages: context.images,
        referenceVideo: context.referenceVideos[0] || "",
        referenceVideos: context.referenceVideos,
        referenceAudio: context.referenceAudios[0] || "",
        referenceAudios: context.referenceAudios,
    };
    const rendered = renderAdvancedTemplateValue(parsed, variables);
    const payloads = Array.isArray(rendered) ? rendered : [rendered];
    return payloads.filter(isRecord).map((payload) => alignAdvancedVideoPayload(payload, model, prompt, context));
}

function renderAdvancedTemplateValue(value: unknown, variables: Record<string, unknown>): unknown {
    if (typeof value === "string") {
        const exact = value.match(/^{{\s*([a-zA-Z_][\w]*)\s*}}$/);
        if (exact) return variables[exact[1]] ?? "";
        return value.replace(/{{\s*([a-zA-Z_][\w]*)\s*}}/g, (_match, key: string) => templateVariableText(variables[key]));
    }
    if (Array.isArray(value)) return value.map((item) => renderAdvancedTemplateValue(item, variables));
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderAdvancedTemplateValue(item, variables)]));
    }
    return value;
}

function templateVariableText(value: unknown) {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value) || isRecord(value)) return JSON.stringify(value);
    return String(value);
}

function alignAdvancedVideoPayload(payload: Record<string, unknown>, model: string, prompt: string, context: AdvancedVideoTemplateContext) {
    const next = { ...payload };
    if ("model" in next) next.model = modelOptionName(model);
    if ("prompt" in next) next.prompt = prompt;
    if ("duration" in next) next.duration = context.duration;
    if ("seconds" in next) next.seconds = typeof next.seconds === "number" ? context.duration : String(context.duration);
    if ("ratio" in next) next.ratio = context.ratio;
    if ("aspect_ratio" in next) next.aspect_ratio = context.ratio;
    if ("resolution" in next) next.resolution = context.resolution;
    if ("quality" in next) next.quality = context.quality;
    if ("size" in next) next.size = context.size;
    if ("width" in next) next.width = context.width;
    if ("height" in next) next.height = context.height;
    alignSingleReferenceField(next, "image", context.images[0]);
    alignSingleReferenceField(next, "image_url", context.images[0]);
    alignSingleReferenceField(next, "input_image", context.images[0]);
    alignSingleReferenceField(next, "referenceImage", context.images[0]);
    alignSingleReferenceField(next, "reference_image", context.images[0]);
    alignListReferenceField(next, "images", context.images);
    alignListReferenceField(next, "image_urls", context.images);
    alignListReferenceField(next, "input_images", context.images);
    alignListReferenceField(next, "ref_assets", context.images);
    alignListReferenceField(next, "referenceImages", context.images);
    alignListReferenceField(next, "reference_images", context.images);
    alignSingleReferenceField(next, "referenceVideo", context.referenceVideos[0]);
    alignSingleReferenceField(next, "reference_video", context.referenceVideos[0]);
    alignListReferenceField(next, "referenceVideos", context.referenceVideos);
    alignListReferenceField(next, "reference_videos", context.referenceVideos);
    alignSingleReferenceField(next, "referenceAudio", context.referenceAudios[0]);
    alignSingleReferenceField(next, "reference_audio", context.referenceAudios[0]);
    alignListReferenceField(next, "referenceAudios", context.referenceAudios);
    alignListReferenceField(next, "reference_audios", context.referenceAudios);
    return next;
}

function alignSingleReferenceField(payload: Record<string, unknown>, key: string, value?: string) {
    if (!(key in payload)) return;
    if (!shouldAutoAlignReferenceField(payload[key])) return;
    if (value) payload[key] = value;
    else delete payload[key];
}

function alignListReferenceField(payload: Record<string, unknown>, key: string, values: string[]) {
    if (!(key in payload)) return;
    if (!shouldAutoAlignReferenceField(payload[key])) return;
    if (values.length) payload[key] = values;
    else delete payload[key];
}

function shouldAutoAlignReferenceField(value: unknown) {
    if (typeof value === "string") return !value.trim() || value.includes("{{") || value.includes("https://...");
    if (Array.isArray(value)) return !value.length || value.some((item) => typeof item === "string" && (!item.trim() || item.includes("{{") || item.includes("https://...")));
    return false;
}

function uniquePayloads(payloads: Array<Record<string, unknown>>) {
    const seen = new Set<string>();
    return payloads.filter((payload) => {
        const key = JSON.stringify(payload);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function shouldUsePublicVideoReferenceUrls(config: AiConfig, path: string, qingyanVideoConfig: boolean) {
    if (path === GLOBAL_AIOPC_VIDEO_CREATE_PATH || qingyanVideoConfig) return true;
    const rule = (config.advancedConfig?.referenceRule || "").trim().toLowerCase();
    return /\u516c\u7f51|public|next_public_site_url|localhost|must.*\burl\b|\burl\b.*only|\u5fc5\u987b.*\burl\b|\u4ec5.*\burl\b|\u53ea.*\burl\b/i.test(rule);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildCompatibleVideoMediaPayloads(images: string[]) {
    if (!images.length) return [{}];
    const imageObjects = images.map((url) => ({ url }));
    const imageUrlObjects = images.map((url) => ({ image_url: url }));
    return [
        { image: images[0] },
        { images },
        { image: images[0], images, ref_assets: images },
        { ref_assets: images },
        { image: imageObjects[0] },
        { images: imageObjects },
        { image: imageObjects[0], images: imageObjects, ref_assets: imageObjects },
        { ref_assets: imageObjects },
        { image_url: images[0] },
        { image_url: imageObjects[0] },
        { image_urls: images },
        { image_urls: imageObjects },
        { input_image: images[0] },
        { input_image: imageObjects[0] },
        { input_images: images },
        { input_images: imageObjects },
        { input_reference: images },
        { input_reference: imageObjects },
        { input_reference: imageUrlObjects },
        { reference_image: images[0] },
        { reference_image: imageObjects[0] },
        { reference_images: images },
        { reference_images: imageObjects },
        { first_frame_url: images[0] },
        { first_frame_image: images[0] },
        { image: images[0], images: imageObjects, image_urls: images, ref_assets: imageObjects },
        { image: imageObjects[0], images: imageObjects, image_urls: images, ref_assets: imageObjects },
        { image: images[0], images, image_urls: images, ref_assets: images },
    ];
}

function buildGlobalAiOpcVideoMediaPayloads(images: string[]) {
    if (!images.length) return [{}];
    return [{ referenceImages: images }];
}

function buildQingyanVideoMediaPayloads(images: string[]) {
    if (!images.length) return [{}];
    return images.length === 1 ? [{ image: images[0] }] : [{ images }, { image: images[0], images }];
}

async function resolveCompatibleImageSources(image: ReferenceImage) {
    const sources: string[] = [];
    const dataUrl = (await imageToDataUrl(image)).trim();
    sources.push(...compatibleImageSourceCandidates(dataUrl));
    sources.push(...compatibleImageSourceCandidates(image.url));
    sources.push(...compatibleImageSourceCandidates(image.dataUrl));
    return uniqueStrings(sources);
}

async function resolveQingyanImageSources(image: ReferenceImage) {
    const directUrls = uniqueStrings([...externalPublicImageSourceCandidates(image.url), ...externalPublicImageSourceCandidates(image.dataUrl)]);
    if (directUrls.length) return directUrls;

    const dataUrl = (await imageToDataUrl(image)).trim();
    if (!dataUrl || !/^data:image\//i.test(dataUrl)) return [];
    const publishedUrl = await publishReferenceImage(dataUrl);
    return externalPublicImageSourceCandidates(publishedUrl);
}

async function resolveGlobalAiOpcImageSources(image: ReferenceImage) {
    const directUrls = uniqueStrings([...externalPublicImageSourceCandidates(image.url), ...externalPublicImageSourceCandidates(image.dataUrl)]);
    if (directUrls.length) return directUrls;

    const dataUrl = (await imageToDataUrl(image)).trim();
    if (!dataUrl || !/^data:image\//i.test(dataUrl)) return [];
    const publishedUrl = await publishReferenceImage(dataUrl);
    return externalPublicImageSourceCandidates(publishedUrl);
}

function resolveGlobalAiOpcMediaReferenceSources(media: { url?: string }) {
    return externalPublicImageSourceCandidates(media.url);
}

function compatibleImageSourceCandidates(value?: string) {
    const url = (value || "").trim();
    if (!url) return [];
    if (/^data:image\//i.test(url) || isPublicMediaUrl(url)) return [url];
    try {
        const origin = typeof window === "undefined" ? "" : window.location.origin;
        if (!origin) return [];
        const absolute = new URL(url, origin);
        const proxiedUrl = absolute.searchParams.get("url") || "";
        if ((absolute.pathname === "/api/media-proxy" || /^\/api\/ai\/system\/[^/]+\/_media$/.test(absolute.pathname)) && isPublicMediaUrl(proxiedUrl)) return [proxiedUrl];
        if (url.startsWith("/api/generation-log-assets/")) return [absolute.toString()];
    } catch {
        return [];
    }
    return [];
}

function externalPublicImageSourceCandidates(value?: string) {
    const url = (value || "").trim();
    if (!url || /^data:image\//i.test(url)) return [];
    if (isExternalPublicMediaUrl(url)) return [url];
    try {
        const origin = typeof window === "undefined" ? "" : window.location.origin;
        if (!origin) return [];
        const absolute = new URL(url, origin);
        const proxiedUrl = absolute.searchParams.get("url") || "";
        if ((absolute.pathname === "/api/media-proxy" || /^\/api\/ai\/system\/[^/]+\/_media$/.test(absolute.pathname)) && isExternalPublicMediaUrl(proxiedUrl)) return [proxiedUrl];
        if (url.startsWith("/api/generation-log-assets/") && isExternalPublicMediaUrl(absolute.toString())) return [absolute.toString()];
    } catch {
        return [];
    }
    return [];
}

function isQingyanVideoConfig(config: AiConfig, model: string) {
    if (modelOptionName(model).toLowerCase() === "video-v1") return true;
    try {
        return new URL(config.baseUrl, typeof window === "undefined" ? "http://localhost" : window.location.origin).hostname.toLowerCase() === "api2.qingyanzhiying.top";
    } catch {
        return config.baseUrl.toLowerCase().includes("api2.qingyanzhiying.top");
    }
}

async function publishReferenceImage(dataUrl: string) {
    const response = await fetch("/api/reference-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "image", dataUrl }),
    });
    const payload = (await response.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "参考图临时上传失败");
    const url = typeof payload.url === "string" ? payload.url.trim() : "";
    if (!url) throw new Error("参考图临时上传没有返回可用地址");
    return url;
}

function uniqueStrings(items: string[]) {
    return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function normalizeCompatibleVideoDuration(value: string) {
    const seconds = Math.floor(Number(value) || 5);
    if (seconds <= 5) return 5;
    if (seconds <= 10) return 10;
    return 15;
}

function normalizeGlobalAiOpcVideoDuration(value: string) {
    const seconds = Math.floor(Number(value) || 5);
    return Math.max(4, Math.min(15, seconds));
}

function normalizeCompatibleVideoRatio(value: string) {
    if (!value || value === "auto") return "16:9";
    const normalized = normalizeSeedanceRatio(value);
    return normalized === "adaptive" ? "16:9" : normalized;
}

function normalizeCompatibleVideoQuality(value: string) {
    const resolution = normalizeVideoResolution(value);
    return resolution === "1080p" ? "hd" : "standard";
}

function normalizeCompatibleVideoDimensions(value: string) {
    const size = normalizeVideoSize(value) || "1280x720";
    const [width, height] = size.split("x").map((item) => Number(item));
    return { width: Number.isFinite(width) ? width : 1280, height: Number.isFinite(height) ? height : 720 };
}

function shouldFallbackToCompatibleVideo(error: unknown, message: string) {
    if (axios.isCancel(error)) return false;
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 404 || status === 405 || status === 415) return true;
    if (status && status >= 500 && /not found|not implemented|route|endpoint|unsupported|no such|cannot post|invalid url/i.test(message)) return true;
    return /not found|not implemented|route|endpoint|unsupported|no such|cannot post|invalid url|404|base64|参考图|reference image|invalid image/i.test(message);
}

function shouldRetryCompatibleVideoPayload(error: unknown, message: string) {
    if (axios.isCancel(error)) return false;
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status && status >= 500) return /task[_ -]?id is empty|invalid_response|deserialize|unmarshal|invalid type/i.test(message);
    if (status !== 400 && status !== 422) return false;
    return /duration|seconds|duplicate field|unmarshal|invalid type|resolution|quality|size|field|image|images|image_url|input_image|ref_assets|text-to-video|image-to-video|reference image|input image|required image/i.test(message);
}

function readConfiguredMediaUrl(config: AiConfig, record: Record<string, unknown>) {
    const configured = readConfiguredStringValue(record, config.advancedConfig?.resultField, "media");
    return configured && isLikelyVideoUrl(configured) ? configured : "";
}

function readConfiguredTaskStatus(config: AiConfig, record: Record<string, unknown>) {
    return readConfiguredStringValue(record, config.advancedConfig?.statusField, "status").toLowerCase();
}

function readConfiguredStringValue(record: Record<string, unknown>, fieldConfig: string | undefined, mode: "media" | "status") {
    for (const path of configuredFieldPaths(fieldConfig)) {
        const value = valueAtConfiguredPath(record, path);
        const text = configuredValueText(value, mode);
        if (text) return text;
    }
    return "";
}

function configuredFieldPaths(value: string | undefined) {
    return (value || "")
        .split(/\r?\n|,|，|;|；|\s+\|\s+|\s+\/\s+/)
        .map((item) => item.trim())
        .filter((item) => item && !item.startsWith("/") && !item.includes(":task_id") && !item.includes("{task_id}"));
}

function valueAtConfiguredPath(value: unknown, path: string): unknown {
    const parts = path
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .map((item) => item.trim())
        .filter(Boolean);
    let current = value;
    for (const part of parts) {
        if (Array.isArray(current)) {
            const index = Number(part);
            current = Number.isInteger(index) ? current[index] : undefined;
            continue;
        }
        if (!isRecord(current)) return undefined;
        current = current[part] ?? current[Object.keys(current).find((key) => key.toLowerCase() === part.toLowerCase()) || ""];
    }
    return current;
}

function configuredValueText(value: unknown, mode: "media" | "status"): string {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (mode === "media") return findMediaUrl(value);
    if (isRecord(value)) return findStringByKeys(value, TASK_STATUS_KEYS);
    return "";
}

function readTaskId(record: Record<string, unknown>) {
    return findStringByKeys(record, TASK_ID_KEYS);
}

function readTaskStatus(record: Record<string, unknown>) {
    return findStringByKeys(record, TASK_STATUS_KEYS).toLowerCase();
}

function readTaskMode(record: Record<string, unknown>) {
    return findStringByKeys(record, ["mode", "generation_mode", "generationMode", "task_mode", "taskMode"]).toLowerCase();
}

function isCompletedStatus(status: string) {
    return ["completed", "complete", "succeeded", "success", "done", "finished"].includes(status);
}

function isPendingStatus(status: string) {
    return !status || ["pending", "queued", "running", "processing", "in_progress", "created"].includes(status);
}

function isFailedStatus(status: string) {
    return ["failed", "failure", "error", "cancelled", "canceled", "expired"].includes(status);
}

function readTaskError(record: Record<string, unknown>) {
    const direct = findStringByKeys(record, ["msg", "message", "error_message", "errorMessage"]);
    if (direct) return direct;
    const error = record.error;
    if (error && typeof error === "object") return stringValue((error as Record<string, unknown>).message) || stringValue((error as Record<string, unknown>).msg);
    return typeof error === "string" ? error : "";
}

function findMediaUrl(value: unknown, depth = 0): string {
    if (!value || depth > 5) return "";
    if (typeof value === "string") return isLikelyVideoUrl(value) ? value : "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const url = findMediaUrl(item, depth + 1);
            if (url) return url;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of VIDEO_URL_KEYS) {
        const url = stringValue(record[key]);
        if (url) return url;
    }
    for (const key of VIDEO_CONTAINER_KEYS) {
        const url = findMediaUrl(record[key], depth + 1);
        if (url) return url;
    }
    return "";
}

function isLikelyVideoUrl(value: string) {
    return /^https?:\/\//i.test(value) || value.startsWith("/") || /\.(mp4|mov|webm)(\?|#|$)/i.test(value);
}

function resolveVideoMediaUrl(config: AiConfig, value: string, baseUrl: string): ResolvedVideoMediaUrl {
    if (/^(data|blob):/i.test(value)) return { url: value };
    const remoteUrl = resolveGeneratedMediaUrl(value, baseUrl);
    if (!config.baseUrl.startsWith("/api/ai/system/")) return { url: remoteUrl, remoteUrl: remoteVideoSourceUrl(remoteUrl) };
    const proxyBase = config.baseUrl.trim().replace(/\/+$/, "");
    return {
        url: `${proxyBase}/_media?url=${encodeURIComponent(remoteUrl)}`,
        remoteUrl: remoteVideoSourceUrl(remoteUrl),
    };
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function findStringByKeys(value: unknown, keys: string[], depth = 0): string {
    if (!value || depth > 4) return "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findStringByKeys(item, keys, depth + 1);
            if (found) return found;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of keys) {
        const found = stringValue(record[key]);
        if (found) return found;
    }
    for (const key of VIDEO_CONTAINER_KEYS) {
        const found = findStringByKeys(record[key], keys, depth + 1);
        if (found) return found;
    }
    return "";
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL、素材 ID，或本地已保存的视频");
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频必须是公网 URL、素材 ID，或本地已保存的音频");
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(source: string | ResolvedVideoMediaUrl, options?: RequestOptions): Promise<VideoGenerationResult> {
    const sourceUrl = typeof source === "string" ? source : source.url;
    const remoteUrl = remoteVideoSourceUrl(sourceUrl, typeof source === "string" ? undefined : source.remoteUrl);
    const playableUrl = browserReadableMediaUrl(sourceUrl);
    try {
        const response = await axios.get<Blob>(playableUrl, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data, remoteUrl, mimeType: response.data.type || "video/mp4" };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url: playableUrl, remoteUrl, mimeType: "video/mp4" };
    }
}

function resolveOpenAiContentRemoteUrl(config: AiConfig, contentUrl: string, upstreamTaskUrl: string) {
    if (!config.baseUrl.startsWith("/api/ai/system/")) return remoteVideoSourceUrl(contentUrl);
    try {
        const upstreamUrl = new URL(upstreamTaskUrl);
        upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/+$/, "")}/content`;
        upstreamUrl.search = "";
        upstreamUrl.hash = "";
        return remoteVideoSourceUrl(upstreamUrl.toString());
    } catch {
        return undefined;
    }
}

function remoteVideoSourceUrl(value: string, fallback?: string) {
    const proxiedRemoteUrl = proxiedMediaSourceUrl(value);
    if (isPublicMediaUrl(proxiedRemoteUrl)) return proxiedRemoteUrl;
    if (isPublicMediaUrl(fallback || "")) return fallback;
    return isPublicMediaUrl(value) ? value : undefined;
}

function proxiedMediaSourceUrl(value: string) {
    const trimmed = (value || "").trim();
    if (!trimmed) return "";
    try {
        const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.origin;
        const parsed = new URL(trimmed, baseUrl);
        const isMediaProxy = parsed.pathname === "/api/media-proxy" || /^\/api\/ai\/system\/[^/]+\/_media$/.test(parsed.pathname);
        if (!isMediaProxy) return "";
        return parsed.searchParams.get("url") || "";
    } catch {
        return "";
    }
}

function readHeader(headers: unknown, key: string) {
    if (!headers || typeof headers !== "object") return "";
    const getter = (headers as { get?: (name: string) => unknown }).get;
    const value = typeof getter === "function" ? getter.call(headers, key) || getter.call(headers, key.toLowerCase()) : (headers as Record<string, unknown>)[key] || (headers as Record<string, unknown>)[key.toLowerCase()];
    return typeof value === "string" ? value : Array.isArray(value) ? String(value[0] || "") : "";
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 暂不支持视频生成，请使用 OpenAI 兼容渠道");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 5);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, "接口没有返回视频任务");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && typeof payload.code === "number") {
        if (payload.code !== 0) throw new Error(payload.msg || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; message?: string; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.message || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? error.message : fallback;
}

function videoCreationError(message: string) {
    return prefixedVideoError(message, VIDEO_CREATE_ERROR_PREFIX);
}

function videoQueryError(message: string) {
    return prefixedVideoError(message, VIDEO_QUERY_ERROR_PREFIX);
}

function videoStageError(message: string) {
    return prefixedVideoError(message, VIDEO_STAGE_ERROR_PREFIX);
}

function prefixedVideoError(message: string, prefix: string) {
    const cleanMessage = (message || "").trim() || prefix.replace(/：$/, "");
    if (cleanMessage.startsWith(prefix) || cleanMessage.startsWith(prefix.replace(/：$/, ""))) return cleanMessage;
    return `${prefix}${cleanMessage}`;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "视频下载失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function isExternalPublicMediaUrl(value: string) {
    if (!isPublicMediaUrl(value)) return false;
    try {
        const hostname = new URL(value).hostname.toLowerCase();
        return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
    } catch {
        return false;
    }
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取本地素材失败"));
        reader.readAsDataURL(blob);
    });
}
