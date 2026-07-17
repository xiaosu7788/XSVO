import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthUserHydrator } from "@/components/auth/auth-user-hydrator";
import { AdminDashboard } from "@/components/admin/admin-dashboard";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { getAuthSettings, listPublicUsers } from "@/lib/auth/store";
import { getCurrentUser } from "@/lib/auth/session";
import { countAllLibraryPrompts } from "@/lib/prompts/store";

export default async function AdminPage() {
    const currentUser = await getCurrentUser();
    if (!currentUser) redirect("/login?next=/admin");
    if (currentUser.role !== "admin") redirect("/");

    const [users, settings, promptCount] = await Promise.all([listPublicUsers(), getAuthSettings(), countAllLibraryPrompts()]);

    return (
        <AuthUserHydrator
            user={{
                id: currentUser.id,
                username: currentUser.username,
                email: currentUser.email,
                displayName: currentUser.displayName,
                role: currentUser.role,
                status: currentUser.status,
                pointsBalance: currentUser.pointsBalance,
                checkedInToday: currentUser.checkedInToday,
                lastCheckInDate: currentUser.lastCheckInDate,
            }}
        >
            <main className="h-dvh overflow-x-hidden overflow-y-auto bg-white text-stone-950 dark:bg-stone-950 dark:text-stone-100">
                <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/95 backdrop-blur-xl dark:border-stone-800 dark:bg-stone-950/95">
                    <div className="mx-auto flex h-16 max-w-[1440px] min-w-0 items-center justify-between gap-3 px-4 sm:gap-4 sm:px-6">
                        <Link href="/" className="flex min-w-0 items-center gap-2.5 text-base font-semibold text-stone-950 dark:text-stone-100">
                            <span
                                className="size-8 shrink-0 bg-stone-950 dark:bg-white"
                                style={{
                                    mask: "url(/logo.svg) center / contain no-repeat",
                                    WebkitMask: "url(/logo.svg) center / contain no-repeat",
                                }}
                            />
                            <span className="truncate">管理后台</span>
                        </Link>
                        <UserStatusActions />
                    </div>
                </header>

                <div className="mx-auto max-w-[1440px] px-3 py-4 sm:px-6 sm:py-5 lg:py-6">
                    <AdminDashboard initialUsers={users} initialSettings={settings} initialPromptCount={promptCount} currentUser={currentUser} />
                </div>
            </main>
        </AuthUserHydrator>
    );
}
