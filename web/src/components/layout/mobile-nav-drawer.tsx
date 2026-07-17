"use client";

import { Drawer } from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const router = useRouter();

    return (
        <Drawer
            title={
                <Link href="/" onClick={onClose} className="inline-flex items-center gap-2.5 text-lg font-medium leading-none text-stone-950 dark:text-stone-100">
                    <span
                        className="size-8 shrink-0 bg-stone-950 dark:bg-white"
                        style={{
                            mask: "url(/logo.svg) center / contain no-repeat",
                            WebkitMask: "url(/logo.svg) center / contain no-repeat",
                        }}
                    />
                    <span>XSVO</span>
                </Link>
            }
            placement="left"
            size={280}
            open={open}
            onClose={onClose}
            className="lg:hidden"
        >
            <div className="space-y-1.5">
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
                            onClick={onClose}
                            className={cn(
                                "app-shell-mobile-nav-link flex items-center gap-3 rounded-lg px-3 py-3.5 text-[15px]",
                                active ? "is-active font-medium text-stone-950 dark:text-stone-100" : "text-stone-600 hover:text-stone-950 dark:text-stone-300 dark:hover:text-stone-100",
                            )}
                        >
                            <Icon className="size-[18px]" />
                            <span>{tool.label}</span>
                        </Link>
                    );
                })}
            </div>
        </Drawer>
    );
}
