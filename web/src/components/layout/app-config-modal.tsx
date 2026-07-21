"use client";

import { App, Button, Form, Input, Modal, Progress, Segmented, Select, Tabs } from "antd";
import { Bot, CircleAlert, Cloud, Database, Info, KeyRound, Plus, RefreshCw, Trash2, Wifi } from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";

import { ModelPicker } from "@/components/model-picker";
import { fetchChannelModels } from "@/services/api/image";
import { syncAppDataToWebdav, type AppSyncDomainKey, type AppSyncProgressEvent } from "@/services/app-sync";
import { useImageWorkbenchStore } from "@/stores/use-image-workbench-store";
import { testWebdavConnection, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import {
    encodeChannelModel,
    filterModelsByCapability,
    modelOptionLabel,
    modelOptionsFromChannels,
    normalizeGenerationConcurrency,
    normalizeModelOptionValue,
    defaultWebdavSyncConfig,
    useConfigStore,
    type AiConfig,
    type GenerationConcurrencySettings,
    type ModelCapability,
    type ModelChannel,
} from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    modelsKey: "imageModels" | "videoModels" | "textModels" | "audioModels";
    defaultLabel: string;
    optionsLabel: string;
};

type WebdavDomainProgress = {
    label: string;
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

type PublicSystemSettings = {
    allowUserApiConfig: boolean;
    modelPointCosts: Record<string, number>;
    generationConcurrency: GenerationConcurrencySettings;
    defaultModels: {
        imageModel: string;
        videoModel: string;
        textModel: string;
        audioModel: string;
    };
    systemChannels: Array<ModelChannel & { enabled: boolean; hasApiKey: boolean }>;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", modelsKey: "imageModels", defaultLabel: "默认生图模型", optionsLabel: "生图模型可选项" },
    { capability: "video", modelKey: "videoModel", modelsKey: "videoModels", defaultLabel: "默认视频模型", optionsLabel: "视频模型可选项" },
    { capability: "text", modelKey: "textModel", modelsKey: "textModels", defaultLabel: "默认文本模型", optionsLabel: "文本模型可选项" },
    { capability: "audio", modelKey: "audioModel", modelsKey: "audioModels", defaultLabel: "默认音频模型", optionsLabel: "音频模型可选项" },
];

const webdavDomainKeys: AppSyncDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench"];
const webdavDomainLabels: Record<AppSyncDomainKey, string> = {
    canvas: "画布",
    assets: "我的素材",
    "image-workbench": "生图工作台",
    "video-workbench": "视频创作台",
};

function createWebdavDomainProgress(): Record<AppSyncDomainKey, WebdavDomainProgress> {
    return webdavDomainKeys.reduce(
        (progress, key) => ({
            ...progress,
            [key]: { label: webdavDomainLabels[key], stage: "等待同步" },
        }),
        {} as Record<AppSyncDomainKey, WebdavDomainProgress>,
    );
}

export function AppConfigModal() {
    const { message } = App.useApp();
    const [activeTab, setActiveTab] = useState("api");
    const [loadingChannelId, setLoadingChannelId] = useState("");
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const [webdavSyncStatus, setWebdavSyncStatus] = useState("");
    const [webdavDomainProgress, setWebdavDomainProgress] = useState(createWebdavDomainProgress);
    const [systemSettings, setSystemSettings] = useState<PublicSystemSettings | null>(null);
    const customConfigRef = useRef<AiConfig | null>(null);
    const config = useConfigStore((state) => state.config);
    const webdav = useConfigStore((state) => state.webdav || defaultWebdavSyncConfig);
    const setConfig = useConfigStore((state) => state.setConfig);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const modelOptions = config.models.map((model) => ({ label: modelOptionLabel(config, model), value: model }));
    const webdavReady = Boolean(webdav.url.trim());
    const systemChannels = (systemSettings?.systemChannels || []).filter((channel) => channel.enabled && channel.models.length);
    const workbenchTaskCount = useImageWorkbenchStore((state) => state.tasks.length);
    const workbenchConversationCount = useImageWorkbenchStore((state) => state.conversations.length);
    const clearWorkbench = useImageWorkbenchStore((state) => state.clearAll);

    useEffect(() => {
        if (!isConfigOpen) return;
        void fetch("/api/auth/session")
            .then((response) => response.json())
            .then((payload: { settings?: PublicSystemSettings }) => {
                setSystemSettings(payload.settings || null);
                updateConfig("modelPointCosts", payload.settings?.modelPointCosts || {});
                if (payload.settings?.generationConcurrency) updateConfig("generationConcurrency", normalizeGenerationConcurrency(payload.settings.generationConcurrency));
            })
            .catch(() => setSystemSettings(null));
    }, [isConfigOpen, updateConfig]);

    useEffect(() => {
        if (systemSettings?.allowUserApiConfig === false && config.apiSource === "custom") updateConfig("apiSource", "system");
    }, [config.apiSource, systemSettings?.allowUserApiConfig, updateConfig]);

    const saveConfig = (nextConfig: AiConfig) => {
        setConfig(nextConfig);
    };

    useEffect(() => {
        if (!isConfigOpen || config.apiSource !== "custom" || !isSystemProxyConfig(config)) return;
        saveConfig(createBlankCustomConfig(config));
    }, [config, isConfigOpen, setConfig]);

    const finishConfig = () => {
        const ready = config.channels.some((channel) => channel.baseUrl.trim() && channel.apiKey.trim() && channel.models.length);
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
        clearPromptContinue();
    };

    const updateChannels = (channels: ModelChannel[]) => {
        const nextConfig = withChannels(config, channels);
        saveConfig(nextConfig);
    };

    const applySystemChannels = () => {
        if (!systemChannels.length) {
            message.warning("平台默认接口暂未配置可用模型");
            return;
        }
        if (!isSystemProxyConfig(config)) customConfigRef.current = { ...config, apiSource: "custom" };
        const nextConfig = withChannels({ ...config, apiSource: "system" }, systemChannels);
        const defaults = systemSettings?.defaultModels;
        saveConfig({
            ...nextConfig,
            apiSource: "system",
            imageModel: resolveSystemModel(nextConfig, systemChannels, config.imageModel, defaults?.imageModel, "image"),
            videoModel: resolveSystemModel(nextConfig, systemChannels, config.videoModel, defaults?.videoModel, "video"),
            textModel: resolveSystemModel(nextConfig, systemChannels, config.textModel, defaults?.textModel, "text"),
            audioModel: resolveSystemModel(nextConfig, systemChannels, config.audioModel, defaults?.audioModel, "audio"),
        });
        message.success("已使用平台默认接口");
    };

    const changeApiSource = (value: AiConfig["apiSource"]) => {
        if (value === "system") {
            applySystemChannels();
            return;
        }
        const customConfig = customConfigRef.current || (isSystemProxyConfig(config) ? createBlankCustomConfig(config) : { ...config, apiSource: "custom" });
        saveConfig({ ...customConfig, apiSource: "custom" });
    };

    const updateChannel = (id: string, patch: Partial<ModelChannel>) => {
        updateChannels(config.channels.map((channel) => (channel.id === id ? { ...channel, ...patch, apiFormat: "openai", models: patch.models ? uniqueModels(patch.models) : channel.models } : channel)));
    };

    const addChannel = () => {
        updateChannels([...config.channels, createBlankModelChannel(`渠道 ${config.channels.length + 1}`)]);
    };

    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning("至少保留一个渠道");
            return;
        }
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };

    const refreshChannelModels = async (channel: ModelChannel) => {
        if (!channel.baseUrl.trim() || !channel.apiKey.trim()) {
            message.error("请先填写该渠道的 Base URL 和 API Key");
            return;
        }
        setLoadingChannelId(channel.id);
        try {
            const models = await fetchChannelModels(channel);
            updateChannels(config.channels.map((item) => (item.id === channel.id ? { ...item, models } : item)));
            message.success(`${channel.name} 模型列表已更新`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingChannelId("");
        }
    };

    const refreshAllModels = async () => {
        const runnable = config.channels.filter((channel) => channel.baseUrl.trim() && channel.apiKey.trim());
        if (!runnable.length) {
            message.error("请先填写至少一个渠道的 Base URL 和 API Key");
            return;
        }
        setLoadingChannelId("all");
        try {
            const entries = await Promise.all(runnable.map(async (channel) => [channel.id, await fetchChannelModels(channel)] as const));
            const modelMap = new Map(entries);
            updateChannels(config.channels.map((channel) => (modelMap.has(channel.id) ? { ...channel, models: modelMap.get(channel.id) || [] } : channel)));
            message.success("模型列表已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingChannelId("");
        }
    };

    const updateCapabilityModels = (group: ModelGroup, models: string[]) => {
        const next = uniqueModels(models.map((model) => normalizeModelOptionValue(model, config.channels)).filter(Boolean));
        updateConfig(group.modelsKey, next);
        if (!next.includes(config[group.modelKey])) updateConfig(group.modelKey, next[0] || "");
    };

    const testWebdav = async () => {
        if (!webdavReady) {
            message.error("请先填写 WebDAV 地址");
            return;
        }
        setTestingWebdav(true);
        try {
            await testWebdavConnection(webdav);
            message.success("WebDAV 连接可用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "WebDAV 连接测试失败");
        } finally {
            setTestingWebdav(false);
        }
    };

    const updateWebdavProgress = (event: AppSyncProgressEvent) => {
        setWebdavSyncStatus(event.stage);
        if (!event.domain) return;
        setWebdavDomainProgress((current) => ({
            ...current,
            [event.domain as AppSyncDomainKey]: {
                label: event.label || webdavDomainLabels[event.domain as AppSyncDomainKey],
                stage: event.stage,
                current: event.current,
                total: event.total,
                status: event.status,
            },
        }));
    };

    const syncWebdav = async () => {
        if (!webdavReady) {
            message.error("请先填写 WebDAV 地址");
            return;
        }
        setSyncingWebdav(true);
        setWebdavDomainProgress(createWebdavDomainProgress());
        setWebdavSyncStatus("准备同步");
        try {
            const result = await syncAppDataToWebdav(webdav, updateWebdavProgress);
            updateWebdavConfig("lastSyncedAt", result.syncedAt);
            message.success(`同步完成：${result.projects} 个画布，${result.assets} 个素材，${result.imageLogs + result.videoLogs} 条记录，本次上传 ${result.uploadedFiles} 个文件 ${formatBytes(result.uploadedBytes)}`);
        } catch (error) {
            setWebdavSyncStatus(error instanceof Error ? error.message : "WebDAV 同步失败");
            message.error(error instanceof Error ? error.message : "WebDAV 同步失败");
        } finally {
            setSyncingWebdav(false);
        }
    };

    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">配置与用户偏好</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">模型选择、生成偏好和同步偏好</div>
                </div>
            }
            open={isConfigOpen}
            width="min(860px, calc(100vw - 32px))"
            centered
            className="app-config-modal"
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "min(68vh, calc(100dvh - 176px))", overflowX: "hidden", overflowY: "auto", paddingRight: 4 } }}
            footer={
                <Button type="primary" onClick={finishConfig}>
                    完成
                </Button>
            }
        >
            {shouldPromptContinue ? (
                <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-2">
                        <CircleAlert className="mt-0.5 size-4 shrink-0" />
                        <div className="leading-6">
                            <span className="font-semibold">需要先完成 API 配置。</span>
                            <span className="ml-1">请先确认接口、密钥和默认模型，再继续使用生图工作台。</span>
                        </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                        <Button size="small" type="primary" onClick={() => setActiveTab("api")}>
                            去 API 配置
                        </Button>
                    </div>
                </div>
            ) : null}
            <Tabs
                className="max-w-full overflow-hidden"
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    {
                        key: "preferences",
                        label: "习惯配置",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="grid gap-4 md:grid-cols-4">
                                    <Form.Item label="画布默认生图张数" extra="新建画布生图和配置节点默认使用，单个节点仍可单独覆盖。" className="mb-4">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label="默认音频声音" className="mb-4">
                                        <Select value={config.audioVoice} options={audioVoiceOptions} popupClassName="app-config-select-dropdown" onChange={(value) => updateConfig("audioVoice", value)} />
                                    </Form.Item>
                                    <Form.Item label="默认音频格式" className="mb-4">
                                        <Select value={config.audioFormat} options={audioFormatOptions} popupClassName="app-config-select-dropdown" onChange={(value) => updateConfig("audioFormat", value)} />
                                    </Form.Item>
                                    <Form.Item label="默认音频语速" className="mb-4">
                                        <Input
                                            type="number"
                                            min={0.25}
                                            max={4}
                                            step={0.05}
                                            value={config.audioSpeed}
                                            onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                            onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                        />
                                    </Form.Item>
                                </div>
                                <Form.Item label="默认音频指令" className="mb-4">
                                    <Input.TextArea rows={2} value={config.audioInstructions} placeholder="例如：自然、温暖、适合旁白。" onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                </Form.Item>
                                <Form.Item label="系统提示词" className="mb-0">
                                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder="例如：你是一位擅长电影感写实摄影的视觉导演。" onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                </Form.Item>
                            </Form>
                        ),
                    },
                    {
                        key: "api",
                        label: "API 配置",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="size-4" />生图请求设置</div>
                                    <div className="mt-1 text-xs leading-5 text-stone-500">这些选项会保存在当前浏览器，并作为后续生图请求的默认配置。</div>
                                </div>
                                <div className="grid gap-4 md:grid-cols-2">
                                    <Form.Item label="API 接口" extra="兼容 Images API 与 Responses API 的接口配置。" className="mb-0">
                                        <Select value={config.apiMode} options={[{ label: "Images API (/v1/images)", value: "images" }, { label: "Responses API (/v1/responses)", value: "responses" }]} popupClassName="app-config-select-dropdown" onChange={(value) => updateConfig("apiMode", value as AiConfig["apiMode"])} />
                                    </Form.Item>
                                    <Form.Item label="请求超时（秒）" className="mb-0">
                                        <Input type="number" min={30} max={3600} value={config.requestTimeout} onChange={(event) => updateConfig("requestTimeout", Math.max(30, Number(event.target.value) || 600))} />
                                    </Form.Item>
                                </div>
                                <div className="mt-5 space-y-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <SettingSwitch label="流式传输" description="请求允许以流式方式返回文本或中间状态。" checked={config.streamImages} onChange={(checked) => updateConfig("streamImages", checked)} />
                                    <Form.Item label="请求中间步骤图像数" extra="设置为 0 表示不请求中间步骤图像。" className="mb-0">
                                        <Select value={String(config.streamPartialImages)} options={[0, 1, 2, 3].map((value) => ({ label: `${value} 张`, value: String(value) }))} popupClassName="app-config-select-dropdown" onChange={(value) => updateConfig("streamPartialImages", Number(value))} />
                                    </Form.Item>
                                    <SettingSwitch label="返回 Base64 图片数据" description="优先使用 Base64 图片数据，避免部分接口的临时 URL 失效。" checked={config.responseFormatB64Json} onChange={(checked) => updateConfig("responseFormatB64Json", checked)} />
                                    <SettingSwitch label="Codex CLI 兼容模式" description="向兼容 Codex CLI 的接口发送对应参数。" checked={config.codexCli} onChange={(checked) => updateConfig("codexCli", checked)} />
                                </div>
                            </Form>
                        ),
                    },
                    {
                        key: "agent",
                        label: "Agent 配置",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4" />Agent 任务行为</div>
                                    <div className="mt-1 text-xs leading-5 text-stone-500">控制 Agent 的文本理解、图片生成和连续调用策略。</div>
                                </div>
                                <div className="grid gap-4 md:grid-cols-2">
                                    <Form.Item label="Agent API 模式" className="mb-0">
                                        <Select value={config.agentApiMode} options={[{ label: "关闭独立配置", value: "off" }, { label: "原生 Responses API", value: "native" }, { label: "混合模式", value: "hybrid" }]} popupClassName="app-config-select-dropdown" onChange={(value) => updateConfig("agentApiMode", value as AiConfig["agentApiMode"])} />
                                    </Form.Item>
                                    <Form.Item label="最大工具调用轮数" extra="用于限制连续调用，避免任务无限循环。" className="mb-0">
                                        <Input type="number" min={1} max={50} value={config.agentMaxToolRounds} onChange={(event) => updateConfig("agentMaxToolRounds", Math.max(1, Math.min(50, Number(event.target.value) || 15)))} />
                                    </Form.Item>
                                    <Form.Item label="Agent 文本模型" className="mb-0">
                                        <ModelPicker config={config} value={config.agentTextModel || config.textModel} onChange={(model) => updateConfig("agentTextModel", model)} capability="text" fullWidth />
                                    </Form.Item>
                                    <Form.Item label="Agent 图片模型" className="mb-0">
                                        <ModelPicker config={config} value={config.agentImageModel || config.imageModel} onChange={(model) => updateConfig("agentImageModel", model)} capability="image" fullWidth />
                                    </Form.Item>
                                </div>
                                <div className="mt-5 space-y-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <SettingSwitch label="网络搜索" description="允许 Agent 使用网络搜索工具补充上下文。" checked={config.agentWebSearch} onChange={(checked) => updateConfig("agentWebSearch", checked)} />
                                    <SettingSwitch label="任务完成后发送系统通知" description="生成完成时通过浏览器通知提醒。" checked={config.taskCompletionNotification} onChange={(checked) => updateConfig("taskCompletionNotification", checked)} />
                                    <SettingSwitch label="发送后自动滚动到底部" description="Agent 发送新一轮对话后自动定位到最新消息。" checked={config.agentAutoScroll} onChange={(checked) => updateConfig("agentAutoScroll", checked)} />
                                </div>
                            </Form>
                        ),
                    },
                    {
                        key: "data",
                        label: "数据管理",
                        children: (
                            <div className="space-y-4">
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800"><div className="flex items-center gap-2 text-sm font-semibold"><Database className="size-4" />生图任务</div><div className="mt-2 text-2xl font-semibold">{workbenchTaskCount}</div><div className="mt-1 text-xs text-stone-500">保存在浏览器本地的任务记录</div></div>
                                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800"><div className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4" />Agent 对话</div><div className="mt-2 text-2xl font-semibold">{workbenchConversationCount}</div><div className="mt-1 text-xs text-stone-500">保存在浏览器本地的对话记录</div></div>
                                </div>
                                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50/70 p-4 dark:border-red-500/30 dark:bg-red-500/10">
                                    <div><div className="text-sm font-semibold text-red-700 dark:text-red-300">清空生图工作台记录</div><div className="mt-1 text-xs text-red-700/70 dark:text-red-200/70">只清除本地任务和 Agent 对话，不会删除“我的素材”中的已保存图片。</div></div>
                                    <Button danger onClick={() => { clearWorkbench(); message.success("已清空生图工作台记录"); }}>清空记录</Button>
                                </div>
                            </div>
                        ),
                    },
                    {
                        key: "about",
                        label: "关于",
                        children: (
                            <div className="rounded-lg border border-stone-200 p-4 text-sm leading-7 text-stone-600 dark:border-stone-800 dark:text-stone-300">
                                <div className="flex items-center gap-2 font-semibold text-stone-900 dark:text-white">
                                    <Info className="size-4" />
                                    GPT Image Playground
                                </div>
                                <p className="mt-2">XSVO 原生生图工作台，任务、Agent 对话和图片记录默认保存在当前浏览器。</p>
                                <p className="mt-2 text-xs text-stone-500">API Key 与本地生成数据不会自动同步到服务器。</p>
                            </div>
                        ),
                    },
                ]}
            />
        </Modal>
    );
}

function isSystemProxyConfig(config: AiConfig) {
    return config.channels.length > 0 && config.channels.every((channel) => channel.baseUrl.trim().startsWith("/api/ai/system/") && channel.apiKey === "system");
}

function createBlankCustomConfig(config: AiConfig) {
    return {
        ...withChannels({ ...config, apiSource: "custom" }, [createBlankModelChannel("自定义渠道", "custom-default")]),
        baseUrl: "",
        apiKey: "",
        models: [],
        imageModels: [],
        videoModels: [],
        textModels: [],
        audioModels: [],
        imageModel: "",
        videoModel: "",
        textModel: "",
        audioModel: "",
    };
}

function createBlankModelChannel(name: string, id?: string): ModelChannel {
    return { id: id || nanoid(), name, baseUrl: "", apiKey: "", apiFormat: "openai", models: [] };
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const normalizedChannels = channels.map((channel) => ({ ...channel, apiFormat: "openai" as const }));
    const models = modelOptionsFromChannels(normalizedChannels);
    const imageModels = keepOrSuggest(config.imageModels, filterModelsByCapability(models, "image"), models);
    const videoModels = keepOrSuggest(config.videoModels, filterModelsByCapability(models, "video"), models);
    const textModels = keepOrSuggest(config.textModels, filterModelsByCapability(models, "text"), models);
    const audioModels = keepOrSuggest(config.audioModels, filterModelsByCapability(models, "audio"), models);
    return {
        ...config,
        channels: normalizedChannels,
        models,
        baseUrl: normalizedChannels[0]?.baseUrl || config.baseUrl,
        apiKey: normalizedChannels[0]?.apiKey || config.apiKey,
        apiFormat: "openai",
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel: normalizeDefaultModel(config.imageModel, imageModels),
        videoModel: normalizeDefaultModel(config.videoModel, videoModels),
        textModel: normalizeDefaultModel(config.textModel, textModels),
        audioModel: normalizeDefaultModel(config.audioModel, audioModels),
    };
}

function keepOrSuggest(current: string[], suggested: string[], allModels: string[]) {
    const available = new Set(allModels);
    const kept = uniqueModels(current).filter((model) => available.has(model));
    return kept.length ? kept : suggested;
}

function normalizeDefaultModel(value: string, options: string[]) {
    if (options.includes(value)) return value;
    return options[0] || value;
}

function resolveSystemDefault(channels: ModelChannel[], model?: string) {
    const name = (model || "").trim();
    if (!name) return "";
    const channel = channels.find((item) => item.models.includes(name));
    return channel ? encodeChannelModel(channel.id, name) : "";
}

function resolveSystemModel(config: AiConfig, channels: ModelChannel[], currentModel: string, defaultModel: string | undefined, capability: ModelCapability) {
    const currentName = normalizeModelOptionValue(currentModel, channels);
    if (currentName && config[`${capability}Models` as "imageModels" | "videoModels" | "textModels" | "audioModels"].includes(currentName)) return currentName;
    const matchedByName = resolveSystemDefault(channels, modelName(currentModel));
    if (matchedByName && config[`${capability}Models` as "imageModels" | "videoModels" | "textModels" | "audioModels"].includes(matchedByName)) return matchedByName;
    const adminDefault = resolveSystemDefault(channels, defaultModel);
    if (adminDefault && config[`${capability}Models` as "imageModels" | "videoModels" | "textModels" | "audioModels"].includes(adminDefault)) return adminDefault;
    return config[`${capability}Models` as "imageModels" | "videoModels" | "textModels" | "audioModels"][0] || "";
}

function modelName(value: string) {
    const index = value.indexOf("::");
    return index >= 0 ? value.slice(index + 2) : value;
}

function SystemChannelSummary({ channels }: { channels: PublicSystemSettings["systemChannels"] }) {
    if (!channels.length) {
        return <div className="rounded-lg border border-dashed border-stone-200 p-6 text-center text-sm text-stone-500 dark:border-stone-800">平台默认接口暂未配置可用模型。</div>;
    }

    return (
        <div className="space-y-3">
            {channels.map((channel) => (
                <section key={channel.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{channel.name || "默认渠道"}</div>
                            <div className="mt-1 text-xs text-stone-500">连接信息不会显示给用户端，这里只展示可用模型。</div>
                        </div>
                        <div className="shrink-0 text-xs text-stone-500">{channel.models.length} 个模型</div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {channel.models.map((model) => (
                            <span key={model} className="rounded border border-stone-200 bg-stone-100 px-2 py-1 text-xs text-stone-700 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200">
                                {model}
                            </span>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 1))));
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function formatWebdavTime(value: string) {
    return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function WebdavProgressGrid({ progress }: { progress: Record<AppSyncDomainKey, WebdavDomainProgress> }) {
    return (
        <div className="mt-3 grid gap-2">
            {webdavDomainKeys.map((key) => {
                const item = progress[key];
                const count = item.total ? `${item.current || 0}/${item.total}` : "";
                return (
                    <div key={key} className="rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
                            <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{item.label}</span>
                            <span className="min-w-0 truncate text-right text-stone-500">
                                {item.stage}
                                {count ? ` · ${count}` : ""}
                            </span>
                        </div>
                        <Progress percent={getWebdavProgressPercent(item)} size="small" status={getWebdavProgressStatus(item)} showInfo={false} />
                    </div>
                );
            })}
        </div>
    );
}

function getWebdavProgressPercent(item: WebdavDomainProgress) {
    if (item.status === "success") return 100;
    if (item.total) return Math.min(100, Math.round(((item.current || 0) / item.total) * 100));
    if (item.status === "exception") return 100;
    if (item.stage === "等待同步") return 0;
    if (item.stage === "读取远端清单") return 12;
    if (item.stage === "读取本地数据") return 24;
    if (item.stage === "下载缺失媒体") return 36;
    if (item.stage === "写入本地合并结果") return 58;
    if (item.stage === "上传新增媒体") return 66;
    if (item.stage === "媒体已齐全" || item.stage === "媒体无需上传") return 74;
    if (item.stage.startsWith("上传清单")) return 90;
    return item.status === "active" ? 30 : 0;
}

function getWebdavProgressStatus(item: WebdavDomainProgress): "normal" | "active" | "success" | "exception" {
    if (item.status === "success" || item.status === "exception") return item.status;
    return item.status === "active" ? "active" : "normal";
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function SettingSwitch({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <div className="text-sm font-medium text-stone-700 dark:text-stone-200">{label}</div>
                <div className="mt-1 text-xs leading-5 text-stone-500">{description}</div>
            </div>
            <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-blue-500" : "bg-stone-300 dark:bg-stone-700"}`}>
                <span className={`size-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
            </button>
        </div>
    );
}
