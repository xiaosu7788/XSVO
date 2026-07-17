"use client";

import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card, Tag } from "antd";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";

export function PromptCard({
    item,
    onOpen,
    onCopy,
    actionLabel = "复制",
    actionIcon = <Copy className="size-3.5" />,
    actionType = "text",
    extraAction,
    compact = false,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
    compact?: boolean;
}) {
    const imageClassName = compact ? "aspect-[5/3] w-full object-cover" : "aspect-[4/3] w-full object-cover";
    const fallbackClassName = compact
        ? "flex aspect-[5/3] w-full items-center justify-center bg-stone-100 px-4 text-center text-xs font-medium text-stone-500 dark:bg-stone-900 dark:text-stone-400"
        : "flex aspect-[4/3] w-full items-center justify-center bg-stone-100 px-5 text-center text-sm font-medium text-stone-500 dark:bg-stone-900 dark:text-stone-400";
    const visibleTags = compact ? item.tags.slice(0, 2) : item.tags;
    return (
        <Card
            hoverable
            className="overflow-hidden"
            styles={{ body: { padding: 0 } }}
            cover={
                <button type="button" className="block w-full text-left" onClick={onOpen}>
                    {item.coverUrl ? (
                        <img src={item.coverUrl} alt={item.title} className={imageClassName} loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                        <div className={fallbackClassName}>{item.title}</div>
                    )}
                </button>
            }
        >
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className={compact ? "p-3" : "p-4"}>
                    <div className="flex items-start justify-between gap-3">
                        <h2 className={compact ? "line-clamp-1 text-[13px] font-semibold text-stone-950 dark:text-stone-100" : "line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100"}>{item.title}</h2>
                        <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">{formatPromptDate(item.updatedAt)}</span>
                    </div>
                    <p className={compact ? "mt-1.5 line-clamp-2 text-xs leading-5 text-stone-600 dark:text-stone-400" : "mt-2 line-clamp-3 text-xs leading-5 text-stone-600 dark:text-stone-400"}>{item.prompt}</p>
                    <div className={compact ? "mt-2 flex flex-wrap gap-1.5" : "mt-3 flex flex-wrap gap-1.5"}>
                        {item.sourceName ? (
                            <Tag className="m-0 text-[11px]" color="cyan">
                                {item.sourceName}
                            </Tag>
                        ) : null}
                        {visibleTags.map((tag) => (
                            <Tag key={tag} className={compact ? "m-0 max-w-[128px] truncate text-[11px]" : "m-0 text-[11px]"}>
                                {tag}
                            </Tag>
                        ))}
                        {compact && item.tags.length > visibleTags.length ? <Tag className="m-0 text-[11px]">+{item.tags.length - visibleTags.length}</Tag> : null}
                    </div>
                </div>
            </button>
            <div className={compact ? "flex items-center gap-2 px-3 pb-3" : "flex items-center gap-2 px-4 pb-4"}>
                <Button block={actionType === "primary"} type={actionType} size="small" icon={actionIcon} onClick={onCopy}>
                    {actionLabel}
                </Button>
                {extraAction}
            </div>
        </Card>
    );
}
