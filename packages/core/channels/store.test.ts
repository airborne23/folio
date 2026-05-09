import { describe, it, expect, beforeEach } from "vitest";
import { useChannelClientStore } from "./store";

describe("useChannelClientStore", () => {
  beforeEach(() => {
    useChannelClientStore.setState({ drafts: {}, openThreadByChannel: {} });
  });

  it("setDraft and clearDraft round-trip", () => {
    useChannelClientStore.getState().setDraft("c1", "hello");
    expect(useChannelClientStore.getState().drafts["c1"]).toBe("hello");
    useChannelClientStore.getState().clearDraft("c1");
    expect(useChannelClientStore.getState().drafts["c1"]).toBeUndefined();
  });

  it("setting a draft on one channel does not affect another", () => {
    useChannelClientStore.getState().setDraft("c1", "hello c1");
    useChannelClientStore.getState().setDraft("c2", "hello c2");
    expect(useChannelClientStore.getState().drafts).toEqual({
      c1: "hello c1",
      c2: "hello c2",
    });
  });

  it("openThread / closeThread independent per channel", () => {
    useChannelClientStore.getState().openThread("c1", "p1");
    useChannelClientStore.getState().openThread("c2", "p2");
    expect(useChannelClientStore.getState().openThreadByChannel).toEqual({
      c1: "p1",
      c2: "p2",
    });
    useChannelClientStore.getState().closeThread("c1");
    expect(useChannelClientStore.getState().openThreadByChannel.c1).toBeNull();
    expect(useChannelClientStore.getState().openThreadByChannel.c2).toBe("p2");
  });

  it("setDraft replaces previous value for the same channel", () => {
    useChannelClientStore.getState().setDraft("c1", "first");
    useChannelClientStore.getState().setDraft("c1", "second");
    expect(useChannelClientStore.getState().drafts["c1"]).toBe("second");
  });

  it("clearDraft on a non-existent channel is a no-op", () => {
    useChannelClientStore.getState().setDraft("c1", "kept");
    useChannelClientStore.getState().clearDraft("c2");
    expect(useChannelClientStore.getState().drafts["c1"]).toBe("kept");
  });
});
