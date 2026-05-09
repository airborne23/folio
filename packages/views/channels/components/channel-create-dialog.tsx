"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@folio/ui/components/ui/dialog";
import { Button } from "@folio/ui/components/ui/button";
import { Input } from "@folio/ui/components/ui/input";
import { Label } from "@folio/ui/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@folio/ui/components/ui/radio-group";
import { useCreateChannel } from "@folio/core/channels";
import { useT } from "../../i18n";

export function ChannelCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"public" | "private">("public");
  const create = useCreateChannel();
  const { t } = useT("channels");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const c = await create.mutateAsync({ name: trimmed, kind });
      setName("");
      setKind("public");
      onOpenChange(false);
      onCreated?.(c.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.create_dialog.create_failed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.create_dialog.title)}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-name">{t(($) => $.create_dialog.name_label)}</Label>
            <Input
              id="channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t(($) => $.create_dialog.name_placeholder)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t(($) => $.create_dialog.visibility_label)}</Label>
            <RadioGroup
              value={kind}
              onValueChange={(v) => setKind(v as "public" | "private")}
            >
              <div className="flex gap-3 items-center">
                <RadioGroupItem value="public" id="vp" />
                <Label htmlFor="vp">{t(($) => $.create_dialog.kind_public)}</Label>
              </div>
              <div className="flex gap-3 items-center">
                <RadioGroupItem value="private" id="vr" />
                <Label htmlFor="vr">{t(($) => $.create_dialog.kind_private)}</Label>
              </div>
            </RadioGroup>
          </div>
          <Button
            disabled={!name.trim() || create.isPending}
            onClick={() => void submit()}
          >
            {create.isPending ? t(($) => $.create_dialog.submitting) : t(($) => $.create_dialog.submit)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
