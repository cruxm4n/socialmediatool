import { cn } from "@/lib/utils";
import type { Organization, Profile } from "@/lib/types";

const SIZES = {
  sm: "size-6 text-[10px] rounded-md",
  md: "size-8 text-xs rounded-lg",
  lg: "size-11 text-sm rounded-xl",
};

export function OrgAvatar({
  organization,
  size = "md",
  className,
}: {
  organization: Pick<Organization, "initials" | "color" | "name">;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: organization.color }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold tracking-wide text-white",
        SIZES[size],
        className,
      )}
    >
      {organization.initials}
    </span>
  );
}

export function initialsOf(fullName: string): string {
  return fullName
    .split(" ")
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function PersonAvatar({
  profile,
  size = "md",
  className,
}: {
  profile: Pick<Profile, "fullName" | "role"> | undefined;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        size === "sm" ? "size-6 text-[10px]" : "size-8 text-xs",
        profile?.role === "admin" ? "bg-primary text-primary-foreground" : "bg-brand-soft text-brand",
        className,
      )}
    >
      {profile ? initialsOf(profile.fullName) : "•"}
    </span>
  );
}
