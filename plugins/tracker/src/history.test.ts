import { describe, expect, it } from "bun:test";
import type { TaskEvent } from "@rackbops/docket-core";
import { LEFT_DETAIL, PAUSE_DETAIL, recipientPauseDetail } from "./delivery-health.js";
import { changesForRecipient, NEUTRAL_PAUSE } from "./history.js";

const row = (kind: TaskEvent["kind"], detail: string): TaskEvent => ({ id: "e1", taskId: "t1", actorId: null, kind, detail, at: "2026-10-01T13:00:00.000Z" });
const read = (events: TaskEvent[], viewer = "u4") => changesForRecipient(events, viewer).map((e) => `${e.kind}: ${e.detail}`);

describe("changesForRecipient (#273: another recipient's pause, as a recipient who is not its owner sees it)", () => {
  it("another recipient's pause reads as the task's own, and the resume after it as its own resume", () => {
    expect(read([row("paused", recipientPauseDetail("u3")), row("resumed", "delivery resumed")])).toEqual([`paused: ${NEUTRAL_PAUSE}`, "resumed: delivery resumed"]);
    // The owner going on without them reads as the owner's own delivery resuming.
    expect(read([row("paused", recipientPauseDetail("u3")), row("resumed", "resumed by the owner")])).toEqual([`paused: ${NEUTRAL_PAUSE}`, "resumed: delivery resumed"]);
    // A pause by hand keeps its own resume.
    expect(read([row("paused", "paused by the owner"), row("resumed", "resumed by the owner")])).toEqual(["paused: paused by the owner", "resumed: resumed by the owner"]);
  });

  it("their own pause and a pause by hand read as stored", () => {
    for (const detail of [recipientPauseDetail("u4"), "paused by the owner"]) {
      expect(read([row("paused", detail), row("resumed", "delivery resumed")])).toEqual([`paused: ${detail}`, "resumed: delivery resumed"]);
    }
  });

  it("the owner's own delivery pause reads exactly as another recipient's does", () => {
    const owners = read([row("paused", PAUSE_DETAIL), row("resumed", "delivery resumed")]);
    expect(owners).toEqual([`paused: ${NEUTRAL_PAUSE}`, "resumed: delivery resumed"]);
    expect(read([row("paused", recipientPauseDetail("u3")), row("resumed", "delivery resumed")])).toEqual(owners);
  });

  it("a resume that says a recipient left reads neutrally; one with no pause shown above it is left out", () => {
    expect(read([row("paused", recipientPauseDetail("u3")), row("resumed", LEFT_DETAIL)])).toEqual([`paused: ${NEUTRAL_PAUSE}`, "resumed: delivery resumed"]);
    expect(read([row("created", "reminder"), row("resumed", LEFT_DETAIL)])).toEqual(["created: reminder"]);
    expect(read([row("resumed", "delivery resumed")])).toEqual([]);
  });

  it("another recipient's pause while the task already shows paused adds no second pause", () => {
    expect(read([row("paused", recipientPauseDetail("u4")), row("paused", recipientPauseDetail("u3")), row("resumed", "delivery resumed")])).toEqual([
      `paused: ${recipientPauseDetail("u4")}`,
      "resumed: delivery resumed",
    ]);
  });
});
