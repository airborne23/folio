import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyChannelEvent } from "./ws-updaters";

function makeQC() {
  return new QueryClient();
}

describe("applyChannelEvent", () => {
  it("invalidates list on channel:created", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, { type: "channel:created", payload: {}, workspace_id: "ws-1" });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channels", "ws-1", "list"] });
  });

  it("invalidates list on channel:archived", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, { type: "channel:archived", payload: {}, workspace_id: "ws-1" });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channels", "ws-1", "list"] });
  });

  it("invalidates list and detail on channel:updated", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:updated",
      workspace_id: "ws-1",
      payload: { id: "c1" },
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channels", "ws-1", "list"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channels", "ws-1", "detail", "c1"] });
  });

  it("invalidates only list on channel:updated when no id in payload", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:updated",
      workspace_id: "ws-1",
      payload: {},
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channels", "ws-1", "list"] });
  });

  it("invalidates list and members on channel:member:added", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:member:added",
      workspace_id: "ws-1",
      payload: { channel_id: "c1", member_type: "member", member_id: "m1" },
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channels", "ws-1", "list"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channels", "ws-1", "members", "c1"] });
  });

  it("invalidates list and members on channel:member:removed", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:member:removed",
      workspace_id: "ws-1",
      payload: { channel_id: "c1", member_id: "m1" },
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channels", "ws-1", "list"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channels", "ws-1", "members", "c1"] });
  });

  it("invalidates messages on channel:message:created", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:message:created",
      workspace_id: "ws-1",
      payload: { channel_id: "c1", id: "m1" },
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channel", "messages", "c1"] });
  });

  it("invalidates messages on channel:message:patched", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:message:patched",
      workspace_id: "ws-1",
      payload: { channel_id: "c1", id: "m1" },
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channel", "messages", "c1"] });
  });

  it("invalidates messages on channel:message:completed", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:message:completed",
      workspace_id: "ws-1",
      payload: { channel_id: "c1", id: "m1" },
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channel", "messages", "c1"] });
  });

  it("invalidates messages + thread on channel:thread:rollup", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:thread:rollup",
      workspace_id: "ws-1",
      payload: { channel_id: "c1", parent_message_id: "p1", reply_count: 3 },
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channel", "messages", "c1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channel", "thread", "c1", "p1"] });
  });

  it("invalidates only messages on channel:thread:rollup when no parent_message_id", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:thread:rollup",
      workspace_id: "ws-1",
      payload: { channel_id: "c1" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channel", "messages", "c1"] });
  });

  it("invalidates messages on channel:reaction:added", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    // Server wraps the reaction row in ChannelReactionAddedPayload because the
    // bare db.ChannelMessageReaction has no channel_id column. The updater
    // reads channel_id off the top of the payload.
    applyChannelEvent(qc, {
      type: "channel:reaction:added",
      workspace_id: "ws-1",
      payload: {
        channel_id: "c1",
        reaction: {
          id: "r1",
          message_id: "m1",
          reactor_type: "member",
          reactor_id: "u1",
          emoji: "👍",
        },
      },
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channel", "messages", "c1"] });
  });

  it("invalidates messages on channel:reaction:removed", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:reaction:removed",
      workspace_id: "ws-1",
      payload: { message_id: "m1", channel_id: "c1", emoji: "👍" },
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channel", "messages", "c1"] });
  });

  it("ignores unknown event types", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:something:weird",
      workspace_id: "ws-1",
      payload: {},
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not throw when channel_id is missing from message payload", () => {
    const qc = makeQC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      type: "channel:message:created",
      workspace_id: "ws-1",
      payload: {},
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
