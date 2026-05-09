import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { SkillDetailPage as SharedSkillDetailPage } from "@folio/views/skills";
import { useWorkspaceId } from "@folio/core/hooks";
import { skillDetailOptions } from "@folio/core/workspace/queries";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function SkillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const wsId = useWorkspaceId();
  const { data: skill } = useQuery(skillDetailOptions(wsId, id ?? ""));

  useDocumentTitle(skill?.name ?? "Skill");

  if (!id) return null;
  return <SharedSkillDetailPage skillId={id} />;
}
