import {
  Bell,
  Building2,
  CalendarDays,
  CircleCheckBig,
  FileText,
  History,
  LayoutDashboard,
  PenLine,
  RefreshCw,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** true : actif uniquement sur l'URL exacte (page d'accueil d'un espace). */
  exact?: boolean;
}

export const ADMIN_NAV: NavItem[] = [
  { label: "Vue d'ensemble", href: "/admin", icon: LayoutDashboard, exact: true },
  { label: "Studio", href: "/admin/studio", icon: PenLine },
  { label: "Calendrier", href: "/admin/calendrier", icon: CalendarDays },
  { label: "Publications", href: "/admin/publications", icon: FileText },
  { label: "Clients", href: "/admin/clients", icon: Building2 },
  { label: "Synchronisation", href: "/admin/synchronisation", icon: RefreshCw },
  { label: "Notifications", href: "/admin/notifications", icon: Bell },
  { label: "Paramètres", href: "/admin/parametres", icon: Settings },
];

export function clientNav(orgSlug: string): NavItem[] {
  const base = `/client/${orgSlug}`;
  return [
    { label: "Vue d'ensemble", href: base, icon: LayoutDashboard, exact: true },
    { label: "Calendrier", href: `${base}/calendrier`, icon: CalendarDays },
    { label: "À valider", href: `${base}/a-valider`, icon: CircleCheckBig },
    { label: "Publications", href: `${base}/publications`, icon: FileText },
    { label: "Historique", href: `${base}/historique`, icon: History },
  ];
}

export function isActive(item: NavItem, pathname: string | null): boolean {
  if (!pathname) return false;
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}
