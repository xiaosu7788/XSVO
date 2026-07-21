"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { App, Button, Empty, Input, InputNumber, Modal, Switch, Tabs } from "antd";
import {
    AlertCircle,
    BookOpen,
    Check,
    Clock3,
    Download,
    Eye,
    FolderOpen,
    ImagePlus,
    ListChecks,
    Maximize2,
    Minimize2,
    Paperclip,
    Pencil,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    Send,
    Settings2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    MessageCircle,
    SquareDashedMousePointer,
    Star,
    Trash2,
    X,
} from "lucide-react";
import { nanoid } from "nanoid";

import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { requestCreditCost, creditCostLabel } from "@/constant/credits";
import { recordGenerationLog } from "@/services/api/generation-logs";
import { requestEdit, requestGeneration, requestToolResponse, type ResponseFunctionTool, type ResponseInputMessage } from "@/services/api/image";
import { ensureStoredImage, normalizeImageDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { formatDuration as formatElapsedDuration } from "@/lib/image-utils";
import { modelOptionLabel, modelOptionName, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useImageWorkbenchStore, type ImageWorkbenchConversation, type ImageWorkbenchImage, type ImageWorkbenchMode, type ImageWorkbenchRound, type ImageWorkbenchSubmitShortcut, type ImageWorkbenchTask } from "@/stores/use-image-workbench-store";
import type { ReferenceImage } from "@/types/image";

type GenerationResult = { id: string; dataUrl: string; remoteUrl?: string; serverUrl?: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string };
type AssetList = ReturnType<typeof useAssetStore.getState>["assets"];
type TaskFilter = "all" | "done" | "running" | "error";

const IMAGE_TOOL: ResponseFunctionTool = {
    type: "function",
    function: {
        name: "generate_image",
        description: "根据用户描述生成图片。只有在用户明确需要图片时调用。",
        parameters: { type: "object", properties: { prompt: { type: "string", description: "完整的图片生成提示词" } }, required: ["prompt"], additionalProperties: false },
        strict: true,
    },
};

export default function NativeImageWorkbench() {
    const { message, modal } = App.useApp();
    const config = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const hydrated = useImageWorkbenchStore((state) => state.hydrated);
    const clearInputAfterSubmit = useImageWorkbenchStore((state) => state.clearInputAfterSubmit);
    const submitShortcut = useImageWorkbenchStore((state) => state.submitShortcut) || "enter";
    const setSubmitShortcut = useImageWorkbenchStore((state) => state.setSubmitShortcut);
    const setClearInputAfterSubmit = useImageWorkbenchStore((state) => state.setClearInputAfterSubmit);
    const tasks = useImageWorkbenchStore((state) => state.tasks);
    const conversations = useImageWorkbenchStore((state) => state.conversations);
    const storedMode = useImageWorkbenchStore((state) => state.mode);
    const storedConversationId = useImageWorkbenchStore((state) => state.activeConversationId);
    const setStoreMode = useImageWorkbenchStore((state) => state.setMode);
    const addTask = useImageWorkbenchStore((state) => state.addTask);
    const toggleFavorite = useImageWorkbenchStore((state) => state.toggleFavorite);
    const updateTask = useImageWorkbenchStore((state) => state.updateTask);
    const removeTask = useImageWorkbenchStore((state) => state.removeTask);
    const createConversation = useImageWorkbenchStore((state) => state.createConversation);
    const setActiveConversation = useImageWorkbenchStore((state) => state.setActiveConversation);
    const renameConversation = useImageWorkbenchStore((state) => state.renameConversation);
    const removeConversation = useImageWorkbenchStore((state) => state.removeConversation);
    const addRound = useImageWorkbenchStore((state) => state.addRound);
    const updateRound = useImageWorkbenchStore((state) => state.updateRound);
    const hydrateImageUrls = useImageWorkbenchStore((state) => state.hydrateImageUrls);
    const [mode, setMode] = useState<ImageWorkbenchMode>(storedMode);
    const [prompt, setPrompt] = useState("");
    const [agentInput, setAgentInput] = useState("");
    const [searchQuery, setSearchQuery] = useState("");
    const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
    const [filterFavorite, setFilterFavorite] = useState(false);
    const [selectedModel, setSelectedModel] = useState(config.imageModel || config.model);
    const [size, setSize] = useState(config.size || "auto");
    const [quality, setQuality] = useState(config.quality || "auto");
    const [format, setFormat] = useState(config.outputFormat || "png");
    const [transparentBackground, setTransparentBackground] = useState(Boolean(config.transparentBackground));
    const [moderation, setModeration] = useState(config.moderation || "auto");
    const [compression, setCompression] = useState(config.outputCompression || "100");
    const [count, setCount] = useState(Math.max(1, Math.min(15, Number(config.count) || 1)));
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [workbenchSettingsOpen, setWorkbenchSettingsOpen] = useState(false);
    const [activeConversationId, setActiveConversationId] = useState(storedConversationId);
    const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
    const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
    const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
    const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
    const requestControllersRef = useRef<Map<string, { mode: ImageWorkbenchMode; controller: AbortController }>>(new Map());
    const galleryRef = useRef<HTMLDivElement>(null);
    const dragSelectionRef = useRef<{ startX: number; startY: number; initial: string[]; active: boolean; startedOnCard: boolean } | null>(null);
    const suppressTaskClickRef = useRef(false);
    const dragScrollIntervalRef = useRef<number | null>(null);
    const dragScrollDirectionRef = useRef<-1 | 1 | null>(null);
    const [optimisticSavedAssets, setOptimisticSavedAssets] = useState<Set<string>>(() => new Set());
    const [savingAssetKeys, setSavingAssetKeys] = useState<Set<string>>(() => new Set());

    useEffect(() => {
        if (hydrated) void hydrateImageUrls();
    }, [hydrateImageUrls, hydrated]);

    useEffect(() => () => {
        for (const request of requestControllersRef.current.values()) request.controller.abort();
        requestControllersRef.current.clear();
        if (dragScrollIntervalRef.current) window.clearInterval(dragScrollIntervalRef.current);
    }, []);

    useEffect(() => {
        if (!hydrated || activeConversationId) return;
        const id = conversations[0]?.id || createConversation();
        setActiveConversationId(id);
        setActiveConversation(id);
    }, [activeConversationId, conversations, createConversation, hydrated, setActiveConversation]);

    useEffect(() => setMode(storedMode), [storedMode]);
    useEffect(() => setSelectedModel(config.imageModel || config.model), [config.imageModel, config.model]);
    useEffect(() => setSize(config.size || "auto"), [config.size]);
    useEffect(() => setQuality(config.quality || "auto"), [config.quality]);
    useEffect(() => setFormat(config.outputFormat || "png"), [config.outputFormat]);
    useEffect(() => setTransparentBackground(Boolean(config.transparentBackground)), [config.transparentBackground]);
    useEffect(() => setModeration(config.moderation || "auto"), [config.moderation]);
    useEffect(() => setCompression(config.outputCompression || "100"), [config.outputCompression]);
    useEffect(() => setCount(Math.max(1, Math.min(15, Number(config.count) || 1))), [config.count]);

    const imageModels = useMemo(() => config.imageModels.length ? config.imageModels : config.models, [config.imageModels, config.models]);
    const composerModelOptions = useMemo(() => imageModels.map((value) => ({ label: modelOptionLabel(config, value), value })), [config, imageModels]);
        const visibleTasks = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return tasks
            .filter((task) => taskFilter === "all" || task.status === taskFilter)
            .filter((task) => !filterFavorite || Boolean(task.isFavorite))
            .filter((task) => !query || `${task.prompt} ${task.model}`.toLowerCase().includes(query))
            .sort((a, b) => b.createdAt - a.createdAt);
    }, [filterFavorite, searchQuery, taskFilter, tasks]);
    const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) || conversations[0];
    const detailTask = detailTaskId ? tasks.find((task) => task.id === detailTaskId) || null : null;
    const switchMode = (nextMode: ImageWorkbenchMode) => {
        setMode(nextMode);
        setStoreMode(nextMode);
        if (!activeConversation && nextMode === "agent") {
            const id = createConversation();
            setActiveConversationId(id);
            setActiveConversation(id);
        }
    };

    const buildConfig = () => ({
        ...config,
        model: selectedModel,
        imageModel: selectedModel,
        size,
        quality,
        count: String(count),
        outputFormat: format,
        transparentBackground,
        moderation,
        outputCompression: compression,
    });

    const persistImages = async (images: ImageWorkbenchImage[]) => {
        return Promise.all(images.map(async (image) => {
            try {
                const stored = await ensureStoredImage(image);
                const dataUrl = await normalizeImageDataUrl(stored);
                return { ...image, ...stored, dataUrl: dataUrl.startsWith("data:") ? dataUrl : stored.dataUrl };
            } catch {
                return image;
            }
        }));
    };

    const saveImageToAssets = async (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => {
        const assetKey = `${task.id}:${image.id}`;
        const existing = assets.find((asset) => asset.kind === "image" && asset.metadata?.taskId === task.id && asset.metadata?.imageId === image.id);
        if (existing) {
            removeAsset(existing.id);
            setOptimisticSavedAssets((current) => new Set([...current].filter((key) => key !== assetKey)));
            message.success("已从素材移除");
            return;
        }
        if (savingAssetKeys.has(assetKey)) return;
        setOptimisticSavedAssets((current) => new Set(current).add(assetKey));
        setSavingAssetKeys((current) => new Set(current).add(assetKey));
        try {
            const stored = await ensureStoredImage(image);
            const dataUrl = await normalizeImageDataUrl(stored);
            addAsset({
                kind: "image",
                title: sanitizePrompt(task.prompt).slice(0, 40) || "图片",
                coverUrl: stored.url || dataUrl,
                tags: ["生图工作台"],
                source: "生图工作台",
                metadata: { taskId: task.id, imageId: image.id },
                data: { dataUrl: dataUrl || stored.url || image.url, storageKey: stored.storageKey, width: stored.width || image.width || 1024, height: stored.height || image.height || 1024, bytes: stored.bytes || image.bytes || 0, mimeType: stored.mimeType || image.mimeType || "image/png" },
            });
            message.success("已加入素材");
        } catch (error) {
            setOptimisticSavedAssets((current) => new Set([...current].filter((key) => key !== assetKey)));
            message.error(error instanceof Error ? error.message : "保存素材失败");
        } finally {
            setSavingAssetKeys((current) => new Set([...current].filter((key) => key !== assetKey)));
        }
    };

    const downloadImage = async (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => {
        try {
            const stored = await ensureStoredImage(image);
            const dataUrl = await normalizeImageDataUrl(stored);
            const response = await fetch(dataUrl || stored.url || image.url);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${sanitizePrompt(task.prompt).slice(0, 28) || "image"}-${image.id.slice(0, 6)}.${stored.mimeType?.includes("jpeg") ? "jpg" : stored.mimeType?.includes("webp") ? "webp" : format}`;
            anchor.click();
            URL.revokeObjectURL(url);
        } catch {
            message.error("下载图片失败");
        }
    };

    const deleteTask = (task: ImageWorkbenchTask) => {
        modal.confirm({
            title: "删除任务",
            content: "删除后不会影响已保存到素材的图片，确定继续吗？",
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => removeTask(task.id),
        });
    };

    const reuseTask = (task: ImageWorkbenchTask) => {
        switchMode("gallery");
        setPrompt(task.prompt);
        setSize(task.size || "auto");
        setQuality(task.quality || "auto");
        setCount(task.count || 1);
    };

    const previewTaskImage = async (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => {
        try {
            const stored = await ensureStoredImage(image);
            const dataUrl = await normalizeImageDataUrl(stored);
            const src = dataUrl || stored.url || stored.serverUrl || stored.remoteUrl || image.serverUrl || image.remoteUrl || image.url || "";
            if (!src) {
                message.warning("这张历史图片没有可用的本地缓存或远程地址");
                return;
            }
            setPreviewImage({ src, alt: sanitizePrompt(task.prompt) || "图片" });
        } catch {
            const src = image.dataUrl || image.serverUrl || image.remoteUrl || image.url || "";
            if (!src) {
                message.warning("这张历史图片没有可用的本地缓存或远程地址");
                return;
            }
            setPreviewImage({ src, alt: sanitizePrompt(task.prompt) || "图片" });
        }
    };

    const runGeneration = async (task: ImageWorkbenchTask, generationPrompt: string, refs: ReferenceImage[], controller: AbortController) => {
        const taskConfig = {
            ...buildConfig(),
            count: String(task.count || count),
            model: task.model || selectedModel,
            imageModel: task.model || selectedModel,
            size: task.size || size,
            quality: task.quality || quality,
        };
        try {
            const result = refs.length
                ? await requestEdit(taskConfig, generationPrompt, refs, undefined, { signal: controller.signal, logSource: "image-workbench", logTitle: generationPrompt.slice(0, 40) })
                : await requestGeneration(taskConfig, generationPrompt, { signal: controller.signal, logSource: "image-workbench", logTitle: generationPrompt.slice(0, 40) });
            const transientImages = (result as GenerationResult[]).map((item) => ({ id: item.id || nanoid(), url: item.dataUrl || item.serverUrl || item.remoteUrl || "", dataUrl: item.dataUrl, remoteUrl: item.remoteUrl, serverUrl: item.serverUrl, storageKey: item.storageKey, width: item.width, height: item.height, bytes: item.bytes, mimeType: item.mimeType } satisfies ImageWorkbenchImage));
            const images = await persistImages(transientImages);
            if (!images.length) throw new Error("图片任务没有返回结果");
            updateTask(task.id, { status: "done", images, activeImageIndex: 0, completedAt: Date.now(), error: "" });
            void recordGenerationLog({ kind: "image", source: "image-workbench", status: "success", title: generationPrompt.slice(0, 40), prompt: generationPrompt, model: modelOptionName(taskConfig.imageModel), count: images.length, successCount: images.length, assets: images.map((image) => ({ type: "image" as const, url: image.serverUrl || image.remoteUrl || "", remoteUrl: image.remoteUrl, serverUrl: image.serverUrl })) });
            return images;
        } catch (error) {
            updateTask(task.id, { status: "error", completedAt: Date.now(), error: error instanceof Error ? error.message : "生成失败" });
            throw error;
        }
    };

    const submitGallery = async () => {
        const text = prompt.trim();
        if (!text) return;
        const generationConfig = buildConfig();
        if (!isConfigReady(generationConfig, selectedModel)) {
            openConfigDialog(true);
            return;
        }
        const refs = references;
        const task: ImageWorkbenchTask = { id: nanoid(), prompt: text, mode: "gallery", status: "running", images: [], references: refs, model: modelOptionName(selectedModel), size, quality, count, createdAt: Date.now(), completedAt: null, error: "", isFavorite: false, activeImageIndex: 0 };
        const controller = new AbortController();
        requestControllersRef.current.set(task.id, { mode: "gallery", controller });
        addTask(task);
        if (clearInputAfterSubmit) {
            setPrompt("");
            setReferences([]);
        }
        try {
            await runGeneration(task, text, refs, controller);
        } catch (error) {
            if (!isAbortError(error)) message.error(error instanceof Error ? error.message : "生成失败");
        } finally {
            requestControllersRef.current.delete(task.id);
        }
    };

    const submitAgent = async () => {
        const text = agentInput.trim();
        if (!text) return;
        const generationConfig = buildConfig();
        if (!isConfigReady(generationConfig, selectedModel)) {
            openConfigDialog(true);
            return;
        }
        const liveStore = useImageWorkbenchStore.getState();
        const conversationId = activeConversationId || liveStore.activeConversationId || activeConversation?.id || createConversation();
        const previousRounds = liveStore.conversations.find((conversation) => conversation.id === conversationId)?.rounds || activeConversation?.rounds || [];
        const round: ImageWorkbenchRound = { id: nanoid(), prompt: text, assistant: "正在理解你的任务…", status: "running", createdAt: Date.now() };
        const controller = new AbortController();
        requestControllersRef.current.set(round.id, { mode: "agent", controller });
        addRound(conversationId, round);
        setActiveConversationId(conversationId);
        setActiveConversation(conversationId);
        const refs = references;
        if (clearInputAfterSubmit) {
            setAgentInput("");
            setReferences([]);
        }
        try {
            let imagePrompt = text;
            try {
                const history: ResponseInputMessage[] = previousRounds.flatMap((item) => [{ role: "user" as const, content: item.prompt }, { role: "assistant" as const, content: sanitizePrompt(item.assistant) }]);
                const textConfig = { ...generationConfig, model: generationConfig.textModel || generationConfig.model };
                const toolResult = await requestToolResponse(textConfig, [...history, { role: "user", content: text }], [IMAGE_TOOL], "required", (value) => updateRound(conversationId, round.id, { assistant: value || "正在理解你的任务…" }), { signal: controller.signal, logSource: "image-workbench", logTitle: text.slice(0, 40) });
                const call = toolResult.toolCalls[0];
                if (call?.function.name === "generate_image") imagePrompt = (JSON.parse(call.function.arguments) as { prompt?: string }).prompt?.trim() || text;
            } catch (error) {
                if (controller.signal.aborted) throw error;
            }
            const task: ImageWorkbenchTask = { id: nanoid(), prompt: sanitizePrompt(imagePrompt), mode: "agent", status: "running", images: [], references: refs, model: modelOptionName(selectedModel), size, quality, count, createdAt: Date.now(), completedAt: null, error: "", isFavorite: false, activeImageIndex: 0 };
            addTask(task);
            updateRound(conversationId, round.id, { taskId: task.id, assistant: "正在生成图片…" });
            const images = await runGeneration(task, sanitizePrompt(imagePrompt), refs, controller);
            updateRound(conversationId, round.id, { status: "done", assistant: `已生成 ${images.length} 张图片。` });
        } catch (error) {
            const textError = error instanceof Error ? error.message : "Agent 任务失败";
            updateRound(conversationId, round.id, { status: "error", assistant: textError });
            if (!isAbortError(error)) message.error(textError);
        } finally {
            requestControllersRef.current.delete(round.id);
        }
    };

    const toggleTaskSelection = (id: string) => {
        setSelectedTaskIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    };

    const clearSelection = () => setSelectedTaskIds([]);

    const selectAllVisible = () => setSelectedTaskIds(visibleTasks.map((task) => task.id));

    const invertVisibleSelection = () => {
        const selected = new Set(selectedTaskIds);
        setSelectedTaskIds(visibleTasks.filter((task) => !selected.has(task.id)).map((task) => task.id));
    };

    const selectedTasks = visibleTasks.filter((task) => selectedTaskIds.includes(task.id));

    const saveSelected = async () => {
        await Promise.all(selectedTasks.flatMap((task) => task.images.slice(0, 1).map((image) => saveImageToAssets(task, image))));
    };

    const downloadSelected = async () => {
        await Promise.all(selectedTasks.flatMap((task) => task.images.slice(0, 1).map((image) => downloadImage(task, image))));
    };

    const deleteSelected = () => {
        modal.confirm({
            title: "批量删除任务",
            content: `确定删除选中的 ${selectedTaskIds.length} 个任务吗？已保存到素材的图片不会受影响。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => {
                selectedTaskIds.forEach((id) => removeTask(id));
                clearSelection();
            },
        });
    };

    const stopDragScroll = () => {
        if (!dragScrollIntervalRef.current) return;
        window.clearInterval(dragScrollIntervalRef.current);
        dragScrollIntervalRef.current = null;
        dragScrollDirectionRef.current = null;
    };

    const retryTask = async (task: ImageWorkbenchTask) => {
        if (task.status !== "error") return;
        const generationConfig = buildConfig();
        if (!isConfigReady(generationConfig, selectedModel)) {
            openConfigDialog(true);
            return;
        }
        const controller = new AbortController();
        requestControllersRef.current.set(task.id, { mode: task.mode, controller });
        updateTask(task.id, { status: "running", error: "", completedAt: null, images: [] });
        try {
            await runGeneration({ ...task, status: "running", error: "", images: [], activeImageIndex: 0 }, sanitizePrompt(task.prompt), task.references || [], controller);
        } catch (error) {
            if (!isAbortError(error)) message.error(error instanceof Error ? error.message : "重试任务失败");
        } finally {
            requestControllersRef.current.delete(task.id);
        }
    };

    const startDragScroll = (direction: -1 | 1) => {
        const surface = galleryRef.current;
        if (!surface) return;
        if (dragScrollIntervalRef.current && dragScrollDirectionRef.current === direction) return;
        stopDragScroll();
        dragScrollDirectionRef.current = direction;
        dragScrollIntervalRef.current = window.setInterval(() => surface.scrollBy({ top: direction * 14, behavior: "auto" }), 16);
    };

    const beginTaskSelection = (event: ReactPointerEvent<HTMLElement>) => {
        if (mode !== "gallery" || event.button !== 0) return;
        const target = event.target as HTMLElement;
        if (target.closest("button, input, textarea, select, [data-no-drag-select], [data-selectable-text]")) return;
        const startedOnCard = Boolean(target.closest("[data-task-card]"));
        if (startedOnCard) return;
        const initial = event.ctrlKey || event.metaKey ? selectedTaskIds : [];
        dragSelectionRef.current = { startX: event.clientX, startY: event.clientY, initial, active: false, startedOnCard };
        window.getSelection()?.removeAllRanges();
        document.body.classList.add("select-none");
        document.body.style.userSelect = "none";
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        event.preventDefault();
    };

    const updateTaskSelection = (event: ReactPointerEvent<HTMLElement>) => {
        const drag = dragSelectionRef.current;
        const surface = galleryRef.current;
        if (!drag || !surface) return;
        const left = Math.min(drag.startX, event.clientX);
        const top = Math.min(drag.startY, event.clientY);
        const width = Math.abs(event.clientX - drag.startX);
        const height = Math.abs(event.clientY - drag.startY);
        if (!drag.active && Math.max(width, height) < 6) return;
        drag.active = true;
        suppressTaskClickRef.current = true;
        setSelectionBox({ left, top, width, height });
        const initial = new Set(drag.initial);
        const selected = new Set(drag.initial);
        surface.querySelectorAll<HTMLElement>("[data-task-card]").forEach((card) => {
            const rect = card.getBoundingClientRect();
            const intersects = left < rect.right && left + width > rect.left && top < rect.bottom && top + height > rect.top;
            const id = card.dataset.taskId;
            if (!id) return;
            if (intersects) {
                if (initial.has(id)) selected.delete(id); else selected.add(id);
            } else if (!initial.has(id)) selected.delete(id);
        });
        setSelectedTaskIds(Array.from(selected));
        const rect = surface.getBoundingClientRect();
        if (event.clientY < rect.top + 42) startDragScroll(-1);
        else if (event.clientY > rect.bottom - 42) startDragScroll(1);
        else stopDragScroll();
        event.preventDefault();
    };

    const endTaskSelection = (event: ReactPointerEvent<HTMLElement>) => {
        const drag = dragSelectionRef.current;
        if (drag && !drag.active && !drag.startedOnCard && !event.ctrlKey && !event.metaKey) clearSelection();
        document.body.classList.remove("select-none");
        document.body.style.userSelect = "";
        stopDragScroll();
        dragSelectionRef.current = null;
        setSelectionBox(null);
        window.setTimeout(() => { suppressTaskClickRef.current = false; }, 0);
    };
    const toggleSelectedFavorites = () => {
        const shouldFavorite = selectedTasks.some((task) => !task.isFavorite);
        selectedTasks.forEach((task) => {
            if (Boolean(task.isFavorite) !== shouldFavorite) toggleFavorite(task.id);
        });
    };
    const insertAsset = (payload: InsertAssetPayload) => {
        if (payload.kind === "text") (mode === "agent" ? setAgentInput : setPrompt)((value) => `${value}${value ? "\\n" : ""}${payload.content}`);
        if (payload.kind === "image") setReferences((current) => [...current, { id: nanoid(), name: payload.title, type: "image", dataUrl: payload.dataUrl, storageKey: payload.storageKey }].slice(0, 4));
        if (payload.kind === "video") message.warning("生图工作台暂不支持视频参考图");
        setAssetPickerOpen(false);
    };

    const uploadReference = async (file: File | string) => {
        try {
            const stored = await uploadImage(file);
            const dataUrl = await normalizeImageDataUrl(stored);
            const name = typeof file === "string" ? "粘贴图片" : file.name;
            const type = typeof file === "string" ? stored.mimeType || "image/png" : file.type || stored.mimeType || "image/png";
            setReferences((current) => [...current, { id: nanoid(), name, type, dataUrl, url: stored.url, storageKey: stored.storageKey }].slice(0, 4));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "参考图读取失败");
        }
    };

    return (
        <div className="native-image-workbench relative flex h-full min-h-0 flex-col bg-background text-foreground">
            <div className="flex min-h-[72px] shrink-0 items-center justify-between gap-4 border-b border-stone-200/80 bg-background px-4 sm:px-6 dark:border-stone-800">
                <div className="flex items-center gap-1 rounded-2xl border border-stone-200 bg-stone-100 p-1 dark:border-stone-800 dark:bg-stone-900">
                    <ModeButton active={mode === "gallery"} onClick={() => switchMode("gallery")} label="画廊" />
                    <ModeButton active={mode === "agent"} onClick={() => switchMode("agent")} label="Agent" />
                </div>
                <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setPromptDialogOpen(true)} className="hidden items-center gap-2 rounded-xl border border-stone-200 bg-background px-3 py-2 text-sm text-stone-700 shadow-sm transition hover:border-stone-300 hover:bg-stone-50 sm:inline-flex dark:border-stone-800 dark:text-stone-200 dark:hover:bg-stone-900" title="查看提示词词库">
                        <BookOpen className="size-4" />
                        查看提示词词库
                    </button>
                    <button type="button" onClick={() => setAssetPickerOpen(true)} className="hidden items-center gap-2 rounded-xl border border-stone-200 bg-background px-3 py-2 text-sm text-stone-700 shadow-sm transition hover:border-stone-300 hover:bg-stone-50 sm:inline-flex dark:border-stone-800 dark:text-stone-200 dark:hover:bg-stone-900" title="查看我的素材">
                        <FolderOpen className="size-4" />
                        查看我的素材
                    </button>
                    <button type="button" className="inline-flex size-10 items-center justify-center rounded-xl text-stone-500 transition hover:bg-stone-100 hover:text-stone-950 dark:hover:bg-stone-900 dark:hover:text-white" title="打开生图设置" aria-label="打开生图设置" onClick={() => setWorkbenchSettingsOpen(true)}><Settings2 className="size-5" /></button>
                </div>
            </div>
            {mode === "gallery" ? (
                <main ref={galleryRef} className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-64 pt-6 sm:px-8" onPointerDown={beginTaskSelection} onPointerMove={updateTaskSelection} onPointerUp={endTaskSelection} onPointerCancel={endTaskSelection}>
                    <div className="mx-auto flex w-full max-w-[1560px] flex-col gap-5">
                        <div className="flex items-center gap-2">
                            <button type="button" onClick={() => setFilterFavorite((value) => !value)} className={`inline-flex size-10 shrink-0 items-center justify-center rounded-xl border transition ${filterFavorite ? "border-amber-300 bg-amber-50 text-amber-500" : "border-stone-200 bg-background text-stone-400 hover:border-stone-400 dark:border-stone-800"}`} title="筛选收藏" aria-label="筛选收藏"><Star className="size-5" fill={filterFavorite ? "currentColor" : "none"} /></button>
                            <WorkbenchSelect value={taskFilter} onChange={(value) => setTaskFilter(value as TaskFilter)} options={[{ label: "全部", value: "all" }, { label: "已完成", value: "done" }, { label: "生成中", value: "running" }, { label: "失败", value: "error" }]} className="w-[112px]" />
                            <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" /><Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索提示词、参数..." className="!h-10 !rounded-xl !pl-10" allowClear /></div>
                            <span className="hidden shrink-0 text-sm text-stone-500 sm:inline">{visibleTasks.length} 个任务</span>
                        </div>
                        {visibleTasks.length ? <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">{visibleTasks.map((task) => <NativeTaskCard key={task.id} task={task} assets={assets} optimisticSavedAssets={optimisticSavedAssets} savingAssetKeys={savingAssetKeys} isSelected={selectedTaskIds.includes(task.id)} onSave={saveImageToAssets} onDownload={downloadImage} onDelete={deleteTask} onReuse={reuseTask} onRetry={retryTask} onToggleFavorite={() => toggleFavorite(task.id)} onToggleSelection={() => toggleTaskSelection(task.id)} onOpenDetail={() => { if (!suppressTaskClickRef.current) setDetailTaskId(task.id); }} />)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filterFavorite || searchQuery || taskFilter !== "all" ? "没有匹配的任务" : "输入提示词开始生成图片"} className="py-24" />}
                    </div>
                    {selectionBox ? <div className="pointer-events-none fixed z-30 rounded-lg border border-blue-400 bg-blue-400/15" style={selectionBox} /> : null}
                </main>
            ) : <AgentPanel conversation={activeConversation} conversations={conversations} activeConversationId={activeConversation?.id || activeConversationId} onSelectConversation={(id) => { setActiveConversationId(id); setActiveConversation(id); }} onRenameConversation={renameConversation} onRemoveConversation={removeConversation} onNewConversation={() => { const id = createConversation(); setActiveConversationId(id); setActiveConversation(id); }} tasks={tasks} assets={assets} optimisticSavedAssets={optimisticSavedAssets} savingAssetKeys={savingAssetKeys} onSave={saveImageToAssets} onDownload={downloadImage} onDelete={deleteTask} onReuse={reuseTask} onRetry={retryTask} onToggleFavorite={(id) => toggleFavorite(id)} onOpenDetail={(task) => setDetailTaskId(task.id)} />}
            {mode === "gallery" && selectedTaskIds.length ? <TaskBatchBar selectedCount={selectedTaskIds.length} onClear={clearSelection} onSelectAll={selectAllVisible} onInvert={invertVisibleSelection} onFavorite={toggleSelectedFavorites} onSave={() => void saveSelected()} onDownload={() => void downloadSelected()} onDelete={deleteSelected} /> : null}
            <WorkbenchComposer mode={mode} submitShortcut={submitShortcut} prompt={mode === "agent" ? agentInput : prompt} setPrompt={mode === "agent" ? setAgentInput : setPrompt} references={references} onRemoveReference={(id) => setReferences((current) => current.filter((item) => item.id !== id))} onClearReferences={() => setReferences([])} onSubmit={mode === "agent" ? submitAgent : submitGallery} onUpload={uploadReference} onOpenPromptDialog={() => setPromptDialogOpen(true)} onOpenAssetPicker={() => setAssetPickerOpen(true)} model={selectedModel} modelOptions={composerModelOptions} onModelChange={setSelectedModel} size={size} onSizeChange={setSize} quality={quality} onQualityChange={setQuality} format={format} onFormatChange={setFormat} transparentBackground={transparentBackground} onTransparentBackgroundChange={setTransparentBackground} moderation={moderation} onModerationChange={setModeration} compression={compression} onCompressionChange={setCompression} count={count} onCountChange={setCount} pointsCost={requestCreditCost({ apiSource: config.apiSource, modelPointCosts: config.modelPointCosts, generationPointMultipliers: config.generationPointMultipliers, kind: "image", model: selectedModel, count, quality })} />
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={(value) => mode === "agent" ? setAgentInput(value) : setPrompt(value)} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={insertAsset} onClose={() => setAssetPickerOpen(false)} />
            <WorkbenchSettingsModal open={workbenchSettingsOpen} config={config} submitShortcut={submitShortcut} clearInputAfterSubmit={clearInputAfterSubmit} onSubmitShortcutChange={setSubmitShortcut} onClearInputAfterSubmitChange={setClearInputAfterSubmit} onClose={() => setWorkbenchSettingsOpen(false)} onUpdate={updateConfig} onClearData={() => { useImageWorkbenchStore.getState().clearAll(); clearSelection(); }} />
            <TaskDetailModal task={detailTask} assets={assets} optimisticSavedAssets={optimisticSavedAssets} savingAssetKeys={savingAssetKeys} onClose={() => setDetailTaskId(null)} onSave={saveImageToAssets} onDownload={downloadImage} onDelete={(task) => { deleteTask(task); setDetailTaskId(null); }} onReuse={(task) => { reuseTask(task); setDetailTaskId(null); }} onToggleFavorite={(task) => toggleFavorite(task.id)} onPreview={previewTaskImage} />
            <TaskImagePreviewModal preview={previewImage} onClose={() => setPreviewImage(null)} />
        </div>
    );
}

function ResilientImage({ image, alt, className, onLoad }: { image: ImageWorkbenchImage | ReferenceImage; alt: string; className?: string; onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void }) {
    const [src, setSrc] = useState(() => imagePreviewUrl(image));
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let cancelled = false;
        const fallback = imagePreviewUrl(image);
        setSrc(fallback);
        setFailed(false);
        if (image.storageKey) {
            void resolveImageUrl(image.storageKey, fallback).then((resolved) => {
                if (!cancelled && resolved) setSrc(resolved);
            });
        }
        return () => { cancelled = true; };
    }, [image.dataUrl, image.url, image.serverUrl, image.remoteUrl, image.storageKey]);
    return failed || !src ? <div className={`flex items-center justify-center bg-stone-100 text-xs text-stone-400 dark:bg-stone-900 ${className || ""}`}>图片不可用</div> : <img src={src} alt={alt} className={className} onLoad={onLoad} onError={() => {
        const next = [image.dataUrl, image.serverUrl, image.remoteUrl, image.url].find((value) => value && value !== src && !String(value).startsWith("blob:")) || "";
        if (next) setSrc(next); else if (image.storageKey) void resolveImageUrl(image.storageKey, next).then((resolved) => resolved ? setSrc(resolved) : setFailed(true)); else setFailed(true);
    }} />;
}
function ModeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
    return <button type="button" onClick={onClick} className={`rounded-lg px-4 py-1.5 text-sm transition ${active ? "bg-white font-medium text-stone-950 shadow-sm dark:bg-stone-800 dark:text-white" : "text-stone-500 hover:text-stone-950 dark:hover:text-white"}`}>{label}</button>;
}

function NativeTaskCard({ task, assets, optimisticSavedAssets, savingAssetKeys, isSelected = false, compact = false, onSave, onDownload, onDelete, onReuse, onRetry, onToggleFavorite, onToggleSelection, onOpenDetail }: { task: ImageWorkbenchTask; assets: AssetList; optimisticSavedAssets: Set<string>; savingAssetKeys: Set<string>; isSelected?: boolean; compact?: boolean; onSave: (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => Promise<void>; onDownload: (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => Promise<void>; onDelete: (task: ImageWorkbenchTask) => void; onReuse: (task: ImageWorkbenchTask) => void; onRetry: (task: ImageWorkbenchTask) => void; onToggleFavorite: () => void; onToggleSelection?: () => void; onOpenDetail?: () => void }) {
    const [dimensions, setDimensions] = useState("");
    const image = task.status === "running" && task.partialImages?.[0] ? task.partialImages[0] : task.images[0];
    const prompt = sanitizePrompt(task.prompt) || "（无提示词）";
    const assetKey = image ? `${task.id}:${image.id}` : "";
    const savedAsset = Boolean(image && (optimisticSavedAssets.has(assetKey) || assets.some((asset) => asset.kind === "image" && asset.metadata?.taskId === task.id && asset.metadata?.imageId === image.id)));
    const actionClass = "inline-flex size-8 items-center justify-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-950 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-stone-800 dark:hover:text-white";
    const actionClick = (event: ReactMouseEvent<HTMLButtonElement>, action: () => void) => {
        event.preventDefault();
        event.stopPropagation();
        action();
    };

    const doneImage = task.images[task.activeImageIndex || 0] || task.images[0] || task.partialImages?.[0];
    const visibleImage = task.status === "running" && task.partialImages?.[0] ? task.partialImages[0] : doneImage;
    const detailLabel = task.completedAt ? formatTime(task.completedAt) : formatTime(task.createdAt);
    const isDone = task.status === "done" && !task.error;
    const isError = task.status === "error" || (!isDone && Boolean(task.error));

    return <article data-task-card data-task-id={task.id} onClick={(event) => { if (onToggleSelection && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); onToggleSelection(); return; } if ((event.target as HTMLElement).closest("button, input, textarea, select, [data-no-drag-select]")) return; onOpenDetail?.(); }} className={`relative select-none overflow-hidden rounded-2xl border bg-card shadow-sm transition-shadow hover:shadow-md ${compact ? "max-w-[300px]" : ""} ${isSelected ? "border-blue-400 ring-2 ring-blue-400/25" : task.status === "running" ? "border-blue-300 dark:border-blue-500/50" : "border-stone-200 dark:border-stone-800"}`}>
        {isSelected ? <button type="button" data-no-drag-select onClick={(event) => { event.stopPropagation(); onToggleSelection?.(); }} className="absolute right-3 top-3 z-10 inline-flex size-7 items-center justify-center rounded-full bg-blue-500 text-white shadow-sm" aria-label="取消选择"><Check className="size-4" /></button> : null}
        <div className={`flex min-w-0 ${compact ? "h-[144px]" : "h-[184px]"}`}>
            <div className={`relative flex w-[42%] shrink-0 items-center justify-center overflow-hidden bg-stone-100 dark:bg-stone-900 ${compact ? "min-w-[108px] max-w-[128px]" : "min-w-[132px] max-w-[164px]"}`}>
                {task.status === "running" ? <div className="flex flex-col items-center gap-2 text-xs text-stone-400"><RefreshCw className="size-7 animate-spin text-blue-400" /><span>生成中...</span></div> : isError ? <div className="flex flex-col items-center gap-1 px-3 text-center"><AlertCircle className="size-8 text-red-400" /><span className="text-xs text-red-400">失败</span></div> : visibleImage ? <ResilientImage image={visibleImage} alt="" className="h-full w-full object-cover" onLoad={(event) => { const { naturalWidth, naturalHeight } = event.currentTarget; if (naturalWidth && naturalHeight) setDimensions(`${naturalWidth}×${naturalHeight}`); }} /> : <ImagePlus className="size-8 text-stone-300" />}
                <div className="absolute left-2 top-2 flex items-center gap-1 text-[11px] font-medium text-white"><span className="rounded bg-black/55 px-1.5 py-0.5 backdrop-blur-sm">{task.size || "1:1"}</span>{task.status === "done" && <span className="rounded bg-black/55 px-1.5 py-0.5 backdrop-blur-sm">{dimensions || task.size || "auto"}</span>}{task.status === "running" && task.partialImages?.length ? <span className="rounded bg-black/55 px-1.5 py-0.5 backdrop-blur-sm">{task.partialImages.length} 张</span> : null}</div>
                {task.images.length > 1 ? <span className="absolute bottom-2 right-2 rounded bg-black/55 px-1.5 py-0.5 text-[11px] text-white">{task.images.length}</span> : null}
            </div>
            <div className={`flex min-w-0 flex-1 flex-col ${compact ? "p-2.5" : "p-3.5"}`}>
                <div className="min-h-0 flex-1 overflow-hidden"><p className="line-clamp-3 text-[15px] leading-6 text-stone-700 dark:text-stone-200">{prompt}</p></div>
                <div className="mt-3 flex min-w-0 items-center gap-1.5 border-b border-stone-100 pb-2.5 dark:border-stone-800"><span className="inline-flex max-w-[52%] min-w-0 items-center gap-1 truncate rounded-md bg-stone-100 px-2 py-1 text-xs text-stone-500 dark:bg-stone-800 dark:text-stone-300"><span className="text-[10px] text-stone-400">&lt;/&gt;</span>{task.model || "默认"}</span><span className="shrink-0 rounded-md bg-stone-100 px-2 py-1 text-xs text-stone-500 dark:bg-stone-800 dark:text-stone-300">{task.size || "auto"}</span>{isDone ? <span className="ml-auto shrink-0 text-xs text-stone-400">{detailLabel}</span> : isError ? <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-red-400"><AlertCircle className="size-3" />失败</span> : <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-stone-400"><Clock3 className="size-3" />进行中</span>}</div>
                <div className="flex h-9 items-end justify-end"><div className="flex items-center gap-1">
                    <button type="button" onClick={(event) => actionClick(event, onToggleFavorite)} className={`${actionClass} ${task.isFavorite ? "text-amber-500 hover:text-amber-500" : ""}`} title={task.isFavorite ? "取消收藏" : "收藏任务"} aria-label={task.isFavorite ? "取消收藏" : "收藏任务"}><Star className="size-[18px]" fill={task.isFavorite ? "currentColor" : "none"} /></button>
                    <button type="button" disabled={!image || savingAssetKeys.has(assetKey)} onClick={(event) => actionClick(event, () => { if (image) void onSave(task, image); })} className={`${actionClass} ${savedAsset ? "bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100 hover:bg-emerald-100 hover:text-emerald-600 dark:bg-emerald-950/40" : "hover:text-emerald-600"}`} title={savingAssetKeys.has(assetKey) ? "正在保存素材" : savedAsset ? "从素材移除" : "加入素材"} aria-label={savedAsset ? "从素材移除" : "加入素材"}>{savingAssetKeys.has(assetKey) ? <RefreshCw className="size-[18px] animate-spin" /> : savedAsset ? <Check className="size-[18px]" strokeWidth={3} /> : <Plus className="size-[18px]" />}</button>
                    <button type="button" disabled={!image} onClick={(event) => actionClick(event, () => { if (image) void onDownload(task, image); })} className={actionClass} title="下载图片" aria-label="下载图片"><Download className="size-[18px]" /></button>
                    {task.status === "error" ? <button type="button" onClick={(event) => actionClick(event, () => onRetry(task))} className={actionClass} title="重试任务" aria-label="重试任务"><RotateCcw className="size-[18px]" /></button> : null}
                    <button type="button" onClick={(event) => actionClick(event, () => onReuse(task))} className={actionClass} title="复用提示词" aria-label="复用提示词"><Pencil className="size-[18px]" /></button>
                    <button type="button" onClick={(event) => actionClick(event, () => onDelete(task))} className={`${actionClass} hover:text-red-500`} title="删除任务" aria-label="删除任务"><Trash2 className="size-[18px]" /></button>
                </div></div>
            </div>
        </div>
    </article>;
}

function AgentPanel({ conversation, conversations, activeConversationId, tasks, assets, optimisticSavedAssets, savingAssetKeys, onSave, onDownload, onDelete, onReuse, onRetry, onToggleFavorite, onNewConversation, onSelectConversation, onRenameConversation, onRemoveConversation, onOpenDetail }: { conversation?: ImageWorkbenchConversation; conversations: ImageWorkbenchConversation[]; activeConversationId: string; tasks: ImageWorkbenchTask[]; assets: AssetList; optimisticSavedAssets: Set<string>; savingAssetKeys: Set<string>; onSave: (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => Promise<void>; onDownload: (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => Promise<void>; onDelete: (task: ImageWorkbenchTask) => void; onReuse: (task: ImageWorkbenchTask) => void; onRetry: (task: ImageWorkbenchTask) => void; onToggleFavorite: (id: string) => void; onNewConversation: () => void; onSelectConversation: (id: string) => void; onRenameConversation: (id: string, title: string) => void; onRemoveConversation: (id: string) => void; onOpenDetail: (task: ImageWorkbenchTask) => void }) {
    const [historyOpen, setHistoryOpen] = useState(false);
    const [keyword, setKeyword] = useState("");
    const filtered = conversations.filter((item) => !keyword.trim() || item.title.toLowerCase().includes(keyword.trim().toLowerCase()) || item.rounds.some((round) => round.prompt.toLowerCase().includes(keyword.trim().toLowerCase())));
    const rename = (item: ImageWorkbenchConversation) => {
        const title = window.prompt("重命名对话", item.title);
        if (title !== null) onRenameConversation(item.id, title);
    };
    const remove = (item: ImageWorkbenchConversation) => {
        if (window.confirm(`确定删除「${item.title || "新对话"}」吗？`)) onRemoveConversation(item.id);
    };

    return <main className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-56 pt-6 sm:px-8">
        <div className="mx-auto flex min-h-full max-w-4xl flex-col">
            <div className="mb-6 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setHistoryOpen((value) => !value)} className="image-tip inline-flex size-10 items-center justify-center rounded-xl border border-stone-200 bg-white text-stone-600 shadow-sm transition hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300" data-tip="历史对话"><Clock3 className="size-4" /></button>
                    <button type="button" onClick={onNewConversation} className="image-tip inline-flex size-10 items-center justify-center rounded-xl border border-stone-200 bg-white text-stone-600 shadow-sm transition hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300" data-tip="新对话"><Pencil className="size-4" /></button>
                </div>
                <h2 className="min-w-0 flex-1 truncate text-center text-base font-semibold">{conversation?.title || "新对话"}</h2>
                <div className="w-20" />
            </div>
            {historyOpen ? <div className="absolute left-6 top-5 z-30 w-[420px] max-w-[calc(100vw-3rem)] rounded-2xl border border-stone-200 bg-white shadow-[0_22px_70px_rgba(28,25,23,0.18)] dark:border-stone-800 dark:bg-stone-950">
                <div className="flex items-center gap-2 border-b border-stone-100 p-3 dark:border-stone-800"><Search className="size-4 text-stone-400" /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索聊天..." className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none" /><button type="button" onClick={() => setHistoryOpen(false)} className="inline-flex size-8 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"><X className="size-4" /></button></div>
                <div className="max-h-[340px] overflow-y-auto p-3">
                    {filtered.length ? filtered.map((item) => <div key={item.id} className={`group flex items-center gap-3 rounded-xl px-3 py-3 transition ${item.id === activeConversationId ? "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-200" : "hover:bg-stone-50 dark:hover:bg-stone-900"}`}>
                        <button type="button" onClick={() => { onSelectConversation(item.id); setHistoryOpen(false); }} className="flex min-w-0 flex-1 items-center gap-3 text-left"><MessageCircle className="size-4 shrink-0 text-stone-400" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{item.title || "新对话"}</span><span className="mt-0.5 block text-xs text-stone-400">{formatTime(item.updatedAt)}</span></span></button>
                        <button type="button" onClick={() => rename(item)} className="inline-flex size-7 items-center justify-center rounded-lg text-stone-400 opacity-0 transition hover:bg-white hover:text-stone-700 group-hover:opacity-100 dark:hover:bg-stone-800"><Pencil className="size-3.5" /></button>
                        <button type="button" onClick={() => remove(item)} className="inline-flex size-7 items-center justify-center rounded-lg text-stone-400 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"><Trash2 className="size-3.5" /></button>
                    </div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无对话" className="py-10" />}
                </div>
            </div> : null}
            {conversation?.rounds.length ? <div className="space-y-5">{conversation.rounds.map((round) => <AgentRoundView key={round.id} round={round} tasks={tasks} assets={assets} optimisticSavedAssets={optimisticSavedAssets} savingAssetKeys={savingAssetKeys} onSave={onSave} onDownload={onDownload} onDelete={onDelete} onReuse={onReuse} onRetry={onRetry} onToggleFavorite={onToggleFavorite} onOpenDetail={onOpenDetail} />)}</div> : <div className="flex flex-1 items-center justify-center text-center"><div><p className="text-base font-medium text-stone-400">开始新的 Agent 对话</p><p className="mt-2 text-sm text-stone-400">在下方输入框发送消息即可创建第一轮对话。</p></div></div>}
        </div>
    </main>;
}

function AgentRoundView({ round, tasks, assets, optimisticSavedAssets, savingAssetKeys, onSave, onDownload, onDelete, onReuse, onRetry, onToggleFavorite, onOpenDetail }: { round: ImageWorkbenchRound; tasks: ImageWorkbenchTask[]; assets: AssetList; optimisticSavedAssets: Set<string>; savingAssetKeys: Set<string>; onSave: (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => Promise<void>; onDownload: (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => Promise<void>; onDelete: (task: ImageWorkbenchTask) => void; onReuse: (task: ImageWorkbenchTask) => void; onRetry: (task: ImageWorkbenchTask) => void; onToggleFavorite: (id: string) => void; onOpenDetail: (task: ImageWorkbenchTask) => void }) {
    const task = round.taskId ? tasks.find((item) => item.id === round.taskId) : undefined;
    return <div className="space-y-3"><div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-stone-100 px-4 py-3 text-sm leading-6 dark:bg-stone-900">{sanitizePrompt(round.prompt)}</div><div className="max-w-[92%] rounded-2xl rounded-tl-sm border border-stone-200 bg-card px-4 py-3 text-sm leading-6 dark:border-stone-800"><div className="mb-2 font-medium text-blue-600 dark:text-blue-400">Agent</div><div className="whitespace-pre-wrap">{sanitizePrompt(round.assistant)}</div>{task ? <div className="mt-3 max-w-[270px]"><NativeTaskCard task={task} compact assets={assets} optimisticSavedAssets={optimisticSavedAssets} savingAssetKeys={savingAssetKeys} onSave={onSave} onDownload={onDownload} onDelete={onDelete} onReuse={onReuse} onRetry={onRetry} onToggleFavorite={() => onToggleFavorite(task.id)} onOpenDetail={() => onOpenDetail(task)} /></div> : null}</div></div>;
}

function WorkbenchComposer({ mode, submitShortcut, prompt, setPrompt, references, onRemoveReference, onClearReferences, onSubmit, onUpload, onOpenPromptDialog, onOpenAssetPicker, model, modelOptions, onModelChange, size, onSizeChange, quality, onQualityChange, format, onFormatChange, transparentBackground, onTransparentBackgroundChange, moderation, onModerationChange, compression, onCompressionChange, count, onCountChange, pointsCost }: { mode: ImageWorkbenchMode; submitShortcut: ImageWorkbenchSubmitShortcut; prompt: string; setPrompt: (value: string) => void; references: ReferenceImage[]; onRemoveReference: (id: string) => void; onClearReferences: () => void; onSubmit: () => void; onUpload: (file: File | string) => void; onOpenPromptDialog: () => void; onOpenAssetPicker: () => void; model: string; modelOptions: Array<{ label: string; value: string }>; onModelChange: (value: string) => void; size: string; onSizeChange: (value: string) => void; quality: string; onQualityChange: (value: string) => void; format: string; onFormatChange: (value: string) => void; transparentBackground: boolean; onTransparentBackgroundChange: (value: boolean) => void; moderation: string; onModerationChange: (value: string) => void; compression: string; onCompressionChange: (value: string) => void; count: number; onCountChange: (value: number) => void; pointsCost: number }) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [expanded, setExpanded] = useState(false);
    const clearReferences = () => onClearReferences();
    const handleReferenceFiles = (files: File[]) => {
        const imageFiles = files.filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return false;
        imageFiles.slice(0, Math.max(0, 4 - references.length)).forEach((file) => void onUpload(file));
        return true;
    };
    const handlePaste = (event: ReactClipboardEvent<HTMLElement>) => {
        if (handleReferenceFiles(Array.from(event.clipboardData.files || []))) {
            event.preventDefault();
            return;
        }
        const raw = event.clipboardData.getData("text/plain").trim();
        if (/^(data:image\/|https?:\/\/)/i.test(raw) && references.length < 4) {
            event.preventDefault();
            void onUpload(raw);
        }
    };
    const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
        if (handleReferenceFiles(Array.from(event.dataTransfer.files || []))) event.preventDefault();
    };
    const submit = () => onSubmit();
    return (
        <div className="image-workbench-composer pointer-events-none absolute bottom-4 left-1/2 z-20 w-[calc(100%-2rem)] -translate-x-1/2 px-0 sm:bottom-6">
            <div className="pointer-events-auto rounded-[22px] border border-stone-200 bg-white/96 p-3 shadow-[0_18px_54px_rgba(28,25,23,0.12)] backdrop-blur-xl dark:border-stone-800 dark:bg-stone-900/95" onPaste={handlePaste} onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
                {references.length ? <div className="mb-2 flex items-center gap-2 overflow-x-auto pb-1 pl-1">
                    {references.map((reference, index) => <div key={reference.id} className="group relative size-16 shrink-0 rounded-2xl border border-stone-200 bg-stone-100 shadow-sm dark:border-stone-700">
                        <div className="h-full w-full overflow-hidden rounded-2xl"><ResilientImage image={reference} alt="" className="h-full w-full object-cover transition group-hover:brightness-75" /></div>
                        <span className="absolute bottom-1 left-1 inline-flex size-5 items-center justify-center rounded-full bg-black/55 text-[11px] font-medium text-white">{index + 1}</span>
                        <button type="button" onClick={() => onRemoveReference(reference.id)} className="absolute -right-1 -top-1 inline-flex size-6 items-center justify-center rounded-full bg-red-500 text-white opacity-0 shadow-sm transition group-hover:opacity-100" aria-label="移除参考图"><X className="size-3.5" /></button>
                    </div>)}
                    <button type="button" onClick={clearReferences} className="flex size-16 shrink-0 flex-col items-center justify-center rounded-2xl border border-dashed border-stone-200 text-[11px] text-stone-400 transition hover:border-red-200 hover:bg-red-50 hover:text-red-500 dark:border-stone-700 dark:hover:bg-red-950/20"><Trash2 className="mb-1 size-4" />清空</button>
                </div> : null}
                <div className="relative">
                    <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} onPressEnter={(event) => { if (submitShortcut === "enter" ? !event.shiftKey : event.ctrlKey || event.metaKey) { event.preventDefault(); submit(); } }} placeholder={mode === "agent" ? "告诉 Agent 你想生成什么图片..." : "描述你想生成的图片，可输入 @ 来指定参考图..."} autoSize={{ minRows: expanded ? 4 : 1, maxRows: expanded ? 8 : 2 }} className="!min-h-[38px] !rounded-2xl !border-stone-200 !bg-white !px-4 !py-2 !pr-20 dark:!border-stone-700 dark:!bg-stone-950/40" />
                    <div className="image-workbench-input-actions absolute right-3 top-2.5 z-10 flex items-center gap-1">
                        <button type="button" onClick={() => setExpanded((value) => !value)} className="image-tip inline-flex size-6 items-center justify-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800" data-tip={expanded ? "收起输入框" : "展开输入框"} aria-label={expanded ? "收起输入框" : "展开输入框"}>{expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
                        {prompt ? <button type="button" onClick={() => setPrompt("")} className="image-tip inline-flex size-6 items-center justify-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800" data-tip="清空输入" aria-label="清空输入"><X className="size-4" /></button> : null}
                    </div>
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                    <button type="button" onClick={() => fileInputRef.current?.click()} className="image-tip inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-700 transition hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300" data-tip="粘贴/上传参考图" aria-label="上传参考图"><Paperclip className="size-[17px]" /></button>
                    <div className="ml-auto flex min-w-0 items-center gap-2"><span className="shrink-0 text-sm text-stone-500 dark:text-stone-400">模型</span><WorkbenchSelect value={model} onChange={onModelChange} options={modelOptions} className="w-[260px] max-w-[42vw]" placement="top" /><span className="hidden shrink-0 rounded-full bg-stone-50 px-2.5 py-2 text-xs text-stone-500 sm:inline-flex dark:bg-stone-800 dark:text-stone-300">预计 {creditCostLabel(pointsCost)}</span></div>
                </div>
                <div className="composer-row mt-2 grid composer-control-grid items-end gap-1.5 border-t border-stone-100 pt-2 dark:border-stone-800">
                    <ComposerSelect label="尺寸" value={size} onChange={onSizeChange} options={["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "1024x1024"].map((value) => ({ label: value, value }))} />
                    <ComposerSelect label="质量" value={quality} onChange={onQualityChange} options={["auto", "low", "medium", "high"].map((value) => ({ label: value, value }))} />
                    <ComposerSelect label="格式" value={format} onChange={(value) => { const next = value as "png" | "jpeg" | "webp"; onFormatChange(next); if (next !== "png") onTransparentBackgroundChange(false); }} options={[{ label: "PNG", value: "png" }, { label: "JPEG", value: "jpeg" }, { label: "WebP", value: "webp" }]} />
                    {format === "png" ? <ComposerSelect label="透明背景" value={transparentBackground ? "true" : "false"} onChange={(value) => onTransparentBackgroundChange(value === "true")} options={[{ label: "false", value: "false" }, { label: "true", value: "true" }]} /> : <label className="flex min-w-0 flex-col gap-1"><span className="px-1 text-[11px] text-stone-400">压缩率</span><input value={compression} onChange={(event) => onCompressionChange(event.target.value)} className="h-9 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm text-stone-700 outline-none transition focus:border-blue-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200" type="number" min="0" max="100" /></label>}
                    <ComposerSelect label="审核" value={moderation} onChange={onModerationChange} options={[{ label: "auto", value: "auto" }, { label: "low", value: "low" }, { label: "off", value: "off" }]} />
                    <ComposerSelect label="数量" value={String(count)} onChange={(value) => onCountChange(Number(value))} options={[1, 2, 3, 4].map((value) => ({ label: String(value), value: String(value) }))} />
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUpload(file); event.target.value = ""; }} />
                    <button type="button" onClick={submit} className="image-tip inline-flex size-10 shrink-0 items-center justify-center self-end justify-self-end rounded-xl bg-blue-500 p-0 text-white shadow-sm transition hover:bg-blue-600 hover:shadow [&_svg]:text-white" data-tip="发送任务" aria-label="发送任务"><Send className="size-5 text-white" /></button>
                </div>
            </div>
        </div>
    );
}

function WorkbenchSelect({ value, onChange, options, className = "", placement = "bottom" }: { value: string; onChange: (value: string) => void; options: Array<{ label: string; value: string }>; className?: string; placement?: "top" | "bottom" }) {
    const [open, setOpen] = useState(false);
    const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const selected = options.find((option) => option.value === value) || options[0];

    const updateMenuPosition = () => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return;
        const minWidth = Math.max(rect.width, 112);
        const expectedWidth = Math.min(Math.max(minWidth, 180), 336);
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - expectedWidth - 8));
        setMenuStyle({
            left,
            minWidth,
            width: expectedWidth,
            maxWidth: "min(336px, calc(100vw - 16px))",
            top: placement === "top" ? rect.top - 6 : rect.bottom + 6,
            transform: placement === "top" ? "translateY(-100%)" : undefined,
        });
    };

    useEffect(() => {
        if (!open) return;
        const close = (event: MouseEvent) => {
            const target = event.target as Node;
            if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
        };
        updateMenuPosition();
        window.addEventListener("resize", updateMenuPosition);
        window.addEventListener("scroll", updateMenuPosition, true);
        document.addEventListener("mousedown", close);
        return () => {
            window.removeEventListener("resize", updateMenuPosition);
            window.removeEventListener("scroll", updateMenuPosition, true);
            document.removeEventListener("mousedown", close);
        };
    }, [open, placement]);

    const menu = open && menuStyle ? createPortal(
        <div ref={menuRef} className="image-workbench-select-menu" data-no-drag-select data-placement={placement} style={menuStyle}>
            {options.map((option) => (
                <button key={option.value} type="button" className={`image-workbench-select-option ${option.value === value ? "is-selected" : ""}`} onClick={() => { onChange(option.value); setOpen(false); }}>
                    <span className="truncate">{option.label}</span>
                </button>
            ))}
        </div>,
        document.body,
    ) : null;

    return <div ref={rootRef} className={`image-workbench-select relative ${className}`} data-no-drag-select>
        <button type="button" className="image-workbench-select-trigger" onClick={(event) => { event.preventDefault(); setOpen((current) => !current); if (!open) requestAnimationFrame(updateMenuPosition); }}>
            <span className="image-workbench-select-label truncate">{selected?.label || value}</span>
            <ChevronDown className={`image-workbench-select-chevron size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {menu}
    </div>;
}

function ComposerSelect({ label, value, onChange, options, className = "" }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ label: string; value: string }>; className?: string }) {
    return <label className={`flex flex-col gap-1 ${className}`}><span className="px-1 text-[11px] text-stone-400">{label}</span><WorkbenchSelect value={value} onChange={onChange} options={options} placement="top" /></label>;
}

function TaskBatchBar({ selectedCount, onClear, onSelectAll, onInvert, onFavorite, onSave, onDownload, onDelete }: { selectedCount: number; onClear: () => void; onSelectAll: () => void; onInvert: () => void; onFavorite: () => void; onSave: () => void; onDownload: () => void; onDelete: () => void }) {
    const button = "inline-flex size-9 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-white";
    return <div className="pointer-events-auto absolute bottom-[246px] left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border border-stone-200 bg-white/95 p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.14)] backdrop-blur-xl dark:border-stone-700 dark:bg-stone-900/95">
        <button type="button" className={button} onClick={onClear} title="取消选择" aria-label="取消选择"><X className="size-5" /></button>
        <span className="px-1 text-xs font-medium text-stone-500">{selectedCount}</span>
        <span className="mx-1 h-5 w-px bg-stone-200 dark:bg-stone-700" />
        <button type="button" className={`${button} text-blue-500`} onClick={onSelectAll} title="全选任务" aria-label="全选任务"><ListChecks className="size-5" /></button>
        <button type="button" className={`${button} text-violet-500`} onClick={onInvert} title="反选任务" aria-label="反选任务"><SquareDashedMousePointer className="size-5" /></button>
        <button type="button" className={`${button} text-amber-500`} onClick={onFavorite} title="编辑收藏" aria-label="编辑收藏"><Star className="size-5" /></button>
        <button type="button" className={`${button} text-emerald-500`} onClick={onSave} title="加入素材" aria-label="加入素材"><Plus className="size-5" /></button>
        <button type="button" className={`${button} text-emerald-500`} onClick={onDownload} title="下载选中" aria-label="下载选中"><Download className="size-5" /></button>
        <span className="mx-1 h-5 w-px bg-stone-200 dark:bg-stone-700" />
        <button type="button" className={`${button} text-red-500`} onClick={onDelete} title="删除选中" aria-label="删除选中"><Trash2 className="size-5" /></button>
    </div>;
}

function imagePreviewUrl(image?: ImageWorkbenchImage | ReferenceImage) {
    if (!image) return "";
    const dataUrl = (image.dataUrl || "").trim();
    if (dataUrl.startsWith("data:")) return dataUrl;
    return image.url || image.serverUrl || image.remoteUrl || dataUrl || "";
}

function TaskDetailModal({ task, assets, optimisticSavedAssets, savingAssetKeys, onClose, onSave, onDownload, onDelete, onReuse, onToggleFavorite, onPreview }: { task: ImageWorkbenchTask | null; assets: AssetList; optimisticSavedAssets: Set<string>; savingAssetKeys: Set<string>; onClose: () => void; onSave: (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => Promise<void>; onDownload: (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => Promise<void>; onDelete: (task: ImageWorkbenchTask) => void; onReuse: (task: ImageWorkbenchTask) => void; onToggleFavorite: (task: ImageWorkbenchTask) => void; onPreview: (task: ImageWorkbenchTask, image: ImageWorkbenchImage) => Promise<void> }) {
    const [imageIndex, setImageIndex] = useState(0);
    useEffect(() => setImageIndex(0), [task?.id]);
    if (!task) return null;
    const images = task.images.length ? task.images : task.partialImages?.length ? task.partialImages : [];
    const safeImageIndex = Math.min(imageIndex, Math.max(0, images.length - 1));
    const image = images[safeImageIndex] || images[0];
    const assetKey = image ? `${task.id}:${image.id}` : "";
    const saved = Boolean(image && (optimisticSavedAssets.has(assetKey) || assets.some((item) => item.kind === "image" && item.metadata?.taskId === task.id && item.metadata?.imageId === image.id)));
    const saving = Boolean(assetKey && savingAssetKeys.has(assetKey));
    const duration = task.status === "running" ? formatDuration(task.createdAt) : formatDuration(task.createdAt, task.completedAt);
    const statusLabel = task.status === "done" ? "已完成" : task.status === "error" ? "失败" : "生成中";
    const totalImages = Math.max(task.count || 1, images.length || 0);

    return (
        <Modal open onCancel={onClose} footer={null} width="min(860px, calc(100vw - 28px))" centered closeIcon={null} className="image-workbench-detail-modal" styles={{ body: { padding: 0 } }}>
            <div className="grid max-h-[min(560px,calc(100vh-72px))] min-h-[430px] overflow-hidden rounded-[22px] bg-white md:grid-cols-[minmax(0,1fr)_300px] dark:bg-stone-950">
                <div className="flex min-h-[320px] flex-col gap-3 bg-stone-100 p-4 dark:bg-stone-900">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1 text-[12px] font-medium text-white">
                            <span className="rounded bg-black/50 px-2 py-1 backdrop-blur-sm">{task.size || "1:1"}</span>
                            {image ? <span className="rounded bg-black/50 px-2 py-1 backdrop-blur-sm">{image.width && image.height ? `${image.width}×${image.height}` : task.size || "auto"}</span> : null}
                        </div>
                        <span className={`rounded-full px-2.5 py-1 text-xs shadow-sm ${task.status === "error" ? "bg-red-50 text-red-500" : task.status === "running" ? "bg-blue-50 text-blue-500" : "bg-white/85 text-stone-500"}`}>{statusLabel}</span>
                    </div>
                    {image ? (
                        <button type="button" onClick={() => void onPreview(task, image)} className="group relative flex min-h-[250px] flex-1 items-center justify-center rounded-2xl bg-white/65 p-3 outline-none transition hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-blue-400 dark:bg-stone-800/45">
                            <ResilientImage image={image} alt={sanitizePrompt(task.prompt)} className="max-h-[340px] max-w-full rounded-xl object-contain transition group-hover:brightness-95" />
                            <span className="pointer-events-none absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/92 px-3 py-1.5 text-xs text-stone-600 opacity-0 shadow-sm backdrop-blur transition group-hover:opacity-100"><Eye className="size-3.5" />点击预览</span>
                        </button>
                    ) : task.status === "running" ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-sm text-stone-400"><RefreshCw className="size-9 animate-spin text-blue-400" /><span>生成中...</span></div>
                    ) : (
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl bg-white/55 px-5 text-center text-sm text-red-400"><AlertCircle className="size-10" /><span>{task.error || "图片不可用"}</span></div>
                    )}
                    {image ? <div className="flex items-center justify-center gap-2"><button type="button" onClick={() => void onDownload(task, image)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-3.5 text-xs font-medium text-stone-600 shadow-sm ring-1 ring-stone-200 transition hover:bg-stone-50 hover:text-stone-900"><Download className="size-3.5" />下载</button><button type="button" onClick={() => void onSave(task, image)} disabled={saving} className={`inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-3.5 text-xs font-medium shadow-sm ring-1 transition disabled:opacity-60 ${saved ? "text-emerald-600 ring-emerald-200 hover:bg-emerald-50" : "text-stone-600 ring-stone-200 hover:bg-stone-50 hover:text-emerald-600 hover:ring-stone-300"}`}>{saving ? <RefreshCw className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}{saving ? "保存中" : saved ? "已加入素材" : "加入素材"}</button></div> : null}
                    {totalImages > 1 ? <div className="flex items-center justify-center gap-2"><button type="button" onClick={() => setImageIndex((value) => Math.max(0, value - 1))} disabled={safeImageIndex === 0} className="inline-flex size-8 items-center justify-center rounded-full bg-black/30 text-white transition hover:bg-black/45 disabled:opacity-30"><ChevronLeft className="size-4" /></button><div className="rounded-full bg-black/45 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">{images.length ? `${safeImageIndex + 1} / ${totalImages}` : `0 / ${totalImages}`}</div><button type="button" onClick={() => setImageIndex((value) => Math.min(Math.max(images.length - 1, 0), value + 1))} disabled={!images.length || safeImageIndex >= images.length - 1} className="inline-flex size-8 items-center justify-center rounded-full bg-black/30 text-white transition hover:bg-black/45 disabled:opacity-30"><ChevronRight className="size-4" /></button></div> : null}
                </div>
                <div className="flex min-h-0 flex-col overflow-y-auto border-l border-stone-100 bg-white p-5 dark:border-stone-800 dark:bg-stone-950">
                    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium text-stone-400">输入内容</p><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-stone-800 dark:text-stone-100">{sanitizePrompt(task.prompt) || "图片"}</p></div><button type="button" onClick={onClose} className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800"><X className="size-5" /></button></div>
                    {task.references?.length ? <div className="mt-5"><p className="text-xs font-medium text-stone-400">参考图</p><div className="mt-3 flex flex-wrap gap-2">{task.references.map((reference) => <ResilientImage key={reference.id} image={reference} alt="" className="size-14 rounded-lg border border-stone-200 object-cover dark:border-stone-700" />)}</div></div> : null}
                    <div className="mt-5"><p className="text-xs font-medium text-stone-400">参数配置</p><div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 text-sm"><DetailValue label="来源" value={`OpenAI · ${task.model || "默认"}`} /><DetailValue label="尺寸" value={task.size || "auto"} /><DetailValue label="质量" value={task.quality || "auto"} /><DetailValue label="数量" value={String(task.count || 1)} /><DetailValue label="状态" value={statusLabel} /><DetailValue label="生成总耗时" value={duration || "-"} /><DetailValue label="创建时间" value={formatTime(task.createdAt)} /><DetailValue label="完成时间" value={task.completedAt ? formatTime(task.completedAt) : "-"} /></div></div>
                    {task.error ? <div className="mt-4 rounded-xl border border-red-100 bg-red-50 p-3 text-xs leading-5 text-red-600 dark:border-red-900/50 dark:bg-red-950/30">{task.error}</div> : null}
                    <div className="mt-auto flex flex-wrap gap-2 border-t border-stone-100 pt-3 dark:border-stone-800"><button type="button" onClick={() => onReuse(task)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-blue-50 px-3 text-xs font-medium text-blue-600 transition hover:bg-blue-100"><RotateCcw className="size-3.5" />复用配置</button><button type="button" onClick={() => onDelete(task)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-red-50 px-3 text-xs font-medium text-red-500 transition hover:bg-red-100"><Trash2 className="size-3.5" />删除任务</button><button type="button" onClick={() => onToggleFavorite(task)} className={`ml-auto inline-flex size-9 items-center justify-center rounded-full transition ${task.isFavorite ? "bg-amber-50 text-amber-500" : "bg-white text-stone-400 ring-1 ring-stone-200 hover:text-stone-700"}`} aria-label={task.isFavorite ? "取消收藏" : "收藏任务"}><Star className="size-4" fill={task.isFavorite ? "currentColor" : "none"} /></button></div>
                </div>
            </div>
        </Modal>
    );
}

function DetailValue({ label, value }: { label: string; value: string }) {
    return <div className="min-w-0"><p className="mb-1 text-stone-400">{label}</p><p className="truncate text-stone-700 dark:text-stone-200" title={value}>{value}</p></div>;
}

function TaskImagePreviewModal({ preview, onClose }: { preview: { src: string; alt: string } | null; onClose: () => void }) {
    if (!preview) return null;
    return <Modal open onCancel={onClose} footer={null} centered width="fit-content" closeIcon={null} className="image-workbench-preview-modal" styles={{ body: { padding: 0 } }}>
        <div className="relative flex max-h-[calc(100vh-56px)] max-w-[calc(100vw-56px)] items-center justify-center overflow-visible bg-transparent p-0">
            <button type="button" onClick={onClose} className="absolute -right-3 -top-3 z-10 inline-flex size-9 items-center justify-center rounded-full bg-white/95 text-stone-500 shadow-lg ring-1 ring-stone-200 transition hover:bg-white hover:text-stone-900" aria-label="关闭预览"><X className="size-5" /></button>
            <img src={preview.src} alt={preview.alt} className="max-h-[calc(100vh-56px)] max-w-[calc(100vw-56px)] object-contain" />
        </div>
    </Modal>;
}

function WorkbenchSettingsModal({ open, config, submitShortcut, clearInputAfterSubmit, onSubmitShortcutChange, onClearInputAfterSubmitChange, onClose, onUpdate, onClearData }: { open: boolean; config: AiConfig; submitShortcut: ImageWorkbenchSubmitShortcut; clearInputAfterSubmit: boolean; onSubmitShortcutChange: (value: ImageWorkbenchSubmitShortcut) => void; onClearInputAfterSubmitChange: (value: boolean) => void; onClose: () => void; onUpdate: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void; onClearData: () => void }) {
    const [tab, setTab] = useState("api");
    const imageModelOptions = (config.imageModels.length ? config.imageModels : config.models).map((value) => ({ label: modelOptionLabel(config, value), value }));
    const textModelOptions = (config.textModels.length ? config.textModels : config.models).map((value) => ({ label: modelOptionLabel(config, value), value }));
    return <Modal open={open} onCancel={onClose} footer={null} width="min(820px, calc(100vw - 40px))" centered title={<div className="flex items-center gap-2"><Settings2 className="size-5 text-blue-500" />设置 <span className="ml-auto mr-8 font-mono text-xs text-stone-400">v0.7.0</span></div>} className="image-workbench-settings-modal" styles={{ body: { padding: 0, height: "min(560px, calc(100vh - 112px))", overflow: "hidden" } }}>
        <div className="flex h-full min-h-0 flex-col sm:flex-row">
            <Tabs activeKey={tab} onChange={setTab} tabPosition="left" className="settings-tabs w-full sm:w-[144px]" items={[{ key: "api", label: "API 配置" }, { key: "habit", label: "习惯配置" }, { key: "agent", label: "Agent 配置" }, { key: "data", label: "数据管理" }, { key: "about", label: "关于" }]} />
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto border-l border-stone-100 p-5 dark:border-stone-800 sm:p-7">
                {tab === "api" ? <div className="space-y-5">
                    <SettingsField label="API 接口" hint="支持 Images API (/v1/images) 或 Responses API (/v1/responses)。"><WorkbenchSelect value={config.apiMode} onChange={(value) => onUpdate("apiMode", value as AiConfig["apiMode"])} options={[{ label: "Images API (/v1/images)", value: "images" }, { label: "Responses API (/v1/responses)", value: "responses" }]} /></SettingsField>
                    <SettingsField label="默认生图模型"><WorkbenchSelect value={config.imageModel || config.model} onChange={(value) => onUpdate("imageModel", value)} options={imageModelOptions} /></SettingsField>
                    <SettingsField label="Agent 文本模型" hint="Agent 会用它理解你的多轮描述，再调用生图模型。"><WorkbenchSelect value={config.agentTextModel || config.textModel} onChange={(value) => onUpdate("agentTextModel", value)} options={textModelOptions} /></SettingsField>
                    <SettingsToggle label="流式传输" checked={config.streamImages} onChange={(value) => onUpdate("streamImages", value)} hint="开启后按流式请求处理响应。" />
                    <SettingsField label="请求中间步骤图像数" hint="对应 partial_images 参数，建议设置为 1-3。"><InputNumber min={0} max={3} value={config.streamPartialImages} onChange={(value) => onUpdate("streamPartialImages", Number(value) || 0)} className="w-full" /></SettingsField>
                    <SettingsToggle label="返回 Base64 图片数据" checked={config.responseFormatB64Json} onChange={(value) => onUpdate("responseFormatB64Json", value)} hint="开启后直接返回 Base64，避免 URL 过期后无法预览。" />
                    <SettingsToggle label="Codex CLI 兼容模式" checked={config.codexCli} onChange={(value) => onUpdate("codexCli", value)} hint="开启后使用 Codex CLI 兼容参数。" />
                    <SettingsField label="请求超时（秒）"><InputNumber min={30} max={3600} value={config.requestTimeout} onChange={(value) => onUpdate("requestTimeout", Number(value) || 600)} className="w-full" /></SettingsField>
                </div> : null}
                {tab === "habit" ? <div className="space-y-5">
                    <SettingsField label="发送快捷键" hint="Enter 发送、Shift + Enter 换行；或使用 Ctrl / Command + Enter 发送。"><WorkbenchSelect value={submitShortcut} onChange={(value) => onSubmitShortcutChange(value as ImageWorkbenchSubmitShortcut)} options={[{ label: "Enter", value: "enter" }, { label: "Ctrl / Command + Enter", value: "ctrl-enter" }]} /></SettingsField>
                    <SettingsToggle label="发送后清空输入" checked={clearInputAfterSubmit} onChange={onClearInputAfterSubmitChange} hint="发送后自动清空输入框和参考图。" />
                    <SettingsToggle label="任务完成通知" checked={config.taskCompletionNotification} onChange={(value) => onUpdate("taskCompletionNotification", value)} hint="开启后按流式请求处理响应。" />
                    <div className="grid gap-4 sm:grid-cols-2"><SettingsField label="默认尺寸"><WorkbenchSelect value={config.size} onChange={(value) => onUpdate("size", value)} options={["auto", "1:1", "16:9", "9:16", "4:3", "3:4"].map((value) => ({ label: value, value }))} /></SettingsField><SettingsField label="默认质量"><WorkbenchSelect value={config.quality} onChange={(value) => onUpdate("quality", value)} options={["auto", "low", "medium", "high"].map((value) => ({ label: value, value }))} /></SettingsField></div>
                    <div className="grid gap-4 sm:grid-cols-2"><SettingsField label="默认格式"><WorkbenchSelect value={config.outputFormat} onChange={(value) => onUpdate("outputFormat", value as AiConfig["outputFormat"])} options={[{ label: "PNG", value: "png" }, { label: "JPEG", value: "jpeg" }, { label: "WebP", value: "webp" }]} /></SettingsField><SettingsField label="默认数量"><InputNumber min={1} max={15} value={Number(config.count)} onChange={(value) => onUpdate("count", String(value || 1))} className="w-full" /></SettingsField></div>
                    <SettingsToggle label="透明背景" checked={config.transparentBackground} onChange={(value) => onUpdate("transparentBackground", value)} hint="仅 PNG 格式可使用透明背景。" />
                </div> : null}
                {tab === "agent" ? <div className="space-y-5"><SettingsField label="Agent 模式"><WorkbenchSelect value={config.agentApiMode} onChange={(value) => onUpdate("agentApiMode", value as AiConfig["agentApiMode"])} options={[{ label: "关闭", value: "off" }, { label: "原生", value: "native" }, { label: "混合", value: "hybrid" }]} /></SettingsField><SettingsToggle label="Agent 自动滚动" checked={config.agentAutoScroll} onChange={(value) => onUpdate("agentAutoScroll", value)} /><SettingsToggle label="Agent 网络搜索" checked={config.agentWebSearch} onChange={(value) => onUpdate("agentWebSearch", value)} /><SettingsField label="最大工具调用轮数"><InputNumber min={1} max={50} value={config.agentMaxToolRounds} onChange={(value) => onUpdate("agentMaxToolRounds", Number(value) || 15)} className="w-full" /></SettingsField></div> : null}
                {tab === "data" ? <div className="space-y-4"><p className="text-sm leading-6 text-stone-500" >当前生图工作台数据保存在浏览器本地。</p><div className="rounded-xl border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40"><p className="font-medium text-stone-800 dark:text-stone-100" >本地数据</p><p className="mt-1 text-xs leading-5 text-stone-500">任务、参考图、Agent 对话和素材状态会使用本地存储保存。</p></div><div className="flex items-center justify-between rounded-xl border border-red-100 bg-red-50/60 p-4 dark:border-red-900/40 dark:bg-red-950/20"><div><p className="font-medium text-red-700 dark:text-red-300" >清空工作台数据</p><p className="mt-1 text-xs text-red-600/70 dark:text-red-300/70">清空所有任务和 Agent 对话。</p></div><Button danger onClick={onClearData}>清空</Button></div></div> : null}
                {tab === "about" ? <div className="space-y-3 text-sm text-stone-500"><p className="text-base font-semibold text-stone-800 dark:text-stone-100" >XSVO 生图工作台</p><p>原生实现的 GPT Image Playground 风格工作台。</p></div> : null}
            </div>
        </div>
    </Modal>;
}

function SettingsField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return <label className="block space-y-1.5"><span className="text-sm font-medium text-stone-700 dark:text-stone-200">{label}</span>{children}{hint ? <span className="block text-xs leading-5 text-stone-400">{hint}</span> : null}</label>;
}

function SettingsToggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
    return <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium text-stone-700 dark:text-stone-200">{label}</p>{hint ? <p className="mt-1 text-xs leading-5 text-stone-400">{hint}</p> : null}</div><Switch checked={checked} onChange={onChange} /></div>;
}
function sanitizePrompt(value: string) {
    return value.replace(/&lt;\/?(?:ref|removed_ref)\b[^&]*?\/?&gt;/gi, " ").replace(/<\/?(?:ref|removed_ref)\b[^>]*>/gi, " ").replace(/\s{2,}/g, " ").trim();
}

function formatTime(value: number) {
    return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(startedAt: number, endedAt?: number | null) {
    const endAt = endedAt || Date.now();
    if (!startedAt || endAt < startedAt) return "";
    return formatElapsedDuration(endAt - startedAt);
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && /取消|中止|aborted/i.test(error.message);
}
