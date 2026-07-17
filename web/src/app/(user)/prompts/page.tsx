"use client";

import { FolderPlus, Search } from "lucide-react";
import { type UIEvent, useEffect, useRef, useState } from "react";
import { App, Button, Empty, Input, Select, Spin, Tag } from "antd";

import { PromptCard } from "@/components/prompts/prompt-card";
import { PromptDetailDialog } from "@/components/prompts/prompt-detail-dialog";
import { usePromptList } from "@/components/prompts/use-prompt-list";
import { useCopyText } from "@/hooks/use-copy-text";
import { useAssetStore } from "@/stores/use-asset-store";
import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";

export default function PromptsPage() {
    const { message } = App.useApp();
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedSource, setSelectedSource] = useState(ALL_PROMPTS_OPTION);
    const [selectedTag, setSelectedTag] = useState(ALL_PROMPTS_OPTION);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const scrollContainerRef = useRef<HTMLElement | null>(null);
    const addAsset = useAssetStore((state) => state.addAsset);
    const copyText = useCopyText();
    const activeTags = selectedTag === ALL_PROMPTS_OPTION ? [] : [selectedTag];
    const { query, items: promptItems, tags: promptTags, sourceOptions, total: totalPrompts } = usePromptList({ keyword: titleKeyword, tags: activeTags, category: ALL_PROMPTS_OPTION, source: selectedSource });
    const selectedSourceLabel = sourceOptions.find((source) => source.id === selectedSource)?.label || "";
    const activeFilterLabels = [selectedSource !== ALL_PROMPTS_OPTION ? selectedSourceLabel || selectedSource : "", selectedTag !== ALL_PROMPTS_OPTION ? selectedTag : "", titleKeyword.trim() ? `搜索：${titleKeyword.trim()}` : ""].filter(Boolean);

    useEffect(() => {
        if (query.isError) {
            message.error(query.error instanceof Error ? query.error.message : "获取提示词失败");
        }
    }, [message, query.error, query.isError]);

    useEffect(() => {
        scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }, [selectedSource, selectedTag, titleKeyword]);

    const savePromptAsset = (item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl || "" } });
        message.success("已加入我的素材");
    };

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) {
            void query.fetchNextPage();
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main
                ref={scrollContainerRef}
                className="min-h-0 flex-1 overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]"
                onScroll={handleListScroll}
            >
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">提示词中心</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">共 {totalPrompts} 条提示词，按标题、来源与标签快速查找灵感。</p>
                    </div>
                    {query.isLoading ? (
                        <div className="flex h-60 items-center justify-center">
                            <Spin />
                        </div>
                    ) : null}
                    {!query.isLoading ? (
                        <>
                            <div className="mx-auto mt-8 grid w-full max-w-6xl gap-3 text-left lg:grid-cols-[minmax(0,1fr)_220px_220px]">
                                <Input size="large" prefix={<Search className="size-4 text-stone-400" />} value={titleKeyword} placeholder="搜索标题、标签、词源或提示词" onChange={(event) => setTitleKeyword(event.target.value)} />
                                <Select
                                    size="large"
                                    value={selectedSource}
                                    classNames={{ popup: { root: "prompt-library-select-dropdown" } }}
                                    onChange={(value) => {
                                        setSelectedSource(value);
                                        setSelectedTag(ALL_PROMPTS_OPTION);
                                    }}
                                    options={[{ value: ALL_PROMPTS_OPTION, label: "全部来源" }, ...sourceOptions.map((source) => ({ value: source.id, label: source.label }))]}
                                />
                                <Select
                                    size="large"
                                    showSearch
                                    value={selectedTag}
                                    optionFilterProp="label"
                                    virtual={false}
                                    listHeight={360}
                                    classNames={{ popup: { root: "prompt-library-select-dropdown prompt-library-tag-dropdown" } }}
                                    onChange={setSelectedTag}
                                    options={promptTags.map((tag) => ({ value: tag, label: tag === ALL_PROMPTS_OPTION ? "全部类型" : tag }))}
                                />
                            </div>
                            <div className="mx-auto mt-4 flex max-w-6xl flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white/85 px-3 py-2 text-sm text-stone-600 shadow-sm dark:border-stone-800 dark:bg-stone-950/80 dark:text-stone-300">
                                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                    <span className="font-medium text-stone-900 dark:text-stone-100">当前筛选</span>
                                    {activeFilterLabels.length ? (
                                        activeFilterLabels.map((label) => (
                                            <Tag key={label} className="m-0">
                                                {label}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0">全部</Tag>
                                    )}
                                </div>
                                <span className="shrink-0 tabular-nums">匹配 {totalPrompts} 条</span>
                            </div>
                        </>
                    ) : null}
                </div>

                {!query.isLoading ? (
                    <div>
                        <div className="mx-auto grid max-w-7xl gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                            {promptItems.map((item) => (
                                <PromptCard
                                    key={item.id}
                                    item={item}
                                    onOpen={() => setSelectedPrompt(item)}
                                    onCopy={() => copyText(item.prompt, "提示词已复制")}
                                    extraAction={
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>
                                            加入我的素材
                                        </Button>
                                    }
                                />
                            ))}
                        </div>
                        {promptItems.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到匹配的提示词" className="py-16" /> : null}
                        <div className="mx-auto mt-6 max-w-7xl text-center text-xs text-stone-500 dark:text-stone-400">
                            {query.isFetchingNextPage ? "加载中..." : query.hasNextPage ? "继续向下滚动加载更多" : promptItems.length > 0 ? "已经到底了" : null}
                        </div>
                    </div>
                ) : null}
            </main>

            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, "提示词已复制")} onSaveAsset={savePromptAsset} />
        </div>
    );
}
