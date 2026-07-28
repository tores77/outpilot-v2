"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "./sign-out-button";

const NAV_ITEMS = [
  { label: "Radar", href: "/radar" },
  { label: "Campaigns", href: "/campaigns" },
  { label: "Inbox", href: "/inbox" },
  { label: "Settings", href: "/settings" },
] as const;

type SidebarProps = {
  displayName: string;
  role: string;
};

export function Sidebar({ displayName, role }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 flex-shrink-0 flex-col gap-8 border-r border-hairline px-6 py-8">
      <Link href="/" className="block">
        <span className="font-display text-xl font-semibold tracking-tight">
          OUTPILOT
        </span>
        <span className="mt-1 block text-[10px] uppercase tracking-[0.25em] text-muted">
          Umania Labs · v2
        </span>
      </Link>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-accent/10 text-accent"
                  : "text-foreground/70 hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-3 border-t border-hairline pt-4">
        <div>
          <p className="text-sm text-foreground/80">{displayName}</p>
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted">
            {role}
          </p>
        </div>
        <SignOutButton />
      </div>
    </aside>
  );
}
