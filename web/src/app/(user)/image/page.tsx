"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";

import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { requestCreditCost } from "@/constant/credits";
import { modelMatchesCapability, modelOptionName, normalizeModelOptionValue, resolveModelChannel, useConfigStore, useEffectiveConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { uploadImage } from "@/services/image-storage";
import { recordGenerationLog } from "@/services/api/generation-logs";

const PLAYGROUND_URL = "/gpt-image-playground/index.html?v=xsvo-0.1.1-native-api-mode-6-agent-hookfix-8";
const POINTS_REFRESH_INTERVAL_MS = 5000;
const PLAYGROUND_STORE_KEY = "gpt-image-playground";
const PLAYGROUND_ACTIVE_PROFILE_KEY = "xsvo-image-playground-active-profile";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const PLAYGROUND_REFERENCE_IMAGE_MAX_EDGE = 2400;
const PLAYGROUND_REFERENCE_REQUEST_MAX_BYTES = 100 * 1024 * 1024;
let activePlaygroundProfileIdMemory = "";
let playgroundHostProfilesMemory: PlaygroundProfile[] = [];
let recentPlaygroundRequestHints: Array<{ profile: PlaygroundProfile; prompt: string; createdAt: number }> = [];

export default function ImagePage() {
    const localConfig = useEffectiveConfig();
    const [playgroundReady, setPlaygroundReady] = useState(false);
    const [settingsLoaded, setSettingsLoaded] = useState(false);
    const [configHydrated, setConfigHydrated] = useState(false);
    const [systemSettings, setSystemSettings] = useState<PublicSystemSettings | null>(null);
    const [playgroundCostInput, setPlaygroundCostInput] = useState<PlaygroundCostInput | null>(null);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const config = useMemo(() => resolveImageWorkbenchConfig(localConfig, systemSettings), [localConfig, systemSettings]);
    const settings = useMemo(() => buildPlaygroundSettings(config), [config]);
    const pointsCost = useMemo(
        () =>
            requestCreditCost({
                apiSource: playgroundCostInput?.platform === false ? "custom" : config.apiSource,
                modelPointCosts: config.modelPointCosts,
                model: playgroundCostInput?.model || config.imageModel || config.model,
                count: playgroundCostInput?.count ?? config.count,
            }),
        [playgroundCostInput, config.apiSource, config.modelPointCosts, config.imageModel, config.model, config.count],
    );
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const { message } = App.useApp();
    const messageRef = useRef(message);
    messageRef.current = message;

    const insertPromptToPlayground = (text: string) => {
        const ok = insertTextIntoPlaygroundPrompt(iframeRef.current?.contentDocument, text);
        if (ok) message.success("已插入提示词");
        else message.warning("未找到生图工作台编辑框");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            insertPromptToPlayground(payload.content);
            setAssetPickerOpen(false);
            return;
        }
        if (payload.kind === "video") {
            message.warning("生图工作台暂不支持插入视频素材");
            return;
        }
        try {
            await dropImageAssetIntoPlayground(iframeRef.current?.contentDocument, payload);
            message.success("已插入素材图片");
            setAssetPickerOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "插入素材失败");
        }
    };

    useEffect(() => {
        if (!configHydrated || !playgroundReady) return;
        const timer = setInterval(() => {
            if (installPointsRefreshBridge(iframeRef.current?.contentWindow)) clearInterval(timer);
        }, 200);
        return () => clearInterval(timer);
    }, [settingsLoaded, configHydrated, playgroundReady]);

    // 只在画廊模式增强 iframe。Agent 流式渲染期间不观察或改写 React 管理的 DOM。
    useEffect(() => {
        if (!configHydrated || !playgroundReady) return;
        const BUTTON_FLAG = "data-xsvo-asset-injected";
        const ICON_SVG = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>';
        const CHECK_SVG = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>';
        const ACTION_BTN_BLUE = "p-1.5 rounded-md transition text-gray-400 hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10";
        const ACTION_BTN_GREEN = "p-1.5 rounded-md transition text-green-500 hover:bg-green-50 dark:hover:bg-green-500/10";
        const OVERLAY_BTN_BLUE = "flex items-center justify-center px-1.5 py-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 transition focus:outline-none focus:ring-1 focus:ring-white/50";
        const OVERLAY_BTN_GREEN = "flex items-center justify-center px-1.5 py-0.5 bg-green-500/90 text-white rounded backdrop-blur-sm hover:bg-green-600 transition focus:outline-none focus:ring-1 focus:ring-white/50";

        const findCardImage = (card: Element | null): HTMLImageElement | null => {
            if (!card) return null;
            const img = card.querySelector<HTMLImageElement>("img[data-image-id]");
            if (img && img.src) return img;
            const img2 = card.querySelector<HTMLImageElement>("img.saveable-image");
            if (img2 && img2.src) return img2;
            return null;
        };

        const findCardImages = (card: Element | null): HTMLImageElement[] => {
            if (!card) return [];
            const seen = new Set<string>();
            return Array.from(card.querySelectorAll<HTMLImageElement>("img[data-image-id], img.saveable-image"))
                .filter((img) => {
                    const key = img.dataset.imageId || img.src;
                    if (!img.src || !key || seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
        };

        const imageKeyOf = (img: HTMLImageElement) => img.dataset.imageId || img.src;

        const findExistingAsset = (img: HTMLImageElement) => {
            const imageKey = imageKeyOf(img);
            return useAssetStore.getState().assets.find((a) =>
                a.source === "生图工作台" && (
                    a.data?.dataUrl === img.src ||
                    a.metadata?.imageKey === imageKey ||
                    (imageKey && a.title === `image-${imageKey}`)
                )
            );
        };

        const addImageAsset = async (img: HTMLImageElement) => {
            const imageKey = imageKeyOf(img);
            if (!img.complete || !img.naturalWidth) {
                await new Promise<void>((resolve) => {
                    img.addEventListener("load", () => resolve(), { once: true });
                    img.addEventListener("error", () => resolve(), { once: true });
                });
            }
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || img.width || 1024;
            canvas.height = img.naturalHeight || img.height || 1024;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("canvas 不可用");
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
            if (!blob) throw new Error("转 Blob 失败");
            const uploaded = await uploadImage(blob);
            useAssetStore.getState().addAsset({
                kind: "image",
                title: imageKey ? `image-${imageKey}` : `生图 ${new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
                coverUrl: uploaded.url,
                tags: ["生图工作台"],
                source: "生图工作台",
                metadata: { imageKey },
                data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType },
            });
        };

        const syncOneButtonState = (btn: HTMLButtonElement, images: HTMLImageElement[]) => {
            setBtnState(btn, images.length > 0 && images.every((img) => findExistingAsset(img)));
        };

        const toggleImageAssets = async (btn: HTMLButtonElement, images: HTMLImageElement[], notFoundCount = 0) => {
            if (!images.length) {
                messageRef.current?.warning("未找到图片");
                return;
            }
            if (btn.dataset.xsvoLoading === "1") return;
            btn.dataset.xsvoLoading = "1";
            const items = images.map((img) => ({ img, existing: findExistingAsset(img) }));
            const addedItems = items.filter((item) => item.existing);
            const pendingItems = items.filter((item) => !item.existing);
            let successCount = 0;
            let failCount = 0;

            try {
                if (pendingItems.length === 0 && addedItems.length > 0) {
                    addedItems.forEach((item) => {
                        if (item.existing) useAssetStore.getState().removeAsset(item.existing.id);
                    });
                    setBtnState(btn, false);
                    messageRef.current?.success(`已从素材库移除 ${addedItems.length} 张${notFoundCount > 0 ? `，${notFoundCount} 张未找到图片` : ""}`);
                    return;
                }

                // 先更新原生按钮状态，图片上传在后台完成，避免点击后出现明显等待。
                setBtnState(btn, true);

                for (const item of pendingItems) {
                    try {
                        await addImageAsset(item.img);
                        successCount++;
                    } catch (err) {
                        console.error("[xsvo] 加入素材失败", err);
                        failCount++;
                    }
                }

                syncOneButtonState(btn, images);
                if (successCount > 0) {
                    const skippedCount = addedItems.length;
                    messageRef.current?.success(`已加入 ${successCount} 张${skippedCount > 0 ? `，${skippedCount} 张已存在已跳过` : ""}${failCount > 0 ? `，${failCount} 张失败` : ""}${notFoundCount > 0 ? `，${notFoundCount} 张未找到图片` : ""}`);
                } else if (failCount > 0) {
                    messageRef.current?.error(`加入失败：${failCount} 张图片未能加入`);
                } else {
                    messageRef.current?.info("没有可加入的图片");
                }
            } finally {
                if (failCount > 0) syncOneButtonState(btn, images);
                delete btn.dataset.xsvoLoading;
            }
        };

        const injectButton = (favButton: Element) => {
            if (!favButton) return;
            const actionSpan = favButton.parentElement;
            if (!actionSpan) return;
            const next = actionSpan.nextElementSibling as HTMLElement | null;
            if (next && next.dataset.xsvoAssetBtn === "1") {
                actionSpan.setAttribute(BUTTON_FLAG, "1");
                return;
            }
            if (actionSpan.hasAttribute(BUTTON_FLAG)) actionSpan.removeAttribute(BUTTON_FLAG);
            actionSpan.setAttribute(BUTTON_FLAG, "1");

            // 注入前先查这组图是否已在素材库，决定初始状态
            const card = favButton.closest("[data-task-id]");
            const initialImages = findCardImages(card);
            const alreadyAdded = initialImages.length > 0 && initialImages.every((img) => findExistingAsset(img));

            const btn = document.createElement("button");
            btn.type = "button";
            btn.setAttribute("aria-label", "加入我的素材");
            btn.title = "加入素材";
            btn.dataset.xsvoAssetBtn = "1";
            // 使用和收藏按钮一致的原生操作按钮样式。
            btn.className = ACTION_BTN_BLUE;
            btn.innerHTML = ICON_SVG;
            btn.dataset.xsvoState = "blue";
            if (alreadyAdded) {
                // 同步为绿色状态
                btn.dataset.xsvoState = "green";
                btn.className = ACTION_BTN_GREEN;
                btn.innerHTML = CHECK_SVG;
                btn.setAttribute("aria-label", "点击移除素材");
                btn.title = "点击移除素材";
            }
            btn.addEventListener("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (btn.dataset.xsvoLoading === "1") return;
                const card = favButton.closest("[data-task-id]");
                if (card) {
                    await toggleImageAssets(btn, findCardImages(card));
                    return;
                }
                const doc = iframeRef.current?.contentDocument;
                if (!doc) return;
                const allCards = doc.querySelectorAll("[data-task-id]");
                const selectedCards: Element[] = [];
                allCards.forEach((c) => {
                    if (c.querySelector(".bg-blue-500.rounded-full")) selectedCards.push(c);
                });
                if (selectedCards.length === 0) {
                    messageRef.current?.warning("未选中任何任务");
                    return;
                }
                const selectedImages = selectedCards.flatMap(findCardImages);
                await toggleImageAssets(btn, selectedImages, selectedCards.length - selectedImages.length);
                return;
            });

            actionSpan.parentNode?.insertBefore(btn, actionSpan.nextSibling);
        };

        const setBtnState = (btn: HTMLButtonElement, green: boolean) => {
            const isGreen = btn.dataset.xsvoState === "green";
            if (green && !isGreen) {
                btn.className = btn.dataset.xsvoButtonStyle === "overlay" ? OVERLAY_BTN_GREEN : ACTION_BTN_GREEN;
                btn.innerHTML = CHECK_SVG;
                btn.setAttribute("aria-label", "点击移除素材");
                btn.title = "点击移除素材";
                btn.dataset.xsvoState = "green";
            } else if (!green && isGreen) {
                btn.className = btn.dataset.xsvoButtonStyle === "overlay" ? OVERLAY_BTN_BLUE : ACTION_BTN_BLUE;
                btn.innerHTML = ICON_SVG;
                btn.setAttribute("aria-label", "加入我的素材");
                btn.title = "加入素材";
                btn.dataset.xsvoState = "blue";
            }
        };

        const findSinglePreviewImage = (btn: HTMLButtonElement) => {
            const toolbar = btn.closest("div.absolute");
            return toolbar?.parentElement?.querySelector<HTMLImageElement>('img.saveable-image[data-image-id]') || null;
        };

        const injectSingleImageButton = (downloadButton: Element) => {
            const toolbar = downloadButton.closest("div.absolute");
            const downloadWrap = downloadButton.parentElement;
            if (!toolbar || !downloadWrap) return;
            if (toolbar.querySelector('button[data-xsvo-asset-single-btn="1"]')) return;
            const img = toolbar.parentElement?.querySelector<HTMLImageElement>('img.saveable-image[data-image-id]');
            if (!img) return;

            const wrap = document.createElement("div");
            wrap.className = "relative group flex";
            wrap.dataset.xsvoAssetSingleWrap = "1";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.dataset.xsvoAssetSingleBtn = "1";
            btn.dataset.xsvoButtonStyle = "overlay";
            btn.title = "加入素材";
            btn.dataset.xsvoState = "blue";
            btn.className = OVERLAY_BTN_BLUE;
            btn.innerHTML = ICON_SVG;
            btn.setAttribute("aria-label", "加入当前图片到素材");
            btn.addEventListener("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const currentImg = findSinglePreviewImage(btn);
                if (!currentImg) {
                    messageRef.current?.warning("未找到当前图片");
                    return;
                }
                await toggleImageAssets(btn, [currentImg]);
            });
            wrap.appendChild(btn);
            downloadWrap.parentNode?.insertBefore(wrap, downloadWrap.nextSibling);
            setBtnState(btn, Boolean(findExistingAsset(img)));
        };

        // 观察器只在画廊模式工作，避免 Agent 流式更新时产生宿主侧 DOM 竞争。
        let observer: MutationObserver | null = null;
        let scanRafId: number | null = null;
        const scanAllRaf = () => {
            if (scanRafId !== null) return;
            scanRafId = requestAnimationFrame(() => {
                scanRafId = null;
                const doc = iframeRef.current?.contentDocument;
                if (!doc || !doc.body) return;
                if (isPlaygroundInAgentMode()) {
                    observer?.disconnect();
                    observer = null;
                    return;
                }
                const buttons = doc.querySelectorAll('button[aria-label="收藏任务"], button[aria-label="编辑收藏夹"]');
                buttons.forEach(injectButton);
                doc.querySelectorAll('button[aria-label="下载图片"]').forEach(injectSingleImageButton);
            });
        };

        const attachObserver = () => {
            const doc = iframeRef.current?.contentDocument;
            if (!doc || !doc.body) return;
            if (isPlaygroundInAgentMode()) {
                observer?.disconnect();
                observer = null;
                return;
            }
            if (observer) return;
            const buttons = doc.querySelectorAll('button[aria-label="收藏任务"], button[aria-label="编辑收藏夹"]');
            buttons.forEach(injectButton);
            doc.querySelectorAll('button[aria-label="下载图片"]').forEach(injectSingleImageButton);
            observer = new MutationObserver(() => scanAllRaf());
            observer.observe(doc.body, { childList: true, subtree: true });
        };

        // 轮询只负责模式切换和 iframe 重挂载，不再轮询整个页面按钮状态。
        const attachTimer = setInterval(() => {
            const iframe = iframeRef.current;
            const doc = iframe?.contentDocument;
            if (doc && doc.body && doc.readyState === "complete") {
                attachObserver();
            }
        }, 500);
        attachObserver();

        return () => {
            clearInterval(attachTimer);
            observer?.disconnect();
            if (scanRafId !== null) cancelAnimationFrame(scanRafId);
        };
    }, [settingsLoaded, configHydrated, playgroundReady]);

    useEffect(() => {
        const store = useConfigStore as typeof useConfigStore & {
            persist?: {
                hasHydrated: () => boolean;
                onFinishHydration: (callback: () => void) => () => void;
            };
        };
        if (!store.persist || store.persist.hasHydrated()) {
            setConfigHydrated(true);
            return;
        }
        return store.persist.onFinishHydration(() => setConfigHydrated(true));
    }, []);

    useEffect(() => {
        let ignore = false;
        void fetch("/api/auth/session", { cache: "no-store" })
            .then((response) => response.json() as Promise<{ settings?: PublicSystemSettings; user?: LocalUser | null }>)
            .then((payload) => {
                if (ignore) return;
                setSystemSettings(payload.settings || null);
                if (payload.user) useUserStore.getState().setUser(payload.user);
            })
            .catch(() => {
                if (!ignore) setSystemSettings(null);
            })
            .finally(() => {
                if (!ignore) setSettingsLoaded(true);
            });
        return () => {
            ignore = true;
        };
    }, []);

    useEffect(() => {
        if (!settingsLoaded || config.apiSource !== "system") return;

        let ignore = false;
        const refreshUserPoints = async () => {
            try {
                const response = await fetch("/api/auth/session", { cache: "no-store" });
                const payload = (await response.json()) as { user?: LocalUser | null };
                if (!ignore && payload.user) useUserStore.getState().setUser(payload.user);
            } catch {
                // Points refresh is best-effort and must not affect playground generation.
            }
        };
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void refreshUserPoints();
        }, POINTS_REFRESH_INTERVAL_MS);
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") void refreshUserPoints();
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            ignore = true;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [settingsLoaded, config.apiSource]);

    useLayoutEffect(() => {
        if (!configHydrated) return;
        syncPlaygroundSettings(settings, config);
    }, [configHydrated, settings, config]);

    useEffect(() => {
        if (!configHydrated || !playgroundReady) return;
        const refreshCostInput = () => {
            const next = readPlaygroundCostInput(config);
            setPlaygroundCostInput((current) => (current?.model === next.model && current.count === next.count && current.platform === next.platform ? current : next));
        };
        refreshCostInput();
        const timer = setInterval(refreshCostInput, 1000);
        return () => clearInterval(timer);
    }, [configHydrated, playgroundReady, config]);

    useEffect(() => {
        if (!configHydrated || !playgroundReady) return;
        const applyComposerActions = () => {
            if (isPlaygroundInAgentMode()) return;
            const doc = iframeRef.current?.contentDocument;
            installPlaygroundModelPicker(doc, settings.profiles, (profileId) => {
                switchPlaygroundProfile(profileId);
            });
            installPointsCostBadge(doc, pointsCost);
        };
        applyComposerActions();
        const timer = setInterval(applyComposerActions, 500);
        return () => clearInterval(timer);
    }, [settingsLoaded, configHydrated, playgroundReady, pointsCost, settings.profiles]);



    useEffect(() => {
        if (!configHydrated || !playgroundReady) return;
        let observer: MutationObserver | null = null;
        let rafId: number | null = null;
        const applyHeaderChrome = () => {
            if (isPlaygroundInAgentMode()) {
                observer?.disconnect();
                observer = null;
                if (rafId !== null) cancelAnimationFrame(rafId);
                rafId = null;
                return;
            }
            const doc = iframeRef.current?.contentDocument;
            applyPlaygroundHeaderChrome(doc, {
                onOpenPromptLibrary: () => setPromptDialogOpen(true),
                onOpenAssets: () => setAssetPickerOpen(true),
            });
            if (!observer && doc?.body) {
                observer = new MutationObserver(() => {
                    if (isPlaygroundInAgentMode()) {
                        observer?.disconnect();
                        observer = null;
                        if (rafId !== null) cancelAnimationFrame(rafId);
                        rafId = null;
                        return;
                    }
                    // 用 rAF 延迟，避免在 React 渲染过程中同步修改 header DOM
                    if (rafId !== null) return;
                    rafId = requestAnimationFrame(() => {
                        rafId = null;
                        const d = iframeRef.current?.contentDocument;
                        applyPlaygroundHeaderChrome(d, {
                            onOpenPromptLibrary: () => setPromptDialogOpen(true),
                            onOpenAssets: () => setAssetPickerOpen(true),
                        });
                    });
                });
                observer.observe(doc.body, { childList: true, subtree: true });
            }
        };
        applyHeaderChrome();
        const timer = setInterval(applyHeaderChrome, 500);
        return () => {
            clearInterval(timer);
            observer?.disconnect();
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    }, [settingsLoaded, configHydrated, playgroundReady]);

    useEffect(() => {
        if (!configHydrated || !playgroundReady) return;
        let observer: MutationObserver | null = null;
        let rafId: number | null = null;
        const applyTaskBadges = () => {
            if (isPlaygroundInAgentMode()) {
                observer?.disconnect();
                observer = null;
                if (rafId !== null) cancelAnimationFrame(rafId);
                rafId = null;
                return;
            }
            // 引用标签必须在 MutationObserver 微任务中同步清理，避免先绘制一帧原始 <ref ... />。
            sanitizePlaygroundTaskPromptRefs(iframeRef.current?.contentDocument);
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                correctPlaygroundTaskModelBadges(iframeRef.current?.contentDocument);
            });
        };
        const attachObserver = () => {
            const doc = iframeRef.current?.contentDocument;
            if (!doc?.body || observer || isPlaygroundInAgentMode()) return;
            observer = new MutationObserver(applyTaskBadges);
            observer.observe(doc.body, { childList: true, subtree: true });
        };
        applyTaskBadges();
        attachObserver();
        const timer = setInterval(() => {
            applyTaskBadges();
            attachObserver();
        }, 500);
        return () => {
            clearInterval(timer);
            observer?.disconnect();
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    }, [settingsLoaded, configHydrated, playgroundReady]);


    useEffect(() => {
        if (!configHydrated || !playgroundReady) return;
        let observer: MutationObserver | null = null;
        const applyPromptExpander = () => {
            const doc = iframeRef.current?.contentDocument;
            // Agent 模式下跳过输入框展开按钮注入：characterData/childList 回调会在 Agent 流式输出时
            // 频繁修改编辑器 DOM，与 React 渲染冲突触发 ErrorBoundary
            if (isPlaygroundInAgentMode()) {
                observer?.disconnect();
                observer = null;
                return;
            }
            installPlaygroundPromptExpander(doc);
            if (!observer && doc?.body) {
                observer = new MutationObserver(() => {
                    if (isPlaygroundInAgentMode()) {
                        observer?.disconnect();
                        observer = null;
                        return;
                    }
                    installPlaygroundPromptExpander(doc);
                });
                observer.observe(doc.body, { childList: true, subtree: true });
            }
        };
        applyPromptExpander();
        const timer = setInterval(applyPromptExpander, 300);
        return () => {
            clearInterval(timer);
            observer?.disconnect();
        };
    }, [settingsLoaded, configHydrated, playgroundReady]);
    return (
        <div className="relative h-full min-h-0 bg-gray-50 dark:bg-gray-950">
            {configHydrated ? (
                <iframe
                    ref={iframeRef}
                    src={PLAYGROUND_URL}
                    title="GPT Image Playground"
                    className="block h-full w-full border-0 bg-gray-50 dark:bg-gray-950"
                    allow="clipboard-read; clipboard-write; fullscreen; web-share"
                    allowFullScreen
                    onLoad={() => setPlaygroundReady(true)}
                />
            ) : null}
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={insertPromptToPlayground} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
        </div>
    );
}

type PointsBridgeWindow = Window & {
    __xsvoPointsRefreshBridge?: boolean;
    __xsvoTaskProfileOverride?: () => Partial<Pick<PlaygroundGenerationTaskProfile, "apiProvider" | "apiProfileId" | "apiProfileName" | "apiMode" | "apiModel">>;
    fetch: typeof window.fetch;
    XMLHttpRequest: typeof window.XMLHttpRequest;
};

type PlaygroundGenerationTaskProfile = {
    apiProvider: string;
    apiProfileId: string;
    apiProfileName: string;
    apiMode: string;
    apiModel: string;
};

function installPointsRefreshBridge(win: Window | null | undefined) {
    const bridgeWindow = win as PointsBridgeWindow | null | undefined;
    if (!bridgeWindow) return false;
    if (bridgeWindow.__xsvoPointsRefreshBridge) return true;
    try {
        const originalFetch = bridgeWindow.fetch.bind(bridgeWindow);
        bridgeWindow.__xsvoTaskProfileOverride = () => {
            const profile = readActivePlaygroundProfile();
            if (!profile) return {};
            return {
                apiProvider: profile.provider || "openai",
                apiProfileId: profile.id,
                apiProfileName: profile.name || profile.model,
                apiMode: profile.apiMode || "images",
                apiModel: profile.model,
            };
        };
        bridgeWindow.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            // Agent 模式下完全透传，不拦截/重写请求和响应，避免干扰 Responses API 流式传输
            if (isPlaygroundInAgentMode()) return originalFetch(input, init);
            const startedAt = Date.now();
            const request = await rewritePlaygroundImageFetchRequest(input, init);
            const logInput = readPlaygroundGenerationLogInput(request.input, request.init);
            const response = await originalFetch(request.input, request.init);
            const normalizedResponse = await normalizePlaygroundImageResponse(response);
            if (isSystemPointsRequest(request.input, request.init)) syncUserPointsFromResponse(normalizedResponse);
            if (logInput) void recordPlaygroundGenerationResult(logInput, normalizedResponse.clone(), Date.now() - startedAt);
            return normalizedResponse;
        }) as typeof bridgeWindow.fetch;
        installPlaygroundXhrBridge(bridgeWindow);
        bridgeWindow.__xsvoPointsRefreshBridge = true;
        return true;
    } catch {
        // Same-origin iframe bridge is best-effort; periodic session refresh is the fallback.
        return false;
    }
}

async function normalizePlaygroundImageResponse(response: Response) {
    const contentType = response.headers.get("content-type") || "";
    if (response.status === 413) {
        let text = "";
        try {
            text = await response.clone().text();
        } catch {
            text = "";
        }
        if (!contentType.toLowerCase().includes("application/json") || /Request Entity Too Large/i.test(text)) {
            return replacePlaygroundJsonResponse(response, { error: "请求体过大：参考图、素材图或 Base64 图片数据超过当前渠道网关限制。请压缩参考图、减少参考图数量，或调大该渠道 Nginx/client_max_body_size 限制后重试。" });
        }
    }
    if (response.ok || !contentType.toLowerCase().includes("json")) return response;
    const payload = await response.clone().json().catch(() => null);
    if (!isRecord(payload) || !isRecord(payload.error)) return response;
    const code = typeof payload.error.code === "string" ? payload.error.code : "";
    const message = typeof payload.error.message === "string" ? payload.error.message : "";
    if (code !== "upstream_text_reply" && message !== "The upstream service returned text instead of an image.") return response;
    return replacePlaygroundJsonResponse(response, {
        ...payload,
        error: {
            ...payload.error,
            message: "上游生图服务未返回图片，而是返回了文字内容。通常表示本次生成未产出图片、被上游拒绝，或上游账号暂时不可用。请简化提示词后重试；若持续出现，请检查该渠道的生图能力和账号状态。",
            code: "upstream_text_reply",
        },
    });
}

function replacePlaygroundJsonResponse(response: Response, payload: unknown) {
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function installPlaygroundXhrBridge(win: PointsBridgeWindow) {
    const OriginalXHR = win.XMLHttpRequest;
    const WrappedXHR = function () {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open.bind(xhr);
        const originalSend = xhr.send.bind(xhr);
        const originalSetRequestHeader = xhr.setRequestHeader.bind(xhr);
        let method = "GET";
        let url = "";
        let openRest: unknown[] = [];
        const requestHeaders: Array<[string, string]> = [];

        xhr.open = ((requestMethod: string, requestUrl: string | URL, ...rest: unknown[]) => {
            method = requestMethod;
            url = String(requestUrl);
            openRest = rest;
            return (originalOpen as unknown as (...args: unknown[]) => void)(requestMethod, requestUrl, ...rest);
        }) as XMLHttpRequest["open"];

        xhr.setRequestHeader = ((name: string, value: string) => {
            requestHeaders.push([name, value]);
            return originalSetRequestHeader(name, value);
        }) as XMLHttpRequest["setRequestHeader"];

        xhr.send = ((body?: Document | XMLHttpRequestBodyInit | null) => {
            // Agent 模式下完全透传，不重写请求
            if (isPlaygroundInAgentMode()) return originalSend(body);
            const request = rewritePlaygroundImageRequest(url, { method, body: body as BodyInit | null | undefined, headers: requestHeaders });
            const logInput = readPlaygroundGenerationLogInput(request.input, request.init);
            const nextUrl = typeof request.input === "string" ? request.input : getRequestUrl(request.input);
            const nextBody = request.init?.body === undefined ? body : (request.init.body as XMLHttpRequestBodyInit | Document | null);
            if (nextUrl && nextUrl !== url) {
                (originalOpen as unknown as (...args: unknown[]) => void)(method, nextUrl, ...openRest);
                new Headers(request.init?.headers).forEach((value, key) => originalSetRequestHeader(key, value));
            }
            return originalSend(nextBody);
        }) as XMLHttpRequest["send"];

        return xhr;
    } as unknown as typeof win.XMLHttpRequest;
    WrappedXHR.prototype = OriginalXHR.prototype;
    win.XMLHttpRequest = WrappedXHR;
}

async function rewritePlaygroundImageFetchRequest(input: RequestInfo | URL, init?: RequestInit): Promise<{ input: RequestInfo | URL; init?: RequestInit }> {
    const method = String(init?.method || (isRequestLike(input) ? input.method || "GET" : "GET")).toUpperCase();
    const url = getRequestUrl(input);
    const imagePath = readImageRequestPath(url);
    if (method !== "POST" || !imagePath) return { input, init };
    const profile = readActivePlaygroundProfile();
    if (!profile?.baseUrl || !profile.model) return { input, init };
    const body = init?.body !== undefined ? init.body : isRequestObject(input) ? await readRequestBodyForRewrite(input) : undefined;
    if (body === undefined) return { input, init };
    let nextBody = rewritePlaygroundRequestBody(body, profile.model);
    if (isFormDataLike(nextBody)) nextBody = await compressPlaygroundRequestFormData(nextBody);
    const headers = rewritePlaygroundRequestHeaders(input, { ...init, body: nextBody }, profile);
    trackPlaygroundRequestProfile(profile, readPlaygroundRequestPayload(nextBody));
    return { input: buildPlaygroundRequestUrl(profile.baseUrl, imagePath), init: { ...init, method: "POST", headers, body: nextBody } };
}

function rewritePlaygroundImageRequest(input: RequestInfo | URL, init?: RequestInit): { input: RequestInfo | URL; init?: RequestInit } {
    const method = String(init?.method || (isRequestLike(input) ? input.method || "GET" : "GET")).toUpperCase();
    const url = getRequestUrl(input);
    const imagePath = readImageRequestPath(url);
    if (method !== "POST" || !imagePath) return { input, init };
    const profile = readActivePlaygroundProfile();
    if (!profile?.baseUrl || !profile.model) return { input, init };
    const nextBody = rewritePlaygroundRequestBody(init?.body, profile.model);
    trackPlaygroundRequestProfile(profile, readPlaygroundRequestPayload(nextBody));
    const nextInit: RequestInit = { ...init, method: "POST", body: nextBody, headers: rewritePlaygroundRequestHeaders(input, init, profile) };
    return { input: buildPlaygroundRequestUrl(profile.baseUrl, imagePath), init: nextInit };
}

function readImageRequestPath(url: string) {
    const match = url.match(/\/images\/(generations|edits)(?:[?#].*)?$/i);
    return match ? `/images/${match[1]}` : "";
}

function isPlaygroundInAgentMode() {
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    return state.appMode === "agent";
}

function readActivePlaygroundProfile() {
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    const settings = isRecord(state.settings) ? state.settings : {};
    const hostActiveProfileId = readHostActiveProfileId();
    const activeProfileId = typeof settings.activeProfileId === "string" ? settings.activeProfileId : "";
    const profiles = readPlaygroundProfiles(settings.profiles);
    return profiles.find((profile) => profile.id === hostActiveProfileId) || profiles.find((profile) => profile.id === activeProfileId) || profiles[0];
}

function readPlaygroundProfiles(value: unknown) {
    const storedProfiles = Array.isArray(value) ? value.filter((profile): profile is PlaygroundProfile => isRecord(profile) && typeof profile.id === "string" && typeof profile.model === "string") : [];
    const byId = new Map<string, PlaygroundProfile>();
    [...storedProfiles, ...playgroundHostProfilesMemory].forEach((profile) => byId.set(profile.id, profile));
    return Array.from(byId.values());
}

function rewritePlaygroundRequestBody(body: BodyInit | null | undefined, model: string) {
    if (!body) return body;
    if (typeof body === "string") {
        const payload = parseJsonObject(body);
        return Object.keys(payload).length ? JSON.stringify({ ...payload, model }) : body;
    }
    if (isFormDataLike(body)) {
        const next = new FormData();
        body.forEach((value, key) => next.append(key, key === "model" ? model : value));
        if (!next.has("model")) next.set("model", model);
        return next;
    }
    if (isURLSearchParamsLike(body)) {
        const next = new URLSearchParams(body);
        next.set("model", model);
        return next;
    }
    return body;
}

async function compressPlaygroundRequestFormData(body: FormData) {
    const entries: Array<[string, FormDataEntryValue]> = [];
    body.forEach((value, key) => entries.push([key, value]));
    const totalFileBytes = entries.reduce((total, [, value]) => total + (typeof value === "string" ? 0 : value.size), 0);
    const forceCompression = totalFileBytes > PLAYGROUND_REFERENCE_REQUEST_MAX_BYTES;
    if (!forceCompression) return body;

    const next = new FormData();
    for (const [key, value] of entries) {
        if (typeof value === "string" || !value.type.startsWith("image/") || /mask/i.test(key)) {
            next.append(key, value);
            continue;
        }
        const compressed = await compressPlaygroundReferenceImage(value, forceCompression);
        next.append(key, compressed, compressed === value ? value.name : jpegFileName(value.name));
    }
    return next;
}

function jpegFileName(value: string) {
    const name = value.trim() || "reference-image";
    return /\.[a-z0-9]+$/i.test(name) ? name.replace(/\.[a-z0-9]+$/i, ".jpg") : `${name}.jpg`;
}

function rewritePlaygroundRequestHeaders(input: RequestInfo | URL, init: RequestInit | undefined, profile: PlaygroundProfile) {
    const headers = new Headers(init?.headers || (isRequestLike(input) && "headers" in input ? (input as Request).headers : undefined));
    if (profile.apiKey) headers.set("Authorization", `Bearer ${profile.apiKey}`);
    if (isFormDataLike(init?.body)) headers.delete("Content-Type");
    return headers;
}

async function readRequestBodyForRewrite(request: Request): Promise<BodyInit | undefined> {
    const contentType = request.headers.get("content-type") || "";
    const clone = request.clone();
    if (contentType.toLowerCase().includes("multipart/form-data")) return clone.formData();
    if (contentType.toLowerCase().includes("application/x-www-form-urlencoded")) return new URLSearchParams(await clone.text());
    return clone.text();
}

function isRequestObject(value: unknown): value is Request {
    return Boolean(value && typeof value === "object" && typeof (value as Request).clone === "function" && typeof (value as Request).headers?.get === "function");
}

function isFormDataLike(value: unknown): value is FormData {
    return Boolean(value && typeof value === "object" && typeof (value as FormData).forEach === "function" && typeof (value as FormData).append === "function" && typeof (value as FormData).has === "function");
}

function isURLSearchParamsLike(value: unknown): value is URLSearchParams {
    return Boolean(value && typeof value === "object" && typeof (value as URLSearchParams).set === "function" && typeof (value as URLSearchParams).entries === "function" && String(value).includes("="));
}

function buildPlaygroundRequestUrl(baseUrl: string, path: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    const apiBase = /\/(v1|api\/v3|api\/plan\/v3)$/i.test(normalized) ? normalized : `${normalized}/v1`;
    return `${apiBase}${path}`;
}

function isSystemPointsRequest(input: RequestInfo | URL, init?: RequestInit) {
    const method = String(init?.method || (isRequestLike(input) ? input.method || "GET" : "GET")).toUpperCase();
    return method === "POST" && getRequestUrl(input).includes("/api/ai/system/");
}

type PlaygroundGenerationLogInput = { prompt: string; model: string; count: number; path: string };

function readPlaygroundGenerationLogInput(input: RequestInfo | URL, init?: RequestInit): PlaygroundGenerationLogInput | null {
    const method = String(init?.method || (isRequestLike(input) ? input.method || "GET" : "GET")).toUpperCase();
    if (method !== "POST") return null;
    const path = getRequestUrl(input).toLowerCase();
    if (!path.includes("/images/generations") && !path.includes("/images/edits")) return null;
    const payload = readPlaygroundRequestPayload(init?.body);
    const prompt = String(payload.prompt || payload.input || "").trim();
    const model = String(payload.model || "").trim();
    const count = Math.max(1, Math.min(1000, Math.floor(Number(payload.n ?? payload.count) || 1)));
    return { prompt, model, count, path };
}

function readPlaygroundRequestPayload(body: BodyInit | null | undefined): Record<string, unknown> {
    if (!body) return {};
    if (typeof body === "string") return parseJsonObject(body);
    if (body instanceof FormData) {
        const data: Record<string, unknown> = {};
        body.forEach((value, key) => {
            if (typeof value === "string") data[key] = value;
        });
        return data;
    }
    if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
    return {};
}

async function recordPlaygroundGenerationResult(input: PlaygroundGenerationLogInput, response: Response, durationMs: number) {
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType && !contentType.toLowerCase().includes("json")) return;
    const payload = await response.json().catch(() => null);
    const assets = extractPlaygroundImageAssets(payload);
    const error = readPlaygroundResponseError(payload);
    await recordGenerationLog({
        kind: "image",
        source: "image-workbench",
        status: response.ok && assets.length > 0 ? "success" : "failed",
        title: input.prompt.slice(0, 36) || "\u751f\u56fe\u4efb\u52a1",
        prompt: input.prompt,
        model: input.model,
        count: input.count,
        successCount: assets.length,
        failCount: response.ok ? Math.max(0, input.count - assets.length) : input.count,
        durationMs,
        summary: response.ok ? `\u751f\u6210 ${assets.length || 0} \u5f20\u56fe\u7247` : "\u751f\u6210\u5931\u8d25",
        assets,
        error: response.ok ? undefined : error || `HTTP ${response.status}`,
    }).catch(() => undefined);
}

function extractPlaygroundImageAssets(payload: unknown) {
    if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
    return payload.data
        .map((item) => {
            if (!isRecord(item)) return "";
            if (typeof item.url === "string") return item.url;
            if (typeof item.b64_json === "string") return `data:image/png;base64,${item.b64_json}`;
            return "";
        })
        .filter(Boolean)
        .slice(0, 6)
        .map((url) => ({ type: "image" as const, url }));
}

function readPlaygroundResponseError(payload: unknown) {
    if (!isRecord(payload)) return "";
    const error = isRecord(payload.error) ? payload.error.message : undefined;
    return typeof error === "string" ? error : typeof payload.msg === "string" ? payload.msg : "";
}

function parseJsonObject(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function getRequestUrl(input: RequestInfo | URL) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return isRequestLike(input) ? input.url : "";
}

function isRequestLike(value: unknown): value is { url: string; method?: string } {
    return Boolean(value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string");
}

function syncUserPointsFromResponse(response: Response) {
    const remaining = Number(response.headers.get("x-xsvo-points-remaining"));
    if (!Number.isFinite(remaining)) return;
    const user = useUserStore.getState().user;
    if (user) useUserStore.getState().setUser({ ...user, pointsBalance: remaining });
}

function installPlaygroundModelPicker(doc: Document | null | undefined, profiles: PlaygroundProfile[], onChange: (profileId: string) => void) {
    if (!doc) return;
    if (isPlaygroundInAgentMode()) {
        // Agent 模式下隐藏注入的元素（不 remove，避免破坏 React DOM 树）
        const picker = doc.querySelector<HTMLElement>('[data-xsvo-model-picker="1"]');
        if (picker) picker.style.display = "none";
        const cost = doc.querySelector<HTMLElement>('[data-xsvo-points-cost="1"]');
        if (cost) cost.style.display = "none";
        return;
    }
    // 画廊模式下恢复显示
    const picker = doc.querySelector<HTMLElement>('[data-xsvo-model-picker="1"]');
    if (picker) picker.style.display = "";
    const cost = doc.querySelector<HTMLElement>('[data-xsvo-points-cost="1"]');
    if (cost) cost.style.display = "";
    playgroundHostProfilesMemory = profiles;
    const usableProfiles = profiles.filter((profile) => isUsableProfile(profile) && modelMatchesCapability(profile.model, "image"));
    const buttons = doc.querySelectorAll<HTMLButtonElement>('button[aria-label="生成图像"], button[aria-label="遮罩编辑"], button[aria-label="停止生成"], button[aria-label="请先配置 API"]');
    if (!buttons.length) return;
    installModelPickerOutsideClose(doc);

    buttons.forEach((button) => {
        const submitWrap = button.closest("div.relative") as HTMLElement | null;
        const actions = submitWrap?.parentElement;
        const view = doc.defaultView;
        if (!actions || !view) return;
        const target = ensurePlaygroundComposerMetaActions(doc, actions, view);
        const existing = doc.querySelector<HTMLElement>('[data-xsvo-model-picker="1"]');
        if (!usableProfiles.length) {
            if (existing) existing.style.display = "none";
            return;
        }

        const currentProfileId = readActivePlaygroundProfileId(usableProfiles);
        if (currentProfileId && readStoredPlaygroundActiveProfileId() !== currentProfileId) switchPlaygroundProfile(currentProfileId);
        const signature = usableProfiles.map((profile) => `${profile.id}:${profile.name}:${profile.model}`).join("|");
        const wrapper = existing || doc.createElement("div");
        wrapper.dataset.xsvoModelPicker = "1";
        wrapper.className = "relative z-[90] mb-0.5 flex shrink-0 items-center gap-2 self-center";
        if (wrapper.dataset.xsvoModelSignature !== signature) {
            wrapper.innerHTML = `<span class="text-sm font-medium text-gray-500 dark:text-gray-400">模型</span><div class="relative"><button type="button" data-xsvo-model-trigger="1" class="inline-flex h-9 min-w-[13.75rem] max-w-[16rem] items-center justify-between gap-2 rounded-full border border-gray-200 bg-white px-3 text-sm font-medium text-gray-600 shadow-sm outline-none transition hover:border-gray-300 hover:bg-gray-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08]"><span data-xsvo-model-label="1" class="min-w-0 truncate text-left"></span><svg data-xsvo-model-arrow="1" class="h-4 w-4 shrink-0 text-gray-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 9l6 6 6-6"/></svg></button><div data-xsvo-model-menu="1" class="absolute hidden w-[17rem] overflow-hidden rounded-xl border border-gray-200/80 bg-white py-1 text-sm shadow-xl ring-1 ring-black/5 dark:border-white/10 dark:bg-gray-900 dark:ring-white/10" style="right:0;bottom:calc(100% + 8px);z-index:9999;"></div></div>`;
        }
        wrapper.dataset.xsvoModelSignature = signature;
        syncPlaygroundModelPicker(wrapper, usableProfiles, currentProfileId, onChange);
        if (wrapper.parentElement !== target) {
            const pointsBadge = target.querySelector<HTMLElement>('[data-xsvo-points-cost="1"]');
            target.insertBefore(wrapper, pointsBadge || target.firstElementChild);
        }
    });
}

function ensurePlaygroundComposerMetaActions(doc: Document, fallbackActions: HTMLElement, view: Window) {
    const existing = doc.querySelector<HTMLElement>('[data-xsvo-composer-meta-actions="1"]');
    if (existing) return existing;
    const uploadRow = findPlaygroundUploadRow(doc, view);
    if (!uploadRow) return ensureFallbackComposerMetaActions(doc, fallbackActions, view);
    uploadRow.dataset.xsvoUploadRow = "1";
    uploadRow.style.display = "flex";
    uploadRow.style.alignItems = "center";
    uploadRow.style.justifyContent = "space-between";
    uploadRow.style.gap = "12px";
    uploadRow.style.width = "100%";
    const group = doc.createElement("div");
    group.dataset.xsvoComposerMetaActions = "1";
    group.className = "ml-auto flex shrink-0 items-center gap-2";
    uploadRow.appendChild(group);
    return group;
}

function ensureFallbackComposerMetaActions(doc: Document, fallbackActions: HTMLElement, view: Window) {
    const parameterRow = findPlaygroundParameterRow(fallbackActions, view);
    const existing = parameterRow?.parentElement?.querySelector<HTMLElement>('[data-xsvo-composer-meta-actions="1"]');
    if (existing) return existing;
    if (!parameterRow?.parentElement) return fallbackActions;
    const row = doc.createElement("div");
    row.dataset.xsvoComposerMetaRow = "1";
    row.className = "mb-2 flex w-full items-center justify-end gap-2 px-1";
    const group = doc.createElement("div");
    group.dataset.xsvoComposerMetaActions = "1";
    group.className = "ml-auto flex shrink-0 items-center gap-2";
    row.appendChild(group);
    parameterRow.parentElement.insertBefore(row, parameterRow);
    return group;
}

function findPlaygroundParameterRow(actions: HTMLElement, view: Window) {
    let current: HTMLElement | null = actions;
    for (let index = 0; index < 8 && current; index++) {
        const text = current.textContent || "";
        if (/尺寸|质量|格式|透明背景|审核|数量/.test(text)) return current;
        const parent = current.parentElement;
        current = parent instanceof view.HTMLElement ? parent : null;
    }
    return actions.parentElement instanceof view.HTMLElement ? actions.parentElement : actions;
}

function findPlaygroundUploadRow(doc: Document, view: Window) {
    const label = Array.from(doc.querySelectorAll<HTMLElement>("span,div,label,p")).find((element) => element.textContent?.includes("不上传图集"));
    if (!label) return null;
    let current: HTMLElement = label;
    let best: HTMLElement = label;
    for (let index = 0; index < 8; index++) {
        const parent = current.parentElement;
        if (!parent || !(parent instanceof view.HTMLElement)) break;
        const text = parent.textContent || "";
        if (!text.includes("不上传图集") || /尺寸|质量|格式|透明背景|审核|数量/.test(text)) break;
        best = parent;
        current = parent;
    }
    return best;
}

function syncPlaygroundModelPicker(wrapper: HTMLElement, profiles: PlaygroundProfile[], activeProfileId: string, onChange: (profileId: string) => void) {
    const doc = wrapper.ownerDocument;
    const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || profiles[0];
    const label = wrapper.querySelector<HTMLElement>('[data-xsvo-model-label="1"]');
    const labelText = activeProfile?.name || activeProfile?.model || "选择模型";
    if (label && label.textContent !== labelText) label.textContent = labelText;
    const trigger = wrapper.querySelector<HTMLButtonElement>('[data-xsvo-model-trigger="1"]');
    const menu = wrapper.querySelector<HTMLElement>('[data-xsvo-model-menu="1"]');
    const arrow = wrapper.querySelector<HTMLElement>('[data-xsvo-model-arrow="1"]');
    if (!trigger || !menu) return;
    const open = wrapper.dataset.xsvoModelOpen === "1";
    menu.classList.toggle("hidden", !open);
    arrow?.classList.toggle("rotate-180", open);
    if (menu.dataset.xsvoMenuSignature !== wrapper.dataset.xsvoModelSignature) {
        menu.replaceChildren(
            ...profiles.map((profile) => {
                const item = doc.createElement("button");
                item.type = "button";
                item.dataset.xsvoModelOption = profile.id;
                item.className = "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left font-medium text-gray-700 transition hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-white/[0.08]";
                item.innerHTML = `<span class="min-w-0 truncate"></span>`;
                item.querySelector("span")!.textContent = profile.name || profile.model;
                item.onclick = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    wrapper.dataset.xsvoModelOpen = "0";
                    onChange(profile.id);
                    syncPlaygroundModelPicker(wrapper, profiles, profile.id, onChange);
                };
                return item;
            }),
        );
        menu.dataset.xsvoMenuSignature = wrapper.dataset.xsvoModelSignature || "";
    }
    menu.querySelectorAll<HTMLButtonElement>("[data-xsvo-model-option]").forEach((item) => {
        const active = item.dataset.xsvoModelOption === activeProfileId;
        item.classList.toggle("bg-blue-50", active);
        item.classList.toggle("text-blue-600", active);
        item.classList.toggle("dark:bg-blue-500/10", active);
        item.classList.toggle("dark:text-blue-300", active);
    });
    trigger.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextOpen = wrapper.dataset.xsvoModelOpen !== "1";
        wrapper.ownerDocument.querySelectorAll<HTMLElement>('[data-xsvo-model-picker="1"]').forEach((item) => (item.dataset.xsvoModelOpen = "0"));
        wrapper.dataset.xsvoModelOpen = nextOpen ? "1" : "0";
        syncPlaygroundModelPicker(wrapper, profiles, activeProfileId, onChange);
    };
}

function installModelPickerOutsideClose(doc: Document) {
    if (!doc.body || doc.body.dataset.xsvoModelPickerOutside === "1") return;
    const view = doc.defaultView;
    if (!view) return;
    doc.body.dataset.xsvoModelPickerOutside = "1";
    doc.addEventListener("pointerdown", (event) => {
        const target = event.target;
        if (target instanceof view.Element && target.closest('[data-xsvo-model-picker="1"]')) return;
        doc.querySelectorAll<HTMLElement>('[data-xsvo-model-picker="1"]').forEach((item) => {
            item.dataset.xsvoModelOpen = "0";
            item.querySelector('[data-xsvo-model-menu="1"]')?.classList.add("hidden");
            item.querySelector('[data-xsvo-model-arrow="1"]')?.classList.remove("rotate-180");
        });
    });
}

function updateActivePlaygroundProfileApiMode(profileId: string, apiMode: PlaygroundProfile["apiMode"]) {
    if (typeof window === "undefined") return;
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    const settings = isRecord(state.settings) ? state.settings : {};
    const profiles = readPlaygroundProfiles(settings.profiles);
    const nextProfiles = profiles.map((profile) => (profile.id === profileId ? { ...profile, apiMode } : profile));
    const activeProfile = nextProfiles.find((profile) => profile.id === profileId);
    if (!activeProfile) return;
    persistHostActiveProfileId(profileId);
    playgroundHostProfilesMemory = nextProfiles;
    window.localStorage.setItem(
        PLAYGROUND_STORE_KEY,
        JSON.stringify({
            ...previous,
            state: {
                ...state,
                settings: {
                    ...settings,
                    profiles: nextProfiles,
                    activeProfileId: profileId,
                    apiMode,
                    baseUrl: activeProfile.baseUrl || "",
                    apiKey: activeProfile.apiKey || "",
                    model: activeProfile.model || "",
                    timeout: normalizePositiveNumber(activeProfile.timeout, 600),
                    codexCli: normalizeBoolean(activeProfile.codexCli, false),
                    responseFormatB64Json: normalizeBoolean(activeProfile.responseFormatB64Json, true),
                    streamImages: normalizeBoolean(activeProfile.streamImages, false),
                    streamPartialImages: normalizeStreamPartialImages(activeProfile.streamPartialImages, 2),
                },
            },
            version: Number(previous.version) || 2,
        }),
    );
}

function isElementVisible(element: HTMLElement) {
    return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function readActivePlaygroundProfileId(profiles: PlaygroundProfile[]) {
    const hostActiveProfileId = readHostActiveProfileId();
    if (profiles.some((profile) => profile.id === hostActiveProfileId)) return hostActiveProfileId;
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    const settings = isRecord(state.settings) ? state.settings : {};
    const activeProfileId = typeof settings.activeProfileId === "string" ? settings.activeProfileId : "";
    return profiles.some((profile) => profile.id === activeProfileId) ? activeProfileId : profiles[0]?.id || "";
}

function readStoredPlaygroundActiveProfileId() {
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    const settings = isRecord(state.settings) ? state.settings : {};
    return typeof settings.activeProfileId === "string" ? settings.activeProfileId : "";
}

function switchPlaygroundProfile(profileId: string) {
    if (typeof window === "undefined") return;
    persistHostActiveProfileId(profileId);
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    const settings = isRecord(state.settings) ? state.settings : {};
    const profiles = readPlaygroundProfiles(settings.profiles);
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    window.localStorage.setItem(
        PLAYGROUND_STORE_KEY,
        JSON.stringify({
            ...previous,
            state: {
                ...state,
                settings: {
                    ...settings,
                    activeProfileId: profile.id,
                    baseUrl: profile.baseUrl || "",
                    apiKey: profile.apiKey || "",
                    model: profile.model || "",
                    apiMode: profile.apiMode || "images",
                    timeout: normalizePositiveNumber(profile.timeout, 600),
                    codexCli: normalizeBoolean(profile.codexCli, false),
                    responseFormatB64Json: normalizeBoolean(profile.responseFormatB64Json, true),
                    streamImages: normalizeBoolean(profile.streamImages, false),
                    streamPartialImages: normalizeStreamPartialImages(profile.streamPartialImages, 2),
                },
            },
            version: Number(previous.version) || 2,
        }),
    );
}

function installPointsCostBadge(doc: Document | null | undefined, cost: number) {
    if (!doc) return;
    if (isPlaygroundInAgentMode()) return;
    const buttons = doc.querySelectorAll<HTMLButtonElement>('button[aria-label="生成图像"], button[aria-label="遮罩编辑"], button[aria-label="停止生成"], button[aria-label="请先配置 API"]');
    if (!buttons.length) return;

    buttons.forEach((button) => {
        const submitWrap = button.closest("div.relative") as HTMLElement | null;
        const actions = submitWrap?.parentElement;
        if (!actions) return;
        const view = doc.defaultView;
        if (!view) return;
        const target = ensurePlaygroundComposerMetaActions(doc, actions, view);
        const existing = doc.querySelector<HTMLElement>('[data-xsvo-points-cost="1"]');
        if (cost <= 0) {
            if (existing) existing.style.display = "none";
            return;
        }
        const badge = existing || doc.createElement("span");
        badge.dataset.xsvoPointsCost = "1";
        badge.className = "mb-0.5 inline-flex h-8 shrink-0 items-center self-center rounded-full bg-gray-100/90 px-3 text-xs font-semibold text-gray-500 shadow-sm dark:bg-white/[0.08] dark:text-gray-300";
        badge.textContent = `预计 ${cost.toLocaleString()} 积分`;
        const modelPicker = target.querySelector<HTMLElement>('[data-xsvo-model-picker="1"]');
        if (modelPicker && badge.previousElementSibling !== modelPicker) target.insertBefore(badge, modelPicker.nextSibling);
        else if (badge.parentElement !== target) target.insertBefore(badge, target.firstElementChild);
    });
}

function trackPlaygroundRequestProfile(profile: PlaygroundProfile, payload: Record<string, unknown>) {
    const prompt = String(payload.prompt || payload.input || "").trim();
    if (!prompt) return;
    patchLatestPlaygroundTaskProfile(profile, prompt);
    const now = Date.now();
    recentPlaygroundRequestHints = [{ profile, prompt, createdAt: now }, ...recentPlaygroundRequestHints.filter((hint) => now - hint.createdAt < 10 * 60 * 1000)].slice(0, 20);
}

function patchLatestPlaygroundTaskProfile(profile: PlaygroundProfile, prompt: string) {
    if (typeof window === "undefined") return;
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const now = Date.now();
    const candidates = tasks
        .map((task, index) => ({ task, index }))
        .filter(({ task }) => {
            if (!isRecord(task)) return false;
            if (stringRecordValue(task, "prompt") !== prompt) return false;
            const createdAt = Number(task.createdAt);
            if (!Number.isFinite(createdAt) || now - createdAt > 30 * 1000) return false;
            const status = stringRecordValue(task, "status");
            return !status || status === "running" || status === "error";
        })
        .sort((a, b) => Number(isRecord(b.task) ? b.task.createdAt : 0) - Number(isRecord(a.task) ? a.task.createdAt : 0));
    const target = candidates.find(({ task }) => isRecord(task) && stringRecordValue(task, "xsvoRequestProfileId") !== profile.id) || candidates[0];
    if (!target || !isRecord(target.task)) return;
    const nextTasks = [...tasks];
    nextTasks[target.index] = {
        ...target.task,
        apiProvider: profile.provider || "openai",
        apiProfileId: profile.id,
        apiProfileName: profile.name || profile.model,
        apiMode: profile.apiMode || "images",
        apiModel: profile.model,
        xsvoRequestProfileId: profile.id,
    };
    try {
        window.localStorage.setItem(PLAYGROUND_STORE_KEY, JSON.stringify({ ...previous, state: { ...state, tasks: nextTasks } }));
    } catch {
        // Task label correction is best-effort; request routing already used the selected profile.
    }
}

function correctPlaygroundTaskModelBadges(doc: Document | null | undefined) {
    if (!doc) return;
    if (isPlaygroundInAgentMode()) return;
    const taskProfileMap = readPlaygroundTaskProfileMap();
    if (!playgroundHostProfilesMemory.length && !taskProfileMap.size) return;
    const taskProfiles = Array.from(taskProfileMap.values());
    const profileNames = [...playgroundHostProfilesMemory.map((item) => item.name || item.model), ...taskProfiles.map((item) => item.name || item.model)].filter(Boolean);
    const modelNames = [...playgroundHostProfilesMemory.map((item) => item.model), ...taskProfiles.map((item) => item.model)].filter(Boolean);
    doc.querySelectorAll<HTMLElement>('[data-tag-scroll-area]').forEach((row) => {
        if (row.closest('[data-xsvo-model-picker="1"], [data-xsvo-library-actions="1"]')) return;
        const chips = Array.from(row.children).filter((child) => child.tagName.toLowerCase() === "span") as HTMLElement[];
        if (!chips.length) return;
        const modelChips = chips.filter((chip) => isLikelyPlaygroundTaskModelText((chip.textContent || "").trim(), profileNames, modelNames));
        const firstChip = modelChips.length && chips[0] !== modelChips[0] && !isLikelyPlaygroundParamChip(chips[0]) ? chips[0] : modelChips[0] || (isLikelyPlaygroundTaskProviderChip(chips[0], profileNames) ? chips[0] : null);
        if (!firstChip) return;
        const card = findTaskCardFromMetaRow(row);
        if (!card) return;
        const profile = resolveStoredTaskCardProfile(card, row, firstChip, taskProfileMap) || (readTaskCardId(card) ? null : resolveTaskCardRequestProfile(card));
        if (!profile) return;
        const label = profile.name || profile.model;
        if (!label.trim()) return;
        setTaskModelChipText(firstChip, label);
        if (firstChip.title !== label) firstChip.title = label;
        if (card.dataset.xsvoTaskProfileId !== profile.id) card.dataset.xsvoTaskProfileId = profile.id;
        if (row.dataset.xsvoTaskProfileId !== profile.id) row.dataset.xsvoTaskProfileId = profile.id;
        if (firstChip.dataset.xsvoTaskModelCorrected !== profile.id) firstChip.dataset.xsvoTaskModelCorrected = profile.id;
        chips.forEach((chip) => {
            if (chip === firstChip) return;
            const text = (chip.textContent || "").trim();
            if ((isLikelyPlaygroundTaskModelText(text, profileNames, modelNames) || isLikelyPlaygroundTaskProviderChip(chip, profileNames)) && chip.style.display !== "none") chip.style.display = "none";
        });
    });
}

function setTaskModelChipText(chip: HTMLElement, label: string) {
    const textNode = Array.from(chip.querySelectorAll<HTMLElement>("span")).at(-1);
    if (textNode) {
        if (textNode.textContent !== label) textNode.textContent = label;
        return;
    }
    if (chip.textContent !== label) chip.textContent = label;
}
function sanitizePlaygroundTaskPromptRefs(doc: Document | null | undefined) {
    if (!doc || isPlaygroundInAgentMode()) return;
    const view = doc.defaultView;
    if (!view) return;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const text = node.nodeValue || "";
            if (!hasPlaygroundRefTag(text)) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent || parent.closest('button, input, textarea, [contenteditable="true"], [data-xsvo-model-picker="1"], [data-xsvo-library-actions="1"], [data-tag-scroll-area]')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    nodes.forEach((node) => {
        const next = displayPlaygroundUserPrompt(node.nodeValue || "");
        if (next && next !== node.nodeValue) node.nodeValue = next;
    });
}

function displayPlaygroundUserPrompt(text: string) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!hasPlaygroundRefTag(normalized)) return normalized;
    const patterns = [/<ref\b[^>]*\/\s*>/gi, /&lt;ref\b[\s\S]*?\/\s*&gt;/gi];
    let lastEnd = -1;
    patterns.forEach((pattern) => {
        for (const match of normalized.matchAll(pattern)) {
            const end = (match.index || 0) + match[0].length;
            if (end > lastEnd) lastEnd = end;
        }
    });
    const currentInput = lastEnd >= 0 ? normalized.slice(lastEnd).trim() : "";
    const withoutTags = patterns.reduce((value, pattern) => value.replace(pattern, " "), normalized).replace(/\s+/g, " ").trim();
    return currentInput || withoutTags;
}

function hasPlaygroundRefTag(text: string) {
    return /<ref\b/i.test(text) || /&lt;ref\b/i.test(text);
}

function isLikelyPlaygroundTaskModelText(text: string, profileNames: string[], modelNames: string[]) {
    if (!text || text.length > 100) return false;
    if (modelNames.some((model) => model && text.includes(model))) return true;
    if (profileNames.some((name) => name && (text.includes(name.slice(0, Math.min(name.length, 24))) || name.includes(text)))) return true;
    return /gpt-image|gemini|nano\s*banana|seedream|dall-e|imagen|flux|默认渠道|渠道/i.test(text);
}

function isLikelyPlaygroundTaskProviderChip(chip: HTMLElement | undefined, profileNames: string[]) {
    if (!chip) return false;
    const text = (chip.textContent || "").trim();
    if (!text || text.length > 60) return false;
    if (isLikelyPlaygroundParamChip(chip)) return false;
    return profileNames.some((name) => {
        const parts = name.split(/\s*[·|:：()（）\-]\s*|\s+/).map((part) => part.trim()).filter(Boolean);
        return parts.some((part) => part.length >= 2 && text.includes(part));
    });
}

function isLikelyPlaygroundParamChip(chip: HTMLElement | undefined) {
    const text = (chip?.textContent || "").trim();
    return /auto|png|jpg|jpeg|webp|false|true|\d+\s*[xX×]\s*\d+|^\d+$/.test(text);
}

function findTaskCardFromMetaRow(row: HTMLElement) {
    const taskCard = row.closest<HTMLElement>("[data-task-id]");
    if (taskCard) return taskCard;
    let current: HTMLElement | null = row;
    for (let i = 0; i < 8 && current; i++) {
        if (current.querySelector('img[data-image-id], img.saveable-image, button[aria-label]')) return current;
        const text = current.textContent || "";
        if (/生成中|排队|等待|00:\d{2}|0\d:\d{2}|1\d:\d{2}|2\d:\d{2}/.test(text)) return current;
        current = current.parentElement;
    }
    return null;
}

function resolveStoredTaskCardProfile(card: HTMLElement, row: HTMLElement, chip: HTMLElement, taskProfileMap: Map<string, PlaygroundTaskProfileSnapshot>) {
    const taskProfile = taskProfileMap.get(readTaskCardId(card));
    if (taskProfile) return taskProfile;
    const profileId = chip.dataset.xsvoTaskModelCorrected || row.dataset.xsvoTaskProfileId || card.dataset.xsvoTaskProfileId;
    if (!profileId) return null;
    return playgroundHostProfilesMemory.find((profile) => profile.id === profileId) || null;
}

function readTaskCardId(card: HTMLElement) {
    return card.getAttribute("data-task-id") || card.dataset.taskId || "";
}

type PlaygroundTaskProfileSnapshot = Pick<PlaygroundProfile, "id" | "name" | "model">;

function readPlaygroundTaskProfileMap() {
    const map = new Map<string, PlaygroundTaskProfileSnapshot>();
    if (typeof window === "undefined") return map;
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    tasks.forEach((task) => {
        if (!isRecord(task)) return;
        const taskId = stringRecordValue(task, "id");
        if (!taskId) return;
        const profileId = stringRecordValue(task, "apiProfileId");
        const storedProfile = profileId ? playgroundHostProfilesMemory.find((profile) => profile.id === profileId) : null;
        const model = stringRecordValue(task, "apiModel") || storedProfile?.model || "";
        const name = stringRecordValue(task, "apiProfileName") || storedProfile?.name || model;
        if (!name && !model) return;
        map.set(taskId, { id: profileId || storedProfile?.id || `${taskId}:${model || name}`, name, model });
    });
    return map;
}

function stringRecordValue(record: Record<string, unknown>, key: string) {
    const value = record[key];
    return typeof value === "string" ? value.trim() : "";
}

function resolveTaskCardRequestProfile(card: HTMLElement) {
    const text = card.textContent || "";
    const now = Date.now();
    const hints = recentPlaygroundRequestHints.filter((item) => now - item.createdAt < 10 * 60 * 1000 && item.prompt && text.includes(item.prompt.slice(0, Math.min(24, item.prompt.length))));
    if (!hints.length) return null;
    const elapsedMs = readTaskCardElapsedMs(text);
    if (elapsedMs == null) return hints.length === 1 ? hints[0].profile : null;
    const estimatedCreatedAt = now - elapsedMs;
    const hint = hints.slice().sort((a, b) => Math.abs(a.createdAt - estimatedCreatedAt) - Math.abs(b.createdAt - estimatedCreatedAt))[0];
    return hint.profile;
}

function readTaskCardElapsedMs(text: string) {
    const match = text.match(/\b(\d{1,2}:)?\d{1,2}:\d{2}\b/);
    if (!match) return null;
    const parts = match[0].split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    return seconds * 1000;
}


type PromptExpandElements = {
    shell: HTMLElement | null;
    card: HTMLElement | null;
    editorWrap: HTMLElement | null;
    editor: HTMLElement;
    mobileHandle: HTMLElement | null;
};

function installPlaygroundPromptExpander(doc: Document | null | undefined) {
    const view = doc?.defaultView;
    const editor = doc?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!doc || !view || !editor) return;
    // Agent 模式下跳过：hideNativePromptExpandButtons 会修改 React 管理的按钮 style，
    // 且 bindPromptExpandEditorEvents 的 ResizeObserver 会在 Agent 流式输出时频繁触发
    if (isPlaygroundInAgentMode()) return;
    bindPromptExpandEditorEvents(doc, editor);
    const elements = findPromptExpandElements(editor, view);
    if (!elements.editorWrap) return;

    hideNativePromptExpandButtons(doc);
    const button = ensurePromptExpandButton(doc, elements.editorWrap);

    const expanded = isPromptExpanded(elements);
    const canExpand = shouldShowPromptExpand(editor, expanded);
    const display = canExpand ? "flex" : "none";
    if (button.style.display !== display) button.style.display = display;
    const tooltip = expanded ? "恢复输入框" : "展开输入框";
    if (button.dataset.xsvoTooltip !== tooltip) button.dataset.xsvoTooltip = tooltip;
    if (button.getAttribute("aria-label") !== tooltip) button.setAttribute("aria-label", tooltip);
    const pressed = String(expanded);
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    const icon = expanded ? collapseIconSvg() : expandIconSvg();
    if (button.innerHTML !== icon) button.innerHTML = icon;
    if (!canExpand) hidePromptExpandTooltip(doc);
    button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const pointerToggledAt = Number(button.dataset.xsvoPointerToggledAt || 0);
        if (pointerToggledAt && Date.now() - pointerToggledAt < 500) {
            delete button.dataset.xsvoPointerToggledAt;
            return;
        }
        togglePromptExpanded(doc);
    };
}

function togglePromptExpanded(doc: Document) {
    const view = doc.defaultView;
    const freshEditor = doc.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!view || !freshEditor) return;
    const freshElements = findPromptExpandElements(freshEditor, view);
    setPromptExpanded(doc, freshElements, !isPromptExpanded(freshElements));
    view.requestAnimationFrame(() => installPlaygroundPromptExpander(doc));
}

function isPromptExpanded(elements: PromptExpandElements) {
    return [elements.shell, elements.card, elements.editorWrap, elements.editor].some((element) => element?.dataset.xsvoPromptExpanded === "1");
}

function hideNativePromptExpandButtons(doc: Document) {
    doc.querySelectorAll<HTMLButtonElement>('button[aria-label="展开输入框"], button[aria-label="恢复输入框"]').forEach((button) => {
        if (button.dataset.xsvoPromptExpand !== "1") button.style.display = "none";
    });
}

function shouldShowPromptExpand(editor: HTMLElement, expanded: boolean) {
    if (expanded) return true;
    const text = getPromptEditorPlainText(editor);
    const lineCount = text.split(/\r?\n/).length;
    return editor.scrollHeight > editor.clientHeight + 2 || lineCount > 2 || text.length > 160;
}

function getPromptEditorPlainText(editor: HTMLElement) {
    return (editor.innerText || editor.textContent || "").replace(/\r\n?/g, "\n").trim();
}

function bindPromptExpandEditorEvents(doc: Document, editor: HTMLElement) {
    if (editor.dataset.xsvoPromptExpandBound === "1") return;
    const view = doc.defaultView;
    if (!view) return;
    editor.dataset.xsvoPromptExpandBound = "1";
    let frame = 0;
    const refresh = () => {
        if (frame) view.cancelAnimationFrame(frame);
        frame = view.requestAnimationFrame(() => {
            frame = 0;
            installPlaygroundPromptExpander(doc);
        });
    };
    ["input", "keyup", "paste", "cut", "compositionend"].forEach((eventName) => editor.addEventListener(eventName, refresh));
    view.addEventListener("resize", refresh);
    if (typeof view.ResizeObserver === "function") {
        const observer = new view.ResizeObserver(refresh);
        observer.observe(editor);
        editor.dataset.xsvoPromptExpandResizeObserver = "1";
    }
}

function findPromptExpandElements(editor: HTMLElement, view: Window): PromptExpandElements {
    const editorWrap = editor.parentElement instanceof view.HTMLElement ? editor.parentElement : null;
    let card: HTMLElement | null = editorWrap;
    for (let i = 0; i < 8 && card; i++) {
        const className = card.className.toString();
        if (className.includes("backdrop-blur") && className.includes("rounded")) break;
        card = card.parentElement instanceof view.HTMLElement ? card.parentElement : null;
    }
    let shell: HTMLElement | null = card;
    for (let i = 0; i < 8 && shell; i++) {
        const style = view.getComputedStyle(shell);
        if (style.position === "fixed") break;
        shell = shell.parentElement instanceof view.HTMLElement ? shell.parentElement : null;
    }
    const mobileHandle = card
        ? Array.from(card.children).find((child): child is HTMLElement => child instanceof view.HTMLElement && child.className.toString().includes("touch-none") && child.className.toString().includes("cursor-pointer")) || null
        : null;
    return { shell, card, editorWrap, editor, mobileHandle };
}

function ensurePromptExpandButton(doc: Document, editorWrap: HTMLElement) {
    const existing = editorWrap.querySelector<HTMLButtonElement>('button[data-xsvo-prompt-expand="1"]');
    if (existing) return existing;
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.xsvoPromptExpand = "1";
    button.className = "absolute bottom-2.5 right-2.5 z-20 hidden items-center justify-center rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:outline-none dark:hover:bg-white/[0.08] dark:hover:text-gray-200";
    button.addEventListener("mouseenter", () => showPromptExpandTooltip(button));
    button.addEventListener("mouseleave", () => hidePromptExpandTooltip(doc));
    button.addEventListener("focus", () => showPromptExpandTooltip(button));
    button.addEventListener("blur", () => hidePromptExpandTooltip(doc));
    button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.dataset.xsvoPointerToggledAt = String(Date.now());
        hidePromptExpandTooltip(doc);
        togglePromptExpanded(doc);
    });
    editorWrap.appendChild(button);
    return button;
}

function setPromptExpanded(doc: Document, elements: PromptExpandElements, expanded: boolean) {
    const header = doc.querySelector<HTMLElement>("header");
    if (expanded) {
        const top = Math.max(0, header?.getBoundingClientRect().bottom || 0) + 8;
        rememberStyle(elements.shell, "xsvoOldStyle");
        rememberStyle(elements.card, "xsvoOldStyle");
        rememberStyle(elements.editorWrap, "xsvoOldStyle");
        rememberStyle(elements.editor, "xsvoOldStyle");
        rememberStyle(elements.mobileHandle, "xsvoOldStyle");
        [elements.shell, elements.card, elements.editorWrap, elements.editor].forEach((element) => {
            if (element) element.dataset.xsvoPromptExpanded = "1";
        });
        if (elements.shell) {
            elements.shell.style.position = "fixed";
            elements.shell.style.display = "flex";
            elements.shell.style.flexDirection = "column";
            elements.shell.style.top = `${top}px`;
            elements.shell.style.bottom = "12px";
            elements.shell.style.transitionProperty = "none";
        }
        if (elements.card) {
            elements.card.style.display = "flex";
            elements.card.style.flexDirection = "column";
            elements.card.style.minHeight = "0";
            elements.card.style.flex = "1 1 auto";
        }
        if (elements.editorWrap) {
            elements.editorWrap.style.minHeight = "0";
            elements.editorWrap.style.flex = "1 1 auto";
        }
        elements.editor.style.setProperty("height", "100%", "important");
        elements.editor.style.setProperty("overflow-y", "auto", "important");
        if (elements.mobileHandle) elements.mobileHandle.style.display = "none";
        return;
    }
    restoreStyle(elements.mobileHandle, "xsvoOldStyle");
    restoreStyle(elements.editor, "xsvoOldStyle");
    restoreStyle(elements.editorWrap, "xsvoOldStyle");
    restoreStyle(elements.card, "xsvoOldStyle");
    restoreStyle(elements.shell, "xsvoOldStyle");
    [elements.shell, elements.card, elements.editorWrap, elements.editor].forEach((element) => {
        if (element) delete element.dataset.xsvoPromptExpanded;
    });
}

function rememberStyle(element: HTMLElement | null, key: string) {
    if (!element || element.dataset[key]) return;
    element.dataset[key] = element.getAttribute("style") || "";
}

function restoreStyle(element: HTMLElement | null, key: string) {
    if (!element) return;
    const previous = element.dataset[key];
    if (previous === undefined) return;
    if (previous) element.setAttribute("style", previous);
    else element.removeAttribute("style");
    delete element.dataset[key];
}

function showPromptExpandTooltip(button: HTMLButtonElement) {
    const doc = button.ownerDocument;
    hidePromptExpandTooltip(doc);
    const tooltip = doc.createElement("div");
    tooltip.dataset.xsvoPromptExpandTooltip = "1";
    tooltip.className = "fixed pointer-events-none rounded-lg bg-gray-800 px-3 py-2 text-xs font-normal text-white shadow-lg whitespace-nowrap";
    tooltip.style.zIndex = "120";
    tooltip.style.visibility = "hidden";
    tooltip.textContent = button.dataset.xsvoTooltip || "展开输入框";
    const arrow = doc.createElement("div");
    arrow.className = "absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-gray-800";
    tooltip.appendChild(arrow);
    doc.body.appendChild(tooltip);
    const view = doc.defaultView;
    if (!view) return;
    const rect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const left = Math.min(Math.max(rect.left + rect.width / 2 - tooltipRect.width / 2, margin), Math.max(margin, view.innerWidth - tooltipRect.width - margin));
    const aboveTop = rect.top - tooltipRect.height - gap;
    const placeTop = aboveTop >= margin;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${placeTop ? aboveTop : rect.bottom + gap}px`;
    if (!placeTop) arrow.className = "absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-gray-800";
    tooltip.style.visibility = "visible";
}

function hidePromptExpandTooltip(doc: Document | null | undefined) {
    doc?.querySelector('[data-xsvo-prompt-expand-tooltip="1"]')?.remove();
}

function expandIconSvg() {
    return '<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
}

function collapseIconSvg() {
    return '<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
}
type PlaygroundHeaderActions = {
    onOpenPromptLibrary: () => void;
    onOpenAssets: () => void;
};

function insertTextIntoPlaygroundPrompt(doc: Document | null | undefined, text: string) {
    const editor = doc?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!doc || !editor) return false;
    const insertText = text.trim();
    if (!insertText) return false;
    editor.focus();

    const selection = doc.getSelection();
    if (selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
        const range = selection.getRangeAt(0);
        const prefix = shouldPrefixWithLineBreak(editor, range) ? "\n" : "";
        range.deleteContents();
        const node = doc.createTextNode(`${prefix}${insertText}`);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    } else {
        const prefix = editor.textContent?.trim() ? "\n" : "";
        editor.appendChild(doc.createTextNode(`${prefix}${insertText}`));
        const range = doc.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
    }

    const InputEventCtor = doc.defaultView?.InputEvent || InputEvent;
    editor.dispatchEvent(new InputEventCtor("input", { bubbles: true, inputType: "insertText", data: insertText }));
    return true;
}

function shouldPrefixWithLineBreak(editor: HTMLElement, range: Range) {
    const before = range.cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().trim().length > 0;
}

async function dropImageAssetIntoPlayground(doc: Document | null | undefined, payload: Extract<InsertAssetPayload, { kind: "image" }>) {
    if (!doc) throw new Error("生图工作台还未加载完成");
    const file = await imageAssetPayloadToFile(payload, doc.defaultView);
    const DataTransferCtor = doc.defaultView?.DataTransfer || DataTransfer;
    const DragEventCtor = doc.defaultView?.DragEvent || DragEvent;
    const dataTransfer = new DataTransferCtor();
    dataTransfer.items.add(file);
    const event = new DragEventCtor("drop", { bubbles: true, cancelable: true, dataTransfer });
    doc.dispatchEvent(event);
}

async function imageAssetPayloadToFile(payload: Extract<InsertAssetPayload, { kind: "image" }>, view: Window | null) {
    const response = await fetch(payload.dataUrl);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("素材不是有效图片");
    const extension = blob.type.split("/")[1] || "png";
    const FileCtor = view?.File || File;
    return new FileCtor([blob], `${sanitizeFileName(payload.title) || "asset"}.${extension}`, { type: blob.type });
}

function sanitizeFileName(value: string) {
    return value.trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
}

async function compressPlaygroundReferenceImage(blob: Blob, force = false) {
    if (!blob.type.startsWith("image/") || blob.type === "image/gif" || blob.type === "image/svg+xml") return blob;
    if (!force) return blob;
    const image = await loadBlobImage(blob);
    const maxEdge = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = maxEdge > PLAYGROUND_REFERENCE_IMAGE_MAX_EDGE ? PLAYGROUND_REFERENCE_IMAGE_MAX_EDGE / maxEdge : 1;
    if (scale === 1) return blob;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const nextBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", force ? 0.82 : 0.88));
    return nextBlob && nextBlob.size < blob.size ? nextBlob : blob;
}

function loadBlobImage(blob: Blob) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("图片读取失败"));
        };
        image.src = url;
    });
}

function applyPlaygroundHeaderChrome(doc: Document | null | undefined, actions: PlaygroundHeaderActions) {
    if (isPlaygroundInAgentMode()) return;
    removePlaygroundInstallButton(doc);
    movePlaygroundModeTabsToTitleSlot(doc);
    installPlaygroundLibraryButtons(doc, actions);
}

function removePlaygroundInstallButton(doc: Document | null | undefined) {
    const button = doc?.querySelector<HTMLButtonElement>('button[aria-label="\u5b89\u88c5\u4e3a\u5e94\u7528"]');
    const container = button?.closest("div.relative");
    if (container) container.style.display = "none";
}

function movePlaygroundModeTabsToTitleSlot(doc: Document | null | undefined) {
    const view = doc?.defaultView;
    const headerInner = doc?.querySelector<HTMLElement>("header .safe-header-inner");
    if (!view || !headerInner) return;

    const children = Array.from(headerInner.children).filter((child): child is HTMLElement => child instanceof view.HTMLElement);
    const titleSlot = children.find((child) => child.querySelector("h1"));
    const h1 = titleSlot?.querySelector<HTMLElement>("h1");
    if (h1) h1.style.display = "none";
    if (titleSlot) {
        titleSlot.classList.remove("flex-1");
        titleSlot.style.flex = "0 0 auto";
        titleSlot.style.paddingRight = "0";
        titleSlot.style.minWidth = "0";
    }

    const modeTabs = children.find((child) => {
        const text = child.textContent || "";
        return text.includes("\u753b\u5eca") && text.includes("Agent");
    });
    if (modeTabs) {
        modeTabs.style.display = "";
        modeTabs.style.order = "-1";
        modeTabs.style.marginLeft = "0";
        modeTabs.style.marginRight = "0";
        modeTabs.classList.remove("mr-4");
    }

    const rightActions = children.find((child) => child.classList.contains("shrink-0") && child.querySelector('button[aria-label="\u64cd\u4f5c\u6307\u5357"], button[aria-label="\u8bbe\u7f6e"]'));
    if (rightActions) rightActions.style.marginLeft = "0";
    headerInner.style.justifyContent = "flex-start";
}

function installPlaygroundLibraryButtons(doc: Document | null | undefined, actions: PlaygroundHeaderActions) {
    const view = doc?.defaultView;
    const headerInner = doc?.querySelector<HTMLElement>("header .safe-header-inner");
    if (!doc || !view || !headerInner) return;

    const rightActions = Array.from(headerInner.children).find((child): child is HTMLElement => child instanceof view.HTMLElement && child.classList.contains("shrink-0") && child.querySelector('button[aria-label="\u64cd\u4f5c\u6307\u5357"], button[aria-label="\u8bbe\u7f6e"]'));
    let group = headerInner.querySelector<HTMLElement>('[data-xsvo-library-actions="1"]');
    if (!group) {
        group = doc.createElement("div");
        group.dataset.xsvoLibraryActions = "1";
        group.className = "hidden sm:flex items-center gap-2";
        group.style.marginLeft = "auto";
        group.appendChild(createPlaygroundLibraryButton(doc, "prompt", "查看提示词库", promptIconSvg()));
        group.appendChild(createPlaygroundLibraryButton(doc, "asset", "查看我的素材", assetIconSvg()));
        headerInner.insertBefore(group, rightActions || null);
    }
    group.querySelector<HTMLButtonElement>('button[data-xsvo-library-action="prompt"]')!.onclick = actions.onOpenPromptLibrary;
    group.querySelector<HTMLButtonElement>('button[data-xsvo-library-action="asset"]')!.onclick = actions.onOpenAssets;
}

function createPlaygroundLibraryButton(doc: Document, action: "prompt" | "asset", label: string, icon: string) {
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.xsvoLibraryAction = action;
    button.className = "inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 shadow-sm transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08]";
    button.setAttribute("aria-label", label);
    button.innerHTML = `${icon}<span>${label}</span>`;
    return button;
}

function promptIconSvg() {
    return '<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.25c-2.5-1.5-5-1.5-7.5-.25v12.5c2.5-1.25 5-1.25 7.5.25m0-12.5c2.5-1.5 5-1.5 7.5-.25v12.5c-2.5-1.25-5-1.25-7.5.25m0-12.5v12.5"/></svg>';
}

function assetIconSvg() {
    return '<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7.5h6l2 2h8v8.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7.5Z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 13.5v4m2-2h-4"/></svg>';
}


type PublicSystemSettings = {
    allowUserApiConfig: boolean;
    defaultModels?: {
        imageModel: string;
        videoModel: string;
        textModel: string;
        audioModel: string;
    };
    systemChannels: Array<ModelChannel & { enabled: boolean; hasApiKey: boolean }>;
};

type PlaygroundProfile = {
    id: string;
    name: string;
    channelId?: string;
    managedByHost?: boolean;
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    timeout: number;
    apiMode: "images" | "responses";
    codexCli: boolean;
    apiProxy: boolean;
    responseFormatB64Json: boolean;
    streamImages: boolean;
    streamPartialImages: number;
};

type PlaygroundSettings = {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeout: number;
    apiMode: "images" | "responses";
    codexCli: boolean;
    apiProxy: boolean;
    responseFormatB64Json: boolean;
    streamImages: boolean;
    streamPartialImages: number;
    customProviders: unknown[];
    clearInputAfterSubmit: boolean;
    persistInputOnRestart: boolean;
    reuseTaskApiProfileTemporarily: boolean;
    alwaysShowRetryButton: boolean;
    allowPromptRewrite: boolean;
    taskCompletionNotification: boolean;
    enterSubmit: boolean;
    referenceImageEditAction: "ask";
    zipDownloadRoutes: string[];
    agentScrollToBottomAfterSubmit: boolean;
    agentMaxToolRounds: number;
    agentWebSearch: boolean;
    agentMathFormattingPrompt: boolean;
    agentApiConfigMode: "off" | "native" | "hybrid";
    agentTextProfileId: string | null;
    agentImageProfileId: string | null;
    profiles: PlaygroundProfile[];
    activeProfileId: string;
};

type PlaygroundCostInput = { model: string; count: number; platform: boolean };

function resolveImageWorkbenchConfig(config: AiConfig, systemSettings: PublicSystemSettings | null): AiConfig {
    const canUseCustom = systemSettings?.allowUserApiConfig !== false;
    if (config.apiSource !== "system" && canUseCustom && hasUsableOpenAIImageConfig(config)) return config;

    const systemChannels = (systemSettings?.systemChannels || [])
        .filter((channel) => channel.enabled && channel.hasApiKey && channel.apiFormat === "openai" && channel.models.length)
        .map((channel) => ({ ...channel, baseUrl: toAbsoluteBaseUrl(channel.baseUrl), apiKey: "system", apiFormat: "openai" as const }));
    if (!systemChannels.length) return config;

    const models = systemChannels.flatMap((channel) => channel.models.map((model) => `${channel.id}::${model}`));
    const imageModels = models.filter((model) => modelMatchesCapability(model, "image"));
    const textModels = models.filter((model) => modelMatchesCapability(model, "text"));
    const imageModel = resolveSystemImageModel(config, systemChannels, imageModels, systemSettings?.defaultModels?.imageModel);
    return {
        ...config,
        apiSource: "system",
        channels: systemChannels,
        baseUrl: systemChannels[0]?.baseUrl || config.baseUrl,
        apiKey: "system",
        apiFormat: "openai",
        models,
        imageModel,
        model: imageModel || config.model,
        imageModels,
        textModels,
    };
}

function hasUsableOpenAIImageConfig(config: AiConfig) {
    return collectOpenAIImageChannels(config).some((channel) => channel.baseUrl.trim() && channel.apiKey.trim() && channel.models.length);
}

function resolveSystemImageModel(config: AiConfig, channels: ModelChannel[], imageModels: string[], defaultModel?: string) {
    const current = normalizeModelOptionValue(config.imageModel || config.model, channels);
    if (current && imageModels.includes(current)) return current;
    const defaultValue = normalizeModelOptionValue(defaultModel, channels);
    if (defaultValue && imageModels.includes(defaultValue)) return defaultValue;
    return imageModels[0] || "";
}

function buildPlaygroundSettings(config: AiConfig): PlaygroundSettings {
    const profiles = buildHostProfiles(config);
    const activeModel = config.imageModel || config.model;
    const activeChannel = resolveModelChannel(config, activeModel);
    const activeModelName = modelOptionName(activeModel);
    const activeProfile = profiles.find((profile) => profile.channelId === activeChannel.id && profile.model === activeModelName && isUsableProfile(profile)) || profiles.find((profile) => profile.channelId === activeChannel.id && isUsableProfile(profile)) || profiles.find(isUsableProfile) || profiles[0] || createFallbackProfile(activeModel);

    return {
        baseUrl: activeProfile.baseUrl,
        apiKey: activeProfile.apiKey,
        model: activeProfile.model,
        timeout: activeProfile.timeout,
        apiMode: activeProfile.apiMode,
        codexCli: false,
        apiProxy: false,
        responseFormatB64Json: true,
        streamImages: false,
        streamPartialImages: 2,
        customProviders: [],
        clearInputAfterSubmit: false,
        persistInputOnRestart: true,
        reuseTaskApiProfileTemporarily: false,
        alwaysShowRetryButton: false,
        allowPromptRewrite: false,
        taskCompletionNotification: false,
        enterSubmit: false,
        referenceImageEditAction: "ask",
        zipDownloadRoutes: ["task-selection", "favorite-collection-selection", "image-context-menu-all", "task-detail-all", "task-detail-partial", "agent-round-all"],
        agentScrollToBottomAfterSubmit: true,
        agentMaxToolRounds: 20,
        agentWebSearch: false,
        agentMathFormattingPrompt: true,
        agentApiConfigMode: "off",
        agentTextProfileId: null,
        agentImageProfileId: activeProfile.id,
        profiles: profiles.length ? profiles : [activeProfile],
        activeProfileId: activeProfile.id,
    };
}

function isUsableProfile(profile: PlaygroundProfile) {
    return Boolean(profile.baseUrl.trim() && profile.apiKey.trim() && profile.model.trim());
}

function buildHostProfiles(config: AiConfig): PlaygroundProfile[] {
    const activeModel = config.imageModel || config.model;
    const activeChannel = resolveModelChannel(config, activeModel);
    return collectOpenAIHostChannels(config).flatMap((channel, channelIndex) =>
        channel.models.map((model) => ({
            id: hostProfileId(channel, model),
            channelId: channel.id,
            managedByHost: true,
            name: `${model}${channel.name ? ` · ${channel.name}` : channelIndex === 0 ? " · 默认渠道" : ` · 渠道 ${channelIndex + 1}`}`,
            provider: "openai",
            baseUrl: toAbsoluteBaseUrl(channel.baseUrl || DEFAULT_OPENAI_BASE_URL),
            apiKey: channel.apiKey || "",
            model: activeChannel.id === channel.id && modelOptionName(activeModel) === model ? modelOptionName(activeModel) : model,
            timeout: 600,
            apiMode: modelMatchesCapability(model, "image") ? "images" as const : "responses" as const,
            codexCli: false,
            apiProxy: false,
            responseFormatB64Json: true,
            streamImages: false,
            streamPartialImages: 2,
        })),
    );
}

function hostProfileId(channel: ModelChannel, model: string) {
    return `${channel.id || "default"}::${model}`;
}

function collectOpenAIImageChannels(config: AiConfig): ModelChannel[] {
    const imageModelsByChannel = imageModelMap(config);
    return config.channels
        .filter((channel) => channel.apiFormat === "openai")
        .map((channel) => {
            const imageModels = imageModelsByChannel.get(channel.id);
            return { ...channel, models: imageModels?.length ? imageModels : channel.models };
        })
        .filter((channel) => channel.models.length);
}

function imageModelMap(config: AiConfig) {
    const map = new Map<string, string[]>();
    for (const value of config.imageModels || []) {
        const channel = resolveModelChannel(config, value);
        const model = modelOptionName(value).trim();
        if (!channel.id || !model) continue;
        const list = map.get(channel.id) || [];
        if (!list.includes(model)) list.push(model);
        map.set(channel.id, list);
    }
    return map;
}

function createFallbackProfile(activeModel: string): PlaygroundProfile {
    return {
        id: "default-openai",
        name: "默认渠道",
        provider: "openai",
        baseUrl: DEFAULT_OPENAI_BASE_URL,
        apiKey: "",
        model: modelOptionName(activeModel) || DEFAULT_IMAGE_MODEL,
        timeout: 600,
        apiMode: "images",
        codexCli: false,
        apiProxy: false,
        responseFormatB64Json: true,
        streamImages: false,
        streamPartialImages: 2,
    };
}

function syncPlaygroundSettings(settings: PlaygroundSettings, config: AiConfig) {
    if (typeof window === "undefined") return;
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    const previousSettings = isRecord(state.settings) ? state.settings : {};
    const previousParams = isRecord(state.params) ? state.params : {};
    const nextProfiles = mergePlaygroundProfiles(settings.profiles, previousSettings.profiles);
    playgroundHostProfilesMemory = nextProfiles;
    const hostActiveProfileId = readHostActiveProfileId();
    const previousActiveProfileId = typeof previousSettings.activeProfileId === "string" ? previousSettings.activeProfileId : "";
    const activeProfileId = nextProfiles.some((profile) => profile.id === hostActiveProfileId)
        ? hostActiveProfileId
        : nextProfiles.some((profile) => profile.id === previousActiveProfileId)
          ? previousActiveProfileId
          : nextProfiles.some((profile) => profile.id === settings.activeProfileId)
            ? settings.activeProfileId
            : nextProfiles[0]?.id || "default-openai";
    const activeProfile = nextProfiles.find((profile) => profile.id === activeProfileId) || nextProfiles[0];
    persistHostActiveProfileId(activeProfileId);

    window.localStorage.setItem(
        PLAYGROUND_STORE_KEY,
        JSON.stringify({
            state: {
                ...state,
                settings: {
                    ...previousSettings,
                    ...settings,
                    clearInputAfterSubmit: previousBoolean(previousSettings.clearInputAfterSubmit, settings.clearInputAfterSubmit),
                    persistInputOnRestart: previousBoolean(previousSettings.persistInputOnRestart, settings.persistInputOnRestart),
                    reuseTaskApiProfileTemporarily: previousBoolean(previousSettings.reuseTaskApiProfileTemporarily, settings.reuseTaskApiProfileTemporarily),
                    alwaysShowRetryButton: previousBoolean(previousSettings.alwaysShowRetryButton, settings.alwaysShowRetryButton),
                    allowPromptRewrite: previousBoolean(previousSettings.allowPromptRewrite, settings.allowPromptRewrite),
                    taskCompletionNotification: previousBoolean(previousSettings.taskCompletionNotification, settings.taskCompletionNotification),
                    enterSubmit: previousBoolean(previousSettings.enterSubmit, settings.enterSubmit),
                    referenceImageEditAction: previousReferenceImageEditAction(previousSettings.referenceImageEditAction, settings.referenceImageEditAction),
                    zipDownloadRoutes: previousZipDownloadRoutes(previousSettings.zipDownloadRoutes, settings.zipDownloadRoutes),
                    agentScrollToBottomAfterSubmit: previousBoolean(previousSettings.agentScrollToBottomAfterSubmit, settings.agentScrollToBottomAfterSubmit),
                    agentMaxToolRounds: previousAgentMaxToolRounds(previousSettings.agentMaxToolRounds, settings.agentMaxToolRounds),
                    agentWebSearch: previousBoolean(previousSettings.agentWebSearch, settings.agentWebSearch),
                    agentMathFormattingPrompt: previousBoolean(previousSettings.agentMathFormattingPrompt, settings.agentMathFormattingPrompt),
                    agentApiConfigMode: previousAgentApiConfigMode(previousSettings.agentApiConfigMode, settings.agentApiConfigMode),
                    agentTextProfileId: previousProfileId(previousSettings.agentTextProfileId, nextProfiles, settings.agentTextProfileId),
                    agentImageProfileId: previousProfileId(previousSettings.agentImageProfileId, nextProfiles, activeProfile?.id || settings.agentImageProfileId),
                    profiles: nextProfiles,
                    activeProfileId,
                    baseUrl: activeProfile?.baseUrl || settings.baseUrl,
                    apiKey: activeProfile?.apiKey || settings.apiKey,
                    model: activeProfile?.model || settings.model,
                    apiMode: normalizeApiMode(previousSettings.apiMode, activeProfile?.apiMode || settings.apiMode),
                    timeout: activeProfile?.timeout || settings.timeout,
                    codexCli: activeProfile?.codexCli ?? settings.codexCli,
                    responseFormatB64Json: activeProfile?.responseFormatB64Json ?? settings.responseFormatB64Json,
                    streamImages: activeProfile?.streamImages ?? settings.streamImages,
                    streamPartialImages: activeProfile?.streamPartialImages ?? settings.streamPartialImages,
                    customProviders: Array.isArray(previousSettings.customProviders) ? previousSettings.customProviders : settings.customProviders,
                    providerOrder: Array.isArray(previousSettings.providerOrder) ? previousSettings.providerOrder : undefined,
                },
                params: {
                    ...previousParams,
                    size: normalizeSize(config.size || String(previousParams.size || "auto")),
                    quality: normalizeQuality(config.quality) || normalizeQuality(String(previousParams.quality || "auto")) || "auto",
                    n: Math.max(1, Math.min(10, Number(config.count) || 1)),
                    output_format: normalizeOutputFormat(String(previousParams.output_format || "png")),
                    output_compression: previousParams.output_compression ?? null,
                    moderation: previousParams.moderation === "low" ? "low" : "auto",
                    transparent_output: previousParams.transparent_output === true,
                },
            },
            version: 2,
        }),
    );
}

function previousBoolean(value: unknown, fallback: boolean) {
    return typeof value === "boolean" ? value : fallback;
}

function collectOpenAIHostChannels(config: AiConfig): ModelChannel[] {
    return config.channels
        .filter((channel) => channel.apiFormat === "openai")
        .filter((channel) => channel.models.length);
}

function previousReferenceImageEditAction(value: unknown, fallback: PlaygroundSettings["referenceImageEditAction"]) {
    return value === "replace-reference" || value === "add-mask" || value === "ask" ? value : fallback;
}

function previousZipDownloadRoutes(value: unknown, fallback: string[]) {
    const valid = new Set(["task-selection", "favorite-collection-selection", "image-context-menu-all", "task-detail-all", "task-detail-partial", "agent-round-all"]);
    const routes = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && valid.has(item)) : [];
    return routes.length ? routes : fallback;
}

function previousAgentMaxToolRounds(value: unknown, fallback: number) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(50, Math.max(1, Math.trunc(numeric)));
}

function previousAgentApiConfigMode(value: unknown, fallback: PlaygroundSettings["agentApiConfigMode"]) {
    return value === "native" || value === "hybrid" || value === "off" ? value : fallback;
}

function previousProfileId(value: unknown, profiles: PlaygroundProfile[], fallback: string | null) {
    if (typeof value === "string" && profiles.some((profile) => profile.id === value)) return value;
    return fallback;
}

function mergePlaygroundProfiles(hostProfiles: PlaygroundProfile[], previousProfiles: unknown) {
    const previousList = Array.isArray(previousProfiles)
        ? previousProfiles.filter((profile): profile is Record<string, unknown> => isRecord(profile) && typeof profile.id === "string" && typeof profile.provider === "string")
        : [];
    const previousById = new Map(previousList.map((profile) => [String(profile.id), profile]));
    const mergedHostProfiles = hostProfiles.map((profile) => preserveProfileApiOptions(profile, previousById.get(profile.id) || previousById.get(profile.channelId || "")));
    const hostIds = new Set(hostProfiles.map((profile) => profile.id));
    const hostChannelIds = new Set(hostProfiles.map((profile) => profile.channelId).filter(Boolean));
    const extras = previousList.filter((profile) => !hostIds.has(String(profile.id)) && !hostChannelIds.has(String(profile.id)) && profile.managedByHost !== true).map((profile) => profile as unknown as PlaygroundProfile);
    return [...mergedHostProfiles, ...extras];
}

function preserveProfileApiOptions(profile: PlaygroundProfile, previous?: Record<string, unknown>): PlaygroundProfile {
    if (!previous) return profile;
    return {
        ...profile,
        apiMode: normalizeApiMode(previous.apiMode, profile.apiMode),
        timeout: normalizePositiveNumber(previous.timeout, profile.timeout),
        codexCli: normalizeBoolean(previous.codexCli, profile.codexCli),
        responseFormatB64Json: normalizeBoolean(previous.responseFormatB64Json, profile.responseFormatB64Json),
        streamImages: normalizeBoolean(previous.streamImages, profile.streamImages),
        streamPartialImages: normalizeStreamPartialImages(previous.streamPartialImages, profile.streamPartialImages),
    };
}

function normalizeApiMode(value: unknown, fallback: PlaygroundProfile["apiMode"]) {
    return value === "responses" || value === "images" ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean) {
    return typeof value === "boolean" ? value : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number) {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeStreamPartialImages(value: unknown, fallback: number) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(3, Math.max(0, Math.trunc(numeric)));
}

function readPlaygroundStore() {
    try {
        const raw = window.localStorage.getItem(PLAYGROUND_STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function readHostActiveProfileId() {
    if (activePlaygroundProfileIdMemory) return activePlaygroundProfileIdMemory;
    if (typeof window === "undefined") return "";
    try {
        activePlaygroundProfileIdMemory = window.localStorage.getItem(PLAYGROUND_ACTIVE_PROFILE_KEY) || "";
        return activePlaygroundProfileIdMemory;
    } catch {
        return "";
    }
}

function persistHostActiveProfileId(profileId: string) {
    if (typeof window === "undefined" || !profileId) return;
    activePlaygroundProfileIdMemory = profileId;
    try {
        window.localStorage.setItem(PLAYGROUND_ACTIVE_PROFILE_KEY, profileId);
    } catch {
        // Host selection persistence is best-effort.
    }
}

function readPlaygroundCostInput(config: AiConfig): PlaygroundCostInput {
    const previous = readPlaygroundStore();
    const state = isRecord(previous.state) ? previous.state : {};
    const settings = isRecord(state.settings) ? state.settings : {};
    const params = isRecord(state.params) ? state.params : {};
    const profiles = readPlaygroundProfiles(settings.profiles);
    const hostActiveProfileId = readHostActiveProfileId();
    const activeProfileId = typeof settings.activeProfileId === "string" ? settings.activeProfileId : "";
    const activeProfile = profiles.find((profile) => profile.id === hostActiveProfileId) || profiles.find((profile) => profile.id === activeProfileId);
    const model = activeProfile?.model?.trim() ? activeProfile.model : modelOptionName(config.imageModel || config.model);
    const count = Math.max(1, Math.min(1000, Math.floor(Number(params.n ?? config.count) || 1)));
    const baseUrl = activeProfile?.baseUrl || "";
    const apiKey = activeProfile?.apiKey || "";
    const platform = config.apiSource === "system" && (apiKey === "system" || baseUrl.includes("/api/ai/system/"));
    return { model, count, platform };
}

function toAbsoluteBaseUrl(baseUrl: string) {
    const value = baseUrl.trim();
    if (!value) return value;
    if (typeof window === "undefined" || !value.startsWith("/")) return value;
    return `${window.location.origin}${value}`;
}

function normalizeSize(value: string) {
    const size = value.trim();
    if (!size || size === "auto" || /^\d+\s*x\s*\d+$/i.test(size)) return size || "auto";
    return size.includes(":") ? ratioToOneKSize(size) : "auto";
}

function ratioToOneKSize(value: string) {
    const [rawWidth, rawHeight] = value.split(":");
    const width = Number(rawWidth);
    const height = Number(rawHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "auto";
    const ratio = width / height;
    if (Math.abs(ratio - 1) < 0.01) return "1024x1024";
    if (ratio > 1) return `${Math.round((1024 * ratio) / 16) * 16}x1024`;
    return `1024x${Math.round((1024 / ratio) / 16) * 16}`;
}

function normalizeQuality(value: string) {
    return value === "low" || value === "medium" || value === "high" || value === "auto" ? value : "auto";
}

function normalizeOutputFormat(value: string) {
    return value === "jpeg" || value === "webp" ? value : "png";
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
