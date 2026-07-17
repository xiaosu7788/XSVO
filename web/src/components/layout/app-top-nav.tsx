"use client";

import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { cn } from "@/lib/utils";
import { applyPublicSystemSettings, useConfigStore, type PublicSystemSettings } from "@/stores/use-config-store";
import { type LocalUser, useUserStore } from "@/stores/use-user-store";

type PublicSiteSettings = {
    title: string;
    logoUrl: string;
};

export function AppTopNav() {
    const pathname = usePathname();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [site, setSite] = useState<PublicSiteSettings>({ title: "XSVO", logoUrl: "/logo.svg" });
    const setUser = useUserStore((state) => state.setUser);
    const setConfig = useConfigStore((state) => state.setConfig);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    useEffect(() => {
        void fetch("/api/auth/session")
            .then(
                (response) =>
                    response.json() as Promise<{
                        user?: LocalUser | null;
                        settings?: PublicSystemSettings & { site?: PublicSiteSettings };
                    }>,
            )
            .then((payload) => {
                if (payload.settings?.site) setSite(payload.settings.site);
                if (payload.user) setUser(payload.user);
                setConfig(applyPublicSystemSettings(useConfigStore.getState().config, payload.settings));
            })
            .catch(() => undefined);
    }, [setUser, setConfig]);

    return (
        <>
            {!hideHeader ? (
                <header className="app-shell-header sticky top-0 z-20 h-[68px] shrink-0 sm:h-[74px]">
                    <div className="mx-auto grid h-full max-w-[1500px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 sm:gap-3 sm:px-6">
                        <div className="flex min-w-0 items-center justify-start overflow-hidden">
                            <Link href="/" className="flex h-full min-w-0 items-center gap-2.5 text-sm font-semibold leading-none tracking-tight text-stone-950 transition hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300">
                                <SiteLogo logoUrl={site.logoUrl} className="size-9" />
                                <span className="max-w-[24vw] truncate text-xl font-semibold sm:max-w-[30vw] lg:max-w-none">{site.title || "XSVO"}</span>
                            </Link>

                            <button
                                type="button"
                                className="ml-3 inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 lg:hidden dark:text-stone-300 dark:hover:text-white"
                                onClick={() => setMobileNavOpen(true)}
                                aria-label="打开导航菜单"
                                title="导航菜单"
                            >
                                <Menu className="size-5" />
                            </button>
                        </div>

                        <div className="app-shell-actions my-auto flex h-9 max-w-[calc(100vw-9rem)] min-w-0 items-center justify-end overflow-visible whitespace-nowrap sm:max-w-[calc(100vw-12rem)] lg:max-w-none">
                            <UserStatusActions />
                        </div>
                    </div>
                </header>
            ) : null}

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} />
        </>
    );
}

export function AppSideNav() {
    const pathname = usePathname();
    const router = useRouter();
    const [collapsed, setCollapsed] = useState(false);
    const hideSidebar = /^\/canvas\/[^/]+/.test(pathname);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    useEffect(() => {
        try {
            setCollapsed(localStorage.getItem("xsvo-main:sidebar-collapsed") === "true");
        } catch {
            setCollapsed(false);
        }
    }, []);

    const toggleCollapsed = () => {
        setCollapsed((current) => {
            const next = !current;
            try {
                localStorage.setItem("xsvo-main:sidebar-collapsed", String(next));
            } catch {
                // ignore storage failures
            }
            return next;
        });
    };

    if (hideSidebar) return null;

    return (
        <aside className={cn("app-shell-sidebar hidden shrink-0 lg:flex", collapsed && "is-collapsed")}>
            <div className="app-shell-sidebar-inner">
                <div className="app-shell-sidebar-head">
                    <div className="app-shell-sidebar-kicker">创作导航</div>
                    <button type="button" className="app-shell-sidebar-toggle" onClick={toggleCollapsed} aria-label={collapsed ? "展开侧边导航" : "收起侧边导航"} title={collapsed ? "展开侧边导航" : "收起侧边导航"}>
                        {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                    </button>
                </div>
                <nav className="app-shell-sidebar-nav" aria-label="创作导航">
                    {navigationTools.map((tool) => {
                        const Icon = tool.icon;
                        const active = tool.slug === activeToolSlug;
                        return (
                            <Link
                                key={tool.slug}
                                href={`/${tool.slug}`}
                                prefetch
                                onMouseEnter={() => router.prefetch(`/${tool.slug}`)}
                                onFocus={() => router.prefetch(`/${tool.slug}`)}
                                title={collapsed ? tool.label : undefined}
                                className={cn("app-shell-sidebar-link", active && "is-active")}
                            >
                                <Icon className="size-[18px]" />
                                <span>{tool.label}</span>
                            </Link>
                        );
                    })}
                </nav>
            </div>
        </aside>
    );
}

function SiteLogo({ logoUrl, className }: { logoUrl: string; className: string }) {
    const src = !logoUrl || logoUrl === "/logo.svg" ? "/logo.svg?v=creative-minimal" : logoUrl;
    return <img src={src} alt="" className={cn(className, "shrink-0 object-contain")} onError={(event) => { event.currentTarget.src = "/logo.svg?v=creative-minimal"; }} referrerPolicy="no-referrer" />;
}
