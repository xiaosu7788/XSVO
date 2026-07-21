"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import { localForageStorage } from "@/lib/localforage-storage";
import { ensureStoredImage, normalizeImageDataUrl, resolveImageUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export type ImageWorkbenchMode = "gallery" | "agent";
export type ImageWorkbenchSubmitShortcut = "enter" | "ctrl-enter";
export type ImageWorkbenchTaskStatus = "running" | "done" | "error";

export type ImageWorkbenchImage = {
    id: string;
    url: string;
    dataUrl?: string;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
};

export type ImageWorkbenchTask = {
    id: string;
    prompt: string;
    mode: ImageWorkbenchMode;
    status: ImageWorkbenchTaskStatus;
    images: ImageWorkbenchImage[];
    partialImages?: ImageWorkbenchImage[];
    activeImageIndex?: number;
    references?: ReferenceImage[];
    model: string;
    size: string;
    quality: string;
    count: number;
    createdAt: number;
    completedAt: number | null;
    error: string;
    isFavorite?: boolean;
};

export type ImageWorkbenchRound = {
    id: string;
    prompt: string;
    assistant: string;
    taskId?: string;
    status: ImageWorkbenchTaskStatus;
    createdAt: number;
};

export type ImageWorkbenchConversation = {
    id: string;
    title: string;
    rounds: ImageWorkbenchRound[];
    createdAt: number;
    updatedAt: number;
};

type ImageWorkbenchStore = {
    hydrated: boolean;
    mode: ImageWorkbenchMode;
    clearInputAfterSubmit: boolean;
    submitShortcut: ImageWorkbenchSubmitShortcut;
    tasks: ImageWorkbenchTask[];
    conversations: ImageWorkbenchConversation[];
    activeConversationId: string;
    setMode: (mode: ImageWorkbenchMode) => void;
    setClearInputAfterSubmit: (value: boolean) => void;
    setSubmitShortcut: (value: ImageWorkbenchSubmitShortcut) => void;
    addTask: (task: ImageWorkbenchTask) => void;
    updateTask: (id: string, patch: Partial<ImageWorkbenchTask>) => void;
    toggleFavorite: (id: string) => void;
    removeTask: (id: string) => void;
    clearAll: () => void;
    createConversation: () => string;
    setActiveConversation: (id: string) => void;
    renameConversation: (id: string, title: string) => void;
    removeConversation: (id: string) => void;
    addRound: (conversationId: string, round: ImageWorkbenchRound) => void;
    updateRound: (conversationId: string, roundId: string, patch: Partial<ImageWorkbenchRound>) => void;
    hydrateImageUrls: () => Promise<void>;
};

const STORE_KEY = "xsvo:image-workbench";

export const useImageWorkbenchStore = create<ImageWorkbenchStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            mode: "gallery",
            clearInputAfterSubmit: true,
            submitShortcut: "enter",
            tasks: [],
            conversations: [],
            activeConversationId: "",
            setMode: (mode) => set({ mode }),
            setClearInputAfterSubmit: (clearInputAfterSubmit) => set({ clearInputAfterSubmit }),
            setSubmitShortcut: (submitShortcut) => set({ submitShortcut }),
            addTask: (task) => set((state) => ({ tasks: [task, ...state.tasks].slice(0, 120) })),
            updateTask: (id, patch) => set((state) => ({ tasks: state.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) })),
            toggleFavorite: (id) => set((state) => ({ tasks: state.tasks.map((task) => task.id === id ? { ...task, isFavorite: !task.isFavorite } : task) })),
            removeTask: (id) => set((state) => ({
                tasks: state.tasks.filter((task) => task.id !== id),
                conversations: state.conversations.map((conversation) => ({
                    ...conversation,
                    rounds: conversation.rounds.map((round) => round.taskId === id ? { ...round, taskId: undefined } : round),
                })),
            })),
            clearAll: () => set({ tasks: [], conversations: [], activeConversationId: "" }),
            createConversation: () => {
                const now = Date.now();
                const conversation: ImageWorkbenchConversation = { id: nanoid(), title: "???", rounds: [], createdAt: now, updatedAt: now };
                set((state) => ({ conversations: [conversation, ...state.conversations], activeConversationId: conversation.id }));
                return conversation.id;
            },
            setActiveConversation: (id) => set({ activeConversationId: id }),
            renameConversation: (id, title) => set((state) => ({
                conversations: state.conversations.map((conversation) => conversation.id === id ? { ...conversation, title: title.trim() || conversation.title, updatedAt: Date.now() } : conversation),
            })),
            removeConversation: (id) => set((state) => {
                const conversations = state.conversations.filter((conversation) => conversation.id !== id);
                return { conversations, activeConversationId: state.activeConversationId === id ? conversations[0]?.id || "" : state.activeConversationId };
            }),
            addRound: (conversationId, round) => set((state) => ({
                conversations: state.conversations.map((conversation) => conversation.id === conversationId ? {
                    ...conversation,
                    title: conversation.rounds.length ? conversation.title : round.prompt.slice(0, 24) || "???",
                    rounds: [...conversation.rounds, round],
                    updatedAt: Date.now(),
                } : conversation),
            })),
            updateRound: (conversationId, roundId, patch) => set((state) => ({
                conversations: state.conversations.map((conversation) => conversation.id === conversationId ? {
                    ...conversation,
                    rounds: conversation.rounds.map((round) => round.id === roundId ? { ...round, ...patch } : round),
                    updatedAt: Date.now(),
                } : conversation),
            })),
            hydrateImageUrls: async () => {
                const snapshot = get().tasks;
                const hydratedTasks = await Promise.all(snapshot.map(async (task) => {
                    const images = await Promise.all(task.images.map(async (image) => {
                        const normalized = await ensureStoredImage(image);
                        const dataUrl = await normalizeImageDataUrl(normalized);
                        const fallback = dataUrl || normalized.url || normalized.remoteUrl || normalized.serverUrl || "";
                        const url = await resolveImageUrl(normalized.storageKey, fallback);
                        return { ...normalized, dataUrl: dataUrl.startsWith("data:") ? dataUrl : normalized.dataUrl, url };
                    }));
                    const partialImages = await Promise.all((task.partialImages || []).map(async (image) => {
                        const normalized = await ensureStoredImage(image);
                        const dataUrl = await normalizeImageDataUrl(normalized);
                        const fallback = dataUrl || normalized.url || normalized.remoteUrl || normalized.serverUrl || "";
                        const url = await resolveImageUrl(normalized.storageKey, fallback);
                        return { ...normalized, dataUrl: dataUrl.startsWith("data:") ? dataUrl : normalized.dataUrl, url };
                    }));
                    const references = await Promise.all((task.references || []).map(async (reference) => {
                        const dataUrl = await normalizeImageDataUrl(reference);
                        const url = await resolveImageUrl(reference.storageKey, dataUrl || reference.url || reference.remoteUrl || reference.serverUrl || "");
                        return { ...reference, dataUrl: dataUrl.startsWith("data:") ? dataUrl : reference.dataUrl, url, storageKey: reference.storageKey };
                    }));
                    return { id: task.id, images, partialImages, references };
                }));
                set((state) => ({
                    tasks: state.tasks.map((task) => {
                        const hydrated = hydratedTasks.find((item) => item.id === task.id);
                        return hydrated ? { ...task, images: hydrated.images, partialImages: hydrated.partialImages, references: hydrated.references } : task;
                    }),
                }));
            },
        }),
        {
            name: STORE_KEY,
            storage: localForageStorage,
            partialize: (state) => ({ mode: state.mode, clearInputAfterSubmit: state.clearInputAfterSubmit, submitShortcut: state.submitShortcut, tasks: state.tasks, conversations: state.conversations, activeConversationId: state.activeConversationId }),
            onRehydrateStorage: () => () => useImageWorkbenchStore.setState((state) => ({
                hydrated: true,
                tasks: state.tasks.map((task) => task.status === "running" ? { ...task, status: "error", completedAt: Date.now(), error: "页面刷新后任务已中断，请重新提交" } : task),
                conversations: state.conversations.map((conversation) => ({
                    ...conversation,
                    rounds: conversation.rounds.map((round) => round.status === "running" ? { ...round, status: "error", assistant: "本轮 Agent 任务已中断，请重新发送" } : round),
                })),
            })),
        },
    ),
);
