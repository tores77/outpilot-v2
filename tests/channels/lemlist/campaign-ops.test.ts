import { describe, expect, it, vi } from "vitest";
import type { LemlistClient } from "@/channels/lemlist/client";
import {
  addSequenceStep,
  associateSchedule,
  createLemlistCampaign,
  createSchedule,
  findScheduleMatching,
  getCampaignSchedules,
  getCampaignSequences,
  getLemlistCampaign,
  patchSchedule,
} from "@/channels/lemlist/campaign-ops";

function makeMockClient(overrides: Partial<LemlistClient> = {}): LemlistClient {
  const noop = async () => undefined as unknown;
  return {
    get: noop as LemlistClient["get"],
    post: noop as LemlistClient["post"],
    patch: noop as LemlistClient["patch"],
    delete: noop as LemlistClient["delete"],
    ...overrides,
  };
}

describe("createLemlistCampaign", () => {
  it("POST /campaigns con body {name, senderStrategy: random} y devuelve _id", async () => {
    const post = vi.fn(async () => ({ _id: "cam_new", scheduleIds: [] }));
    const client = makeMockClient({
      post: post as unknown as LemlistClient["post"],
    });
    const res = await createLemlistCampaign(client, { name: "Test" });
    expect(res._id).toBe("cam_new");
    expect(post).toHaveBeenCalledWith("/campaigns", {
      name: "Test",
      senderStrategy: "random",
    });
  });

  it("throws si el response no trae _id", async () => {
    const client = makeMockClient({
      post: (async () => ({})) as unknown as LemlistClient["post"],
    });
    await expect(createLemlistCampaign(client, { name: "x" })).rejects.toThrow(
      /sin _id/,
    );
  });
});

describe("getLemlistCampaign", () => {
  it("GET /campaigns/:cid y devuelve el shape", async () => {
    const get = vi.fn(async () => ({
      _id: "cam_x",
      status: "draft",
      name: "Test",
    }));
    const client = makeMockClient({
      get: get as unknown as LemlistClient["get"],
    });
    const res = await getLemlistCampaign(client, "cam_x");
    expect(res).toEqual({ _id: "cam_x", status: "draft", name: "Test" });
    expect(get).toHaveBeenCalledWith("/campaigns/cam_x");
  });
});

describe("getCampaignSchedules", () => {
  it("GET /campaigns/:cid/schedules devuelve array", async () => {
    const get = vi.fn(async () => [
      { _id: "skd_1", timezone: "Europe/Madrid", start: "09:00", end: "11:00" },
    ]);
    const client = makeMockClient({
      get: get as unknown as LemlistClient["get"],
    });
    const res = await getCampaignSchedules(client, "cam_x");
    expect(res).toHaveLength(1);
    expect(res[0]._id).toBe("skd_1");
  });

  it("devuelve [] si la respuesta no es array (defensivo)", async () => {
    const get = vi.fn(async () => null);
    const client = makeMockClient({
      get: get as unknown as LemlistClient["get"],
    });
    expect(await getCampaignSchedules(client, "cam_x")).toEqual([]);
  });
});

describe("patchSchedule / createSchedule / associateSchedule", () => {
  const scheduleBody = {
    name: "Volt morning 09-11",
    timezone: "Europe/Madrid",
    start: "09:00",
    end: "11:00",
    weekdays: [2, 3, 4],
    secondsToWait: 1200,
  };

  it("patchSchedule → PATCH /schedules/:sid con body", async () => {
    const patch = vi.fn(async () => ({ _id: "skd_1" }));
    const client = makeMockClient({
      patch: patch as unknown as LemlistClient["patch"],
    });
    await patchSchedule(client, "skd_1", scheduleBody);
    expect(patch).toHaveBeenCalledWith("/schedules/skd_1", scheduleBody);
  });

  it("createSchedule → POST /schedules con body; throw si no _id", async () => {
    const postOk = vi.fn(async () => ({ _id: "skd_new" }));
    const clientOk = makeMockClient({
      post: postOk as unknown as LemlistClient["post"],
    });
    const res = await createSchedule(clientOk, scheduleBody);
    expect(res._id).toBe("skd_new");
    expect(postOk).toHaveBeenCalledWith("/schedules", scheduleBody);

    const postBad = vi.fn(async () => ({}));
    const clientBad = makeMockClient({
      post: postBad as unknown as LemlistClient["post"],
    });
    await expect(createSchedule(clientBad, scheduleBody)).rejects.toThrow(
      /sin _id/,
    );
  });

  it("associateSchedule → POST /campaigns/:cid/schedules/:sid con body undefined", async () => {
    const post = vi.fn(async () => ({}));
    const client = makeMockClient({
      post: post as unknown as LemlistClient["post"],
    });
    await associateSchedule(client, "cam_x", "skd_1");
    expect(post).toHaveBeenCalledWith(
      "/campaigns/cam_x/schedules/skd_1",
      undefined,
    );
  });
});

describe("findScheduleMatching", () => {
  const target = {
    name: "Volt afternoon 15-17",
    timezone: "Europe/Madrid",
    start: "15:00",
    end: "17:00",
    weekdays: [2, 3, 4],
    secondsToWait: 1200,
  };

  it("devuelve _id si hay un schedule con mismo shape lógico", () => {
    const schedules = [
      { _id: "skd_a", timezone: "Europe/Madrid", start: "09:00", end: "11:00", weekdays: [2, 3, 4], secondsToWait: 1200 },
      { _id: "skd_b", timezone: "Europe/Madrid", start: "15:00", end: "17:00", weekdays: [2, 3, 4], secondsToWait: 1200 },
    ];
    expect(findScheduleMatching(schedules, target)).toBe("skd_b");
  });

  it("null si no hay match (timezone distinto)", () => {
    const schedules = [
      { _id: "skd_a", timezone: "Europe/Paris", start: "15:00", end: "17:00", weekdays: [2, 3, 4], secondsToWait: 1200 },
    ];
    expect(findScheduleMatching(schedules, target)).toBeNull();
  });

  it("match aunque weekdays estén en orden distinto", () => {
    const schedules = [
      { _id: "skd_a", timezone: "Europe/Madrid", start: "15:00", end: "17:00", weekdays: [4, 3, 2], secondsToWait: 1200 },
    ];
    expect(findScheduleMatching(schedules, target)).toBe("skd_a");
  });

  it("null si secondsToWait distinto", () => {
    const schedules = [
      { _id: "skd_a", timezone: "Europe/Madrid", start: "15:00", end: "17:00", weekdays: [2, 3, 4], secondsToWait: 600 },
    ];
    expect(findScheduleMatching(schedules, target)).toBeNull();
  });
});

describe("getCampaignSequences", () => {
  it("GET /campaigns/:cid/sequences devuelve mapa sequenceId → {steps}", async () => {
    const get = vi.fn(async () => ({
      seq_x: { _id: "seq_x", steps: [{ _id: "stp_1" }] },
    }));
    const client = makeMockClient({
      get: get as unknown as LemlistClient["get"],
    });
    const res = await getCampaignSequences(client, "cam_x");
    expect(Object.keys(res)).toEqual(["seq_x"]);
    expect(res.seq_x.steps).toHaveLength(1);
  });
});

describe("addSequenceStep", () => {
  it("POST /sequences/:sid/steps con {type, subject, message, delay}; throw si no _id", async () => {
    const post = vi.fn(async () => ({
      _id: "stp_new",
      type: "email",
      delay: 0,
      emailTemplateId: "etp_1",
      message: "<p>x</p>",
    }));
    const client = makeMockClient({
      post: post as unknown as LemlistClient["post"],
    });
    const body = {
      type: "email" as const,
      subject: "s",
      message: "<p>m</p>",
      delay: 4,
    };
    const res = await addSequenceStep(client, "seq_x", body);
    expect(res._id).toBe("stp_new");
    expect(post).toHaveBeenCalledWith("/sequences/seq_x/steps", body);

    const postBad = vi.fn(async () => ({}));
    const clientBad = makeMockClient({
      post: postBad as unknown as LemlistClient["post"],
    });
    await expect(addSequenceStep(clientBad, "seq_x", body)).rejects.toThrow(
      /sin _id/,
    );
  });
});
