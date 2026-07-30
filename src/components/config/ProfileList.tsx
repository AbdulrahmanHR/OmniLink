import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import type { ConfigProfile } from "@/lib/mockProfiles";
import { EmptyState } from "@/components/ui/empty-state";
import { ProfileCard } from "./ProfileCard";

interface ProfileListProps {
  profiles: ConfigProfile[];
  selectedId: string | null;
  /** Id of the profile matching the active config (the applied one). */
  appliedId: string | null;
  onSelect: (id: string) => void;
}

/** Scrollable list of selectable profile cards. */
export function ProfileList({
  profiles,
  selectedId,
  appliedId,
  onSelect,
}: ProfileListProps) {
  const { t } = useTranslation();

  if (profiles.length === 0) {
    return (
      <EmptyState
        icon={FolderOpen}
        title={t("profiles.list.empty.title")}
        description={t("profiles.list.empty.description")}
        className="py-16"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2" role="listbox" aria-label={t("profiles.list.title")}>
      {profiles.map((profile) => (
        <ProfileCard
          key={profile.id}
          profile={profile}
          selected={profile.id === selectedId}
          active={profile.id === appliedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
