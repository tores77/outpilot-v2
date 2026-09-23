import { describe, expect, it, vi } from "vitest";
import { fetchAllMailboxes } from "@/channels/lemlist/mailboxes";
import type { LemlistClient } from "@/channels/lemlist/client";
import { lemlistUserFixture } from "../../fixtures/lemlist";

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

describe("fetchAllMailboxes", () => {
  it("recorre /team → /users/:id y aplana los mailboxes", async () => {
    const getMock = vi.fn(async (path: string) => {
      if (path === "/team") {
        return { _id: "tea_x", userIds: ["usr_a", "usr_b"] };
      }
      if (path === "/users/usr_a") return lemlistUserFixture;
      if (path === "/users/usr_b") {
        return {
          _id: "usr_b",
          email: "second@example.com",
          mailboxes: [
            {
              _id: "usm_b1",
              email: "sender-c@example.com",
              provider: "outlook",
              status: "paused",
              lemlist: { emailLimit: 15 },
              lemwarm: { active: false },
            },
          ],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const client = makeMockClient({
      get: getMock as unknown as LemlistClient["get"],
    });

    const boxes = await fetchAllMailboxes(client);

    // 2 del fixture (usr_a) + 1 del sintetico (usr_b)
    expect(boxes).toHaveLength(3);
    expect(boxes[0]).toEqual({
      externalId: "usm_FIXTURE_mailbox_a",
      email: "sender-a@example.com",
      provider: "google",
      status: "OK",
      emailLimit: 30,
      warmupActive: true,
      healthScore: null,
    });
    expect(boxes[2]).toEqual({
      externalId: "usm_b1",
      email: "sender-c@example.com",
      provider: "outlook",
      status: "paused",
      emailLimit: 15,
      warmupActive: false,
      healthScore: null,
    });
  });

  it("devuelve [] si /team no expone userIds", async () => {
    const client = makeMockClient({
      get: (async () => ({ _id: "tea_x" })) as unknown as LemlistClient["get"],
    });
    const boxes = await fetchAllMailboxes(client);
    expect(boxes).toEqual([]);
  });

  it("descarta mailboxes sin _id o sin email (defensivo, no lanza)", async () => {
    const client = makeMockClient({
      get: (async (path: string) => {
        if (path === "/team") return { userIds: ["usr_a"] };
        return {
          _id: "usr_a",
          mailboxes: [
            { _id: "usm_ok", email: "ok@example.com", provider: "google", status: "OK" },
            { email: "no-id@example.com" }, // sin _id
            { _id: "usm_no_email" }, // sin email
            null, // trash
          ],
        };
      }) as unknown as LemlistClient["get"],
    });
    const boxes = await fetchAllMailboxes(client);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].externalId).toBe("usm_ok");
  });

  it("propaga si el client lanza (para que la page capture y muestre error)", async () => {
    const client = makeMockClient({
      get: (async () => {
        throw new Error("network boom");
      }) as unknown as LemlistClient["get"],
    });
    await expect(fetchAllMailboxes(client)).rejects.toThrow(/network boom/);
  });
});
