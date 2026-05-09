import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  createWorkspaceAwareStorage,
  registerForWorkspaceRehydration,
} from "../platform/workspace-storage";
import { defaultStorage } from "../platform/storage";

interface SidebarExpansionState {
  /** Per-section expanded flag. Keyed by a stable section id chosen by the
   *  caller (e.g. "channels", "projects"). Persisted per-workspace so each
   *  workspace independently remembers which trees the user opened. */
  expanded: Record<string, boolean>;
  isExpanded: (sectionId: string, defaultOpen?: boolean) => boolean;
  toggle: (sectionId: string) => void;
  setExpanded: (sectionId: string, expanded: boolean) => void;
}

export const useSidebarExpansionStore = create<SidebarExpansionState>()(
  persist(
    (set, get) => ({
      expanded: {},
      isExpanded: (sectionId, defaultOpen = false) => {
        const v = get().expanded[sectionId];
        return v === undefined ? defaultOpen : v;
      },
      toggle: (sectionId) =>
        set((s) => ({
          expanded: { ...s.expanded, [sectionId]: !s.expanded[sectionId] },
        })),
      setExpanded: (sectionId, expanded) =>
        set((s) => ({ expanded: { ...s.expanded, [sectionId]: expanded } })),
    }),
    {
      name: "folio_sidebar_expansion",
      storage: createJSONStorage(() => createWorkspaceAwareStorage(defaultStorage)),
    },
  ),
);

registerForWorkspaceRehydration(() =>
  useSidebarExpansionStore.persist.rehydrate(),
);
