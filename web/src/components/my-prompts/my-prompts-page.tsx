"use client";

import { useEffect, useState } from "react";
import { App, Button, Empty, Form, Input, Popconfirm, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { Copy, FolderPlus, Plus, Trash2 } from "lucide-react";

import { useAssetStore } from "@/stores/use-asset-store";
import { useCopyText } from "@/hooks/use-copy-text";
import type { Prompt, PromptListResponse } from "@/services/api/prompts";

type PromptFormValue = {
    title: string;
    prompt: string;
    category?: string;
    tags?: string;
    coverUrl?: string;
    preview?: string;
};

export function MyPromptsPage() {
    const { message } = App.useApp();
    const [form] = Form.useForm<PromptFormValue>();
    const [items, setItems] = useState<Prompt[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [deletingId, setDeletingId] = useState("");
    const copyText = useCopyText();
    const addAsset = useAssetStore((state) => state.addAsset);

    const loadPrompts = async () => {
        setLoading(true);
        try {
            const response = await fetch("/api/my-prompts?pageSize=100");
            const payload = (await response.json()) as PromptListResponse & { error?: string };
            if (!response.ok) throw new Error(payload.error || "获取我的提示词失败");
            setItems(payload.items);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "获取我的提示词失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void loadPrompts();
    }, []);

    const createPrompt = async (value: PromptFormValue) => {
        setSubmitting(true);
        try {
            const response = await fetch("/api/my-prompts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...value, tags: splitTags(value.tags) }),
            });
            const payload = (await response.json()) as { prompt?: Prompt; error?: string };
            if (!response.ok || !payload.prompt) throw new Error(payload.error || "新增提示词失败");
            setItems((current) => [payload.prompt!, ...current]);
            form.resetFields();
            message.success("提示词已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "新增提示词失败");
        } finally {
            setSubmitting(false);
        }
    };

    const deletePrompt = async (id: string) => {
        setDeletingId(id);
        try {
            const response = await fetch(`/api/my-prompts/${id}`, { method: "DELETE" });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "删除提示词失败");
            setItems((current) => current.filter((item) => item.id !== id));
            message.success("提示词已删除");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除提示词失败");
        } finally {
            setDeletingId("");
        }
    };

    const savePromptAsset = (item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "my-prompts", promptId: item.id } });
        message.success("已加入我的素材");
    };

    const columns: TableColumnsType<Prompt> = [
        {
            title: "标题",
            dataIndex: "title",
            render: (_, record) => (
                <div className="min-w-0">
                    <div className="font-medium text-stone-950 dark:text-stone-100">{record.title}</div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{record.prompt}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                        {record.tags.map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                    </div>
                </div>
            ),
        },
        {
            title: "分类",
            dataIndex: "category",
            width: 120,
        },
        {
            title: "操作",
            width: 260,
            render: (_, record) => (
                <Space wrap size="small">
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(record.prompt, "提示词已复制")}>
                        复制
                    </Button>
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(record)}>
                        素材
                    </Button>
                    <Popconfirm title="删除提示词？" okText="删除" cancelText="取消" onConfirm={() => deletePrompt(record.id)}>
                        <Button size="small" danger loading={deletingId === record.id} icon={<Trash2 className="size-3.5" />} />
                    </Popconfirm>
                </Space>
            ),
        },
    ];

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
                <div className="mx-auto max-w-7xl space-y-6">
                    <div>
                        <h1 className="text-3xl font-semibold tracking-normal text-stone-950 dark:text-stone-100">我的提示词</h1>
                        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">保存自己的提示词记录，复制使用或沉淀到我的素材。</p>
                    </div>

                    <section className="border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-950">
                        <Form form={form} layout="vertical" onFinish={createPrompt} requiredMark={false}>
                            <div className="grid gap-4 md:grid-cols-2">
                                <Form.Item label="标题" name="title" rules={[{ required: true, message: "请输入标题" }]} className="mb-0">
                                    <Input placeholder="例如：产品摄影主视觉" />
                                </Form.Item>
                                <Form.Item label="分类" name="category" className="mb-0">
                                    <Input placeholder="例如：商业海报" />
                                </Form.Item>
                                <Form.Item label="标签" name="tags" className="mb-0">
                                    <Input placeholder="用逗号分隔，例如：摄影, 电商, 写实" />
                                </Form.Item>
                                <Form.Item label="封面 URL" name="coverUrl" className="mb-0">
                                    <Input placeholder="可选，用于展示卡片封面" />
                                </Form.Item>
                            </div>
                            <Form.Item label="提示词内容" name="prompt" rules={[{ required: true, message: "请输入提示词内容" }]} className="mt-4">
                                <Input.TextArea rows={5} placeholder="输入完整提示词..." />
                            </Form.Item>
                            <Form.Item label="备注 / 预览" name="preview" className="mb-0">
                                <Input.TextArea rows={2} placeholder="可选，记录使用场景、参考图说明或效果备注" />
                            </Form.Item>
                            <div className="mt-4 flex justify-end">
                                <Button type="primary" htmlType="submit" loading={submitting} icon={<Plus className="size-4" />}>
                                    保存提示词
                                </Button>
                            </div>
                        </Form>
                    </section>

                    <section className="border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950">
                        <div className="border-b border-stone-200 px-5 py-4 dark:border-stone-800">
                            <h2 className="text-lg font-semibold text-stone-950 dark:text-stone-100">我的记录</h2>
                        </div>
                        <Table rowKey="id" loading={loading} columns={columns} dataSource={items} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有保存提示词" /> }} />
                    </section>
                </div>
            </main>
        </div>
    );
}

function splitTags(value?: string) {
    return (value || "")
        .split(/[,，\n]/)
        .map((tag) => tag.trim())
        .filter(Boolean);
}
