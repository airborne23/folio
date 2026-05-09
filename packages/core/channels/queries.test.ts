import { describe, it, expect } from "vitest";
import { channelKeys } from "./queries";

describe("channelKeys", () => {
  it("derives a stable list key per workspace", () => {
    expect(channelKeys.list("ws-1")).toEqual(["channels", "ws-1", "list"]);
    expect(channelKeys.list("ws-2")).toEqual(["channels", "ws-2", "list"]);
  });

  it("derives a detail key per (workspace, channel)", () => {
    expect(channelKeys.detail("ws-1", "ch-1")).toEqual([
      "channels",
      "ws-1",
      "detail",
      "ch-1",
    ]);
  });

  it("derives a members key per (workspace, channel)", () => {
    expect(channelKeys.members("ws-1", "ch-1")).toEqual([
      "channels",
      "ws-1",
      "members",
      "ch-1",
    ]);
  });

  it("messages key is workspace-independent (channelId is globally unique)", () => {
    expect(channelKeys.messages("ch-1")).toEqual(["channel", "messages", "ch-1"]);
  });

  it("thread key takes both channelId and parentId", () => {
    expect(channelKeys.thread("ch-1", "msg-1")).toEqual([
      "channel",
      "thread",
      "ch-1",
      "msg-1",
    ]);
  });

  it("list keys for different workspaces are distinct", () => {
    const k1 = channelKeys.list("ws-1");
    const k2 = channelKeys.list("ws-2");
    expect(k1).not.toEqual(k2);
  });

  it("detail keys for different channels in same workspace are distinct", () => {
    const k1 = channelKeys.detail("ws-1", "ch-1");
    const k2 = channelKeys.detail("ws-1", "ch-2");
    expect(k1).not.toEqual(k2);
  });

  it("all key is a prefix of list, detail, and members", () => {
    const all = channelKeys.all("ws-1");
    expect(channelKeys.list("ws-1").slice(0, all.length)).toEqual([...all]);
    expect(channelKeys.detail("ws-1", "ch-1").slice(0, all.length)).toEqual([...all]);
    expect(channelKeys.members("ws-1", "ch-1").slice(0, all.length)).toEqual([...all]);
  });
});
