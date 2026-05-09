"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@folio/ui/components/ui/button";
import { Textarea } from "@folio/ui/components/ui/textarea";
import {
  channelMembersOptions,
  useChannelClientStore,
  useSendChannelMessage,
} from "@folio/core/channels";
import { useWorkspaceId } from "@folio/core/hooks";
import {
  agentListOptions,
  memberListOptions,
} from "@folio/core/workspace/queries";
import { useT } from "../../i18n";
import {
  ChannelMentionPicker,
  type MentionCandidate,
} from "./channel-mention-picker";

// Token chars matching the server-side regex (\p{L}\p{N}_\-). Walking back
// from the cursor we accept letters/numbers (including CJK), underscore,
// and hyphen — same vocabulary the server will tokenize.
const MENTION_TOKEN_CHAR = /[\p{L}\p{N}_\-]/u;

interface MentionMatch {
  /** Index of the `@` in the body. */
  start: number;
  /** End index (exclusive) — equal to the cursor position. */
  end: number;
  /** Text after the `@` and before the cursor (lowercased for filtering). */
  query: string;
}

/**
 * Find an open `@token` immediately before `cursor` in `body`. Returns null
 * when there's no `@` in scope (cursor inside whitespace, no @ found, or
 * an unclosed token contains a space).
 *
 * Examples (cursor marked as |):
 *   "hi @ar|"       → { start: 3, end: 6, query: "ar" }
 *   "@系统|"        → { start: 0, end: 3, query: "系统" }
 *   "hi @|"         → { start: 3, end: 4, query: "" }     (just opened)
 *   "hi @x y|"      → null                                 (closed by space)
 *   "no at"         → null
 */
function findActiveMention(body: string, cursor: number): MentionMatch | null {
  let i = cursor - 1;
  while (i >= 0 && MENTION_TOKEN_CHAR.test(body[i]!)) i--;
  // i now points at the char that broke the run, or -1.
  if (i < 0 || body[i] !== "@") return null;
  // The `@` must be at start-of-string, after whitespace, or after a
  // non-word punctuation. This stops `email@addr|` from triggering the
  // picker — the char before `@` would be a letter, not whitespace/punct.
  if (i > 0) {
    const prev = body[i - 1]!;
    if (MENTION_TOKEN_CHAR.test(prev)) return null;
  }
  return {
    start: i,
    end: cursor,
    query: body.slice(i + 1, cursor).toLowerCase(),
  };
}

export function ChannelComposer({
  channelId,
  parentMessageId,
}: {
  channelId: string;
  parentMessageId?: string;
}) {
  // Thread replies and the main composer must not share a draft — typing a
  // half-finished message in #general and then opening a thread would carry
  // the draft into the wrong context. Encoding the parent into the draft key
  // gives them isolated buffers.
  const draftKey = parentMessageId ? `${channelId}:${parentMessageId}` : channelId;
  const draft = useChannelClientStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useChannelClientStore((s) => s.setDraft);
  const clearDraft = useChannelClientStore((s) => s.clearDraft);
  const send = useSendChannelMessage(channelId);
  const [submitting, setSubmitting] = useState(false);
  const { t } = useT("channels");

  const wsId = useWorkspaceId();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: channelMembers = [] } = useQuery(
    channelMembersOptions(wsId, channelId),
  );

  // Mention state: cursor / active token tracked locally so a parent re-
  // render driven by draft changes doesn't lose the picker.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeMention, setActiveMention] = useState<MentionMatch | null>(null);
  const [highlight, setHighlight] = useState(0);

  // Build the mention candidate list.
  //
  //   - Agents: workspace-wide list, filtered to non-archived, plus a
  //     "(in channel)" subtitle when the agent is already a channel member —
  //     useful hint that subscribe-mode agents will fire on this @-mention.
  //   - Members: channel members only. Mentioning a non-member just lights
  //     up the chip; the server still resolves the name.
  //
  // Filter by query: case-insensitive prefix or substring on the name.
  // Substring (rather than prefix) matters for CJK names where the user
  // might remember the latter half of the name first.
  const candidates = useMemo<MentionCandidate[]>(() => {
    if (!activeMention) return [];
    const q = activeMention.query;
    const channelAgentIds = new Set(
      channelMembers
        .filter((m) => m.member_type === "agent")
        .map((m) => m.member_id),
    );
    const channelMemberIds = new Set(
      channelMembers
        .filter((m) => m.member_type === "member")
        .map((m) => m.member_id),
    );
    const list: MentionCandidate[] = [];
    for (const a of agents) {
      if (a.archived_at) continue;
      const lower = a.name.toLowerCase();
      if (q && !lower.includes(q)) continue;
      list.push({
        type: "agent",
        id: a.id,
        name: a.name,
        subtitle: channelAgentIds.has(a.id) ? "in channel" : undefined,
      });
    }
    for (const m of members) {
      if (!m.name) continue;
      const lower = m.name.toLowerCase();
      if (q && !lower.includes(q)) continue;
      list.push({
        type: "member",
        id: m.id,
        name: m.name,
        subtitle: channelMemberIds.has(m.id) ? "in channel" : undefined,
      });
    }
    // Stable sort: agents above members, in-channel above out-of-channel.
    return list.sort((a, b) => {
      if (a.type !== b.type) return a.type === "agent" ? -1 : 1;
      const aIn = a.subtitle === "in channel" ? 0 : 1;
      const bIn = b.subtitle === "in channel" ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;
      return a.name.localeCompare(b.name);
    });
  }, [agents, members, channelMembers, activeMention]);

  const closePicker = () => {
    setActiveMention(null);
    setHighlight(0);
  };

  const onChange = (next: string, cursorOverride?: number) => {
    setDraft(draftKey, next);
    const cursor =
      cursorOverride ??
      textareaRef.current?.selectionStart ??
      next.length;
    const match = findActiveMention(next, cursor);
    setActiveMention(match);
    if (match) setHighlight(0);
  };

  const insertCandidate = (c: MentionCandidate) => {
    if (!activeMention) return;
    const before = draft.slice(0, activeMention.start);
    const after = draft.slice(activeMention.end);
    // Trailing space so the next thing typed isn't glued to the name.
    const insert = `@${c.name} `;
    const next = before + insert + after;
    setDraft(draftKey, next);
    closePicker();
    // Move cursor just past the inserted name + space.
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = before.length + insert.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition guard: while a CJK / Japanese / Korean input method is
    // open, Enter belongs to the IME (commit candidate) and must NOT trigger
    // submit or mention insertion. `isComposing` is the modern signal;
    // keyCode === 229 is the legacy fallback for browsers/runtimes that
    // don't propagate isComposing on the synthetic event. Without this guard
    // a single Enter both commits the candidate AND fires onSubmit, sending
    // half-typed messages.
    const isImeComposing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (activeMention && candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !isImeComposing) {
        e.preventDefault();
        insertCandidate(candidates[highlight]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePicker();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !isImeComposing) {
      e.preventDefault();
      void onSubmit();
    }
  };

  const onSubmit = async () => {
    const body = draft.trim();
    if (!body) return;
    setSubmitting(true);
    try {
      await send.mutateAsync({ body, parentMessageId });
      clearDraft(draftKey);
      closePicker();
    } catch (err) {
      // Preserve draft so the user can edit and retry.
      toast.error(
        err instanceof Error ? err.message : t(($) => $.composer.send_failed),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t p-2 flex gap-2 relative">
      {activeMention && (
        <ChannelMentionPicker
          candidates={candidates}
          selectedIndex={highlight}
          onPick={insertCandidate}
          onHover={setHighlight}
          emptyHint={t(($) => $.composer.mention_picker_empty)}
        />
      )}
      <Textarea
        ref={textareaRef}
        data-testid={
          parentMessageId ? "thread-composer-textarea" : "channel-composer-textarea"
        }
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onSelect={() => {
          // Cursor moved without text changes (arrow keys, click). Re-evaluate
          // whether the new caret position sits inside an @-token.
          const cursor = textareaRef.current?.selectionStart ?? draft.length;
          const match = findActiveMention(draft, cursor);
          setActiveMention(match);
          if (match) setHighlight(0);
        }}
        onBlur={() => {
          // Defer so a click on a picker option (which steals focus to
          // textarea on mousedown) can still fire its onPick before we
          // close. The picker's onMouseDown preventDefault keeps focus in
          // the textarea, so blur shouldn't fire there in practice.
          setTimeout(closePicker, 100);
        }}
        onKeyDown={onKeyDown}
        placeholder={
          parentMessageId
            ? t(($) => $.composer.placeholder_thread)
            : t(($) => $.composer.placeholder_main)
        }
        rows={2}
        className="flex-1"
      />
      <Button
        onClick={() => void onSubmit()}
        disabled={submitting || !draft.trim()}
      >
        {t(($) => $.composer.send)}
      </Button>
    </div>
  );
}
