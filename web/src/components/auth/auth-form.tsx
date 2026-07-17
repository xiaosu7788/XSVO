"use client";

import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Clapperboard, GalleryHorizontalEnd, Image as ImageIcon, Layers3, LockKeyhole, Mail, Sparkles, UserRound } from "lucide-react";
import { App, Button, Input } from "antd";

import { type LocalUser, useUserStore } from "@/stores/use-user-store";
import { cn } from "@/lib/utils";

type AuthFormProps = {
    mode: "login" | "register";
    nextPath?: string;
    registrationEnabled?: boolean;
    emailRegistrationEnabled?: boolean;
    firstUser?: boolean;
    variant?: "page" | "embedded";
    className?: string;
    headerSlot?: ReactNode;
    authError?: string;
};

export function AuthForm({ mode, nextPath = "/canvas", registrationEnabled = true, emailRegistrationEnabled = false, firstUser = false, variant = "page", className, headerSlot, authError }: AuthFormProps) {
    const router = useRouter();
    const { message } = App.useApp();
    const setUser = useUserStore((state) => state.setUser);
    const [username, setUsername] = useState("");
    const [email, setEmail] = useState("");
    const [emailCode, setEmailCode] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [sendingCode, setSendingCode] = useState(false);
    const isRegister = mode === "register";
    const disabled = isRegister && !registrationEnabled;
    const pageTitle = firstUser ? "创建第一个管理员账号" : isRegister ? "创建你的 XSVO 账号" : "继续你的 XSVO 创作";
    const panelTitle = firstUser ? "初始化创作空间" : isRegister ? "建立新的创作身份" : "回到你的创作流";
    const panelDescription = isRegister ? "注册后即可进入画布、生图工作台、素材库和提示词库。" : "登录后继续管理你的画布、素材、提示词和生成记录。";

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (disabled) return;
        setSubmitting(true);
        try {
            const response = await fetch(isRegister ? "/api/auth/register" : "/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, email, emailCode, displayName, password }),
            });
            const payload = (await response.json()) as { user?: LocalUser; error?: string };
            if (!response.ok || !payload.user) throw new Error(payload.error || (isRegister ? "注册失败" : "登录失败"));
            setUser(payload.user);
            message.success(isRegister ? "注册成功" : "登录成功");
            router.replace(nextPath);
            router.refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : isRegister ? "注册失败" : "登录失败");
        } finally {
            setSubmitting(false);
        }
    };

    const sendEmailCode = async () => {
        setSendingCode(true);
        try {
            const response = await fetch("/api/auth/email-code", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ purpose: "register", email }),
            });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "验证码发送失败");
            message.success("验证码已发送，请查看邮箱");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "验证码发送失败");
        } finally {
            setSendingCode(false);
        }
    };

    const form = (
        <section className={cn("auth-panel", className)}>
            <form onSubmit={submit} className={cn("auth-form-body", variant === "embedded" ? "auth-form-body-embedded" : "")}>
                {headerSlot}
                <div className="auth-form-header">
                    <p className="auth-form-kicker">{firstUser ? "首次设置" : isRegister ? "创建账号" : "账号访问"}</p>
                    <h2>{variant === "embedded" ? (isRegister ? "注册后进入 XSVO" : "登录进入 XSVO") : panelTitle}</h2>
                    <p className="auth-form-description">{panelDescription}</p>
                </div>

                {authError ? <div className="auth-alert auth-alert-error">{authError}</div> : null}
                {disabled ? <div className="auth-alert auth-alert-info">当前站点已关闭注册，请联系管理员开通账号。</div> : null}

                <label>
                    <span>{isRegister ? "登录用户名" : "用户名 / 邮箱"}</span>
                    <Input size="large" prefix={<UserRound className="size-4 text-stone-500" />} value={username} onChange={(event) => setUsername(event.target.value)} placeholder={isRegister ? "your_name" : "用户名或已绑定邮箱"} autoComplete="username" disabled={submitting || disabled} required />
                    {isRegister ? <small>用于登录，注册后不可修改；昵称可在个人资料中随时修改。</small> : null}
                </label>

                {isRegister && emailRegistrationEnabled ? (
                    <div className="auth-field-group">
                        <label>
                            <span>邮箱</span>
                            <Input size="large" prefix={<Mail className="size-4 text-stone-500" />} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@qq.com" autoComplete="email" type="email" disabled={submitting || disabled} required />
                        </label>
                        <label>
                            <span>邮箱验证码</span>
                            <Input.Search size="large" value={emailCode} onChange={(event) => setEmailCode(event.target.value)} placeholder="6 位验证码" enterButton={sendingCode ? "发送中" : "获取验证码"} loading={sendingCode} disabled={submitting || disabled} onSearch={() => void sendEmailCode()} required />
                        </label>
                    </div>
                ) : null}

                {isRegister ? (
                    <label>
                        <span>显示昵称</span>
                        <Input size="large" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="显示在顶部账号菜单，可留空" autoComplete="name" disabled={submitting || disabled} />
                    </label>
                ) : null}

                <label>
                    <span>密码</span>
                    <Input.Password size="large" prefix={<LockKeyhole className="size-4 text-stone-500" />} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={isRegister ? "至少 8 位" : "请输入密码"} autoComplete={isRegister ? "new-password" : "current-password"} disabled={submitting || disabled} required />
                </label>

                <Button className="auth-submit-button" type="primary" htmlType="submit" size="large" block loading={submitting} disabled={disabled} icon={<ArrowRight className="size-4" />} iconPlacement="end">
                    {isRegister ? "注册并进入" : "登录"}
                </Button>

                <div className="auth-switch-link">
                    {isRegister ? (
                        <>
                            已有账号？ <Link href="/login">去登录</Link>
                        </>
                    ) : (
                        <>
                            没有账号？ <Link href="/register">去注册</Link><span>/</span><Link href="/forgot-password">忘记密码</Link>
                        </>
                    )}
                </div>
            </form>
        </section>
    );

    if (variant === "embedded") return form;

    return (
        <main className="auth-page-bg auth-page-shell">
            <div className="auth-route-modal-card xsvo-auth-modal">
                <div className="xsvo-auth-shell">
                    <section className="xsvo-auth-copy">
                        <div className="xsvo-auth-brand-row">
                            <img src="/logo.svg?v=creative-minimal" alt="" className="auth-brand-logo" />
                            <span>XSVO</span>
                        </div>
                        <div className="xsvo-auth-copy-main">
                            <p className="xsvo-section-kicker">Studio Console Access</p>
                            <h2>{pageTitle}</h2>
                            <p>回到你的创作控制台，继续管理提示词、素材、生成任务和画布资产。</p>
                        </div>
                        <div className="auth-studio-stage auth-studio-stage-modal" aria-hidden="true">
                            <div className="auth-studio-toolbar">
                                <span>Creative Flow</span>
                                <strong>v0.1.1</strong>
                            </div>
                            <div className="auth-studio-prompt">
                                <div><Sparkles className="size-4" /> Prompt</div>
                                <p>统一产品色调，生成一组可归档到素材库的品牌视觉。</p>
                            </div>
                            <div className="auth-studio-grid">
                                <div className="auth-studio-cell is-active"><ImageIcon className="size-4" /><span>图片</span><strong>3</strong></div>
                                <div className="auth-studio-cell"><GalleryHorizontalEnd className="size-4" /><span>素材</span><strong>12</strong></div>
                                <div className="auth-studio-cell"><Clapperboard className="size-4" /><span>视频</span><strong>2</strong></div>
                                <div className="auth-studio-cell"><Layers3 className="size-4" /><span>画布</span><strong>5</strong></div>
                            </div>
                        </div>
                    </section>
                    <div className="xsvo-auth-form"><div className="xsvo-auth-form-card">{form}</div></div>
                </div>
            </div>
        </main>
    );
}
