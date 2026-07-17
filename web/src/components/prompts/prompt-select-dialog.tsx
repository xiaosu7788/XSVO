"use client";

import { Check, Search } from "lucide-react";
import { type UIEvent, useEffect, useState } from "react";
import { App, Empty, Input, Modal, Select, Spin } from "antd";

import { ALL_PROMPTS_OPTION } from "@/services/api/prompts";
import { PromptCard } from "./prompt-card";
import { usePromptList } from "./use-prompt-list";

export function PromptSelectDialog({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (prompt: string) => void }) {
    const { message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const [selectedSource, setSelectedSource] = useState(ALL_PROMPTS_OPTION);
    const [selectedTag, setSelectedTag] = useState(ALL_PROMPTS_OPTION);
    const activeTags = selectedTag === ALL_PROMPTS_OPTION ? [] : [selectedTag];
    const { query, items, tags: promptTags, sourceOptions, total } = usePromptList({ keyword, tags: activeTags, category: ALL_PROMPTS_OPTION, source: selectedSource, enabled: open });
    const selectPrompt = (prompt: string) => {
        onSelect(prompt);
        onOpenChange(false);
    };

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : "获取提示词失败");
    }, [message, query.error, query.isError]);

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <Modal
            title={
                <div>
                    <div className="text-base font-semibold">提示词库</div>
                    <div className="mt-1 text-xs font-normal text-stone-500 dark:text-stone-400">{total} 条提示词，{sourceOptions.filter((source) => source.enabled).length} 个启用词源</div>
                </div>
            }
            open={open}
            onCancel={() => onOpenChange(false)}
            footer={null}
            width={1120}
            centered
            styles={{ body: { paddingTop: 14, maxHeight: "calc(100vh - 160px)", overflow: "hidden" } }}
        >
            <div data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_220px]">
                    <Input size="large" prefix={<Search className="size-4 text-stone-400" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索标题、标签、词源或提示词" />
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
                <div className="thin-scrollbar mt-5 max-h-[calc(100vh-280px)] overflow-y-auto pr-2" data-canvas-no-zoom onScroll={handleListScroll} onWheelCapture={(event) => event.stopPropagation()}>
                    {query.isLoading ? (
                        <div className="flex h-40 items-center justify-center">
                            <Spin />
                        </div>
                    ) : null}
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {items.map((item) => (
                            <PromptCard key={item.id} item={item} compact onOpen={() => selectPrompt(item.prompt)} onCopy={() => selectPrompt(item.prompt)} actionLabel="使用" actionIcon={<Check className="size-3.5" />} actionType="primary" />
                        ))}
                    </div>
                    {!query.isLoading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到匹配的提示词" className="py-8" /> : null}
                    {query.isFetchingNextPage ? (
                        <div className="py-4 text-center">
                            <Spin size="small" />
                        </div>
                    ) : null}
                </div>
            </div>
        </Modal>
    );
}
