import { randomUUID } from "node:crypto";

import type { AiTextMessage } from "@/services/api/image";

export type TextTaskStatus = "pending" | "running" | "success" | "error";

export type TextTaskConfig = {
    apiSource?: "system" | "custom";
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "gemini";
    model: string;
    systemPrompt?: string;
};

export type TextTask = {
    id: string;
    userId: string;
    status: TextTaskStatus;
    createdAt: number;
    updatedAt: number;
    config: TextTaskConfig;
    messages: AiTextMessage[];
    result?: { content: string };
    error?: string;
    pointsRemaining?: number;
};

const TASK_TTL_MS = 60 * 60 * 1000;
const TASK_STALE_MS = 3 * 60 * 1000;
const globalTextTaskStore = globalThis as typeof globalThis & { __vozebTextTasks?: Map<string, TextTask> };
const tasks = (globalTextTaskStore.__vozebTextTasks ??= new Map<string, TextTask>());

export function createTextTask(input: Omit<TextTask, "id" | "status" | "createdAt" | "updatedAt">) {
    cleanupTextTasks();
    const now = Date.now();
    const task: TextTask = {
        ...input,
        id: randomUUID(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
    };
    tasks.set(task.id, task);
    return task;
}

export function getTextTask(id: string) {
    cleanupTextTasks();
    markStaleTextTasks();
    return tasks.get(id) || null;
}

export function updateTextTask(id: string, patch: Partial<Pick<TextTask, "status" | "config" | "messages" | "result" | "error" | "pointsRemaining">>) {
    const task = tasks.get(id);
    if (!task) return null;
    const next = { ...task, ...patch, updatedAt: Date.now() };
    tasks.set(id, next);
    return next;
}

function cleanupTextTasks() {
    const expiresBefore = Date.now() - TASK_TTL_MS;
    for (const [id, task] of tasks) {
        if (task.updatedAt < expiresBefore) tasks.delete(id);
    }
}

function markStaleTextTasks() {
    const expiresBefore = Date.now() - TASK_STALE_MS;
    for (const [id, task] of tasks) {
        if ((task.status === "pending" || task.status === "running") && task.updatedAt < expiresBefore) {
            tasks.set(id, {
                ...task,
                status: "error",
                error: "生成任务已中断，请重新生成。",
                messages: [],
                config: { ...task.config, apiKey: "" },
                updatedAt: Date.now(),
            });
        }
    }
}
