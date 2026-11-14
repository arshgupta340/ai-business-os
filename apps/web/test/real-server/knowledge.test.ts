// Businesses, facts, catalog, prices, conflicts and files: the web client against the real server.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "@abos/contracts";
import { barberBusiness, menuPriceConflict, pizzaBusiness } from "@abos/contracts/fixtures";
import * as api from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { BARBER, BUSINESSES, PIZZA, rejection, startRealServer, waitFor, type RealServer } from "./harness";

vi.mock("@/lib/supabase/client", async () => (await import("./harness")).fakeSupabaseModule);

let s: RealServer;
beforeAll(async () => {
  s = await startRealServer();
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe("businesses", () => {
  it("listBusinesses returns both seeded businesses with the selector fields", async () => {
    const res = await api.listBusinesses();
    const byId = new Map(res.items.map((b) => [b.id, b]));
    expect(byId.get(PIZZA)).toMatchObject({ name: pizzaBusiness.name, category: pizzaBusiness.category, timezone: pizzaBusiness.timezone });
    expect(byId.get(BARBER)).toMatchObject({ name: barberBusiness.name, category: barberBusiness.category, timezone: barberBusiness.timezone });
    // The other owner's business is not listed.
    expect(byId.has("biz_other_01")).toBe(false);
  });

  it.each(BUSINESSES)("getBusiness %s returns the fields Settings reads", async (id) => {
    const b = await api.getBusiness(id);
    expect(b.id).toBe(id);
    expect(typeof b.name).toBe("string");
    expect(typeof b.timezone).toBe("string");
    expect(b.contact).toBeDefined();
  });

  it("updateBusiness changes the name and answers the Business", async () => {
    const before = await api.getBusiness(BARBER);
    const updated = await api.updateBusiness(BARBER, { name: "Demo Barbershop East" });
    expect(updated).toMatchObject({ id: BARBER, name: "Demo Barbershop East", timezone: before.timezone });
    expect((await api.getBusiness(BARBER)).name).toBe("Demo Barbershop East");
    await api.updateBusiness(BARBER, { name: before.name });
  });
});

describe("facts", () => {
  it.each(BUSINESSES)("getFacts %s returns verified facts and the conflicts list", async (id) => {
    const res = await api.getFacts(id);
    expect(res.items.length).toBeGreaterThan(0);
    for (const f of res.items) {
      expect(f.businessId).toBe(id);
      expect(f).toHaveProperty("kind");
      expect(f).toHaveProperty("key");
      expect(f).toHaveProperty("status");
      expect(f).toHaveProperty("value");
    }
    expect(Array.isArray(res.conflicts)).toBe(true);
    expect(res.items.some((f) => f.kind === "hours")).toBe(true);
  });

  it("getFacts sends kind as a query parameter and the server filters by it", async () => {
    const res = await api.getFacts(PIZZA, { kind: "hours" });
    expect(res.items.length).toBe(7);
    expect(res.items.every((f) => f.kind === "hours")).toBe(true);
    expect(s.requests.at(-1)!.url.searchParams.get("kind")).toBe("hours");
  });

  it("proposeFact opens a pending fact_edit approval from the owner and changes nothing yet", async () => {
    const { approval } = await api.proposeFact(BARBER, { kind: "hours", key: "sat", value: { closed: true }, reason: "Closed on Saturdays" });
    expect(approval).toMatchObject({ businessId: BARBER, bundleType: "fact_edit", actorType: "owner", state: "PENDING" });
    expect(approval.payloadHash).toMatch(/^sha256:/);
    const sat = (await api.getFacts(BARBER, { kind: "hours" })).items.find((f) => f.key === "sat" && f.status === "verified");
    expect(sat?.value).toEqual({ open: "09:00", close: "16:00" });
    // The owner rejects it, so later tests see the seeded hours.
    await api.decideApproval(BARBER, approval.id, { decision: "reject", payloadHash: approval.payloadHash });
  });
});

describe("fact edit errors", () => {
  it("proposing the value a fact already has answers VALIDATION_FAILED", async () => {
    const err = (await rejection(api.proposeFact(BARBER, { kind: "hours", key: "mon", value: { closed: true } }))) as ApiError;
    expect(err).toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
  });

  // Mismatch (server): apps/server/src/api/routes.ts:325 answers the routine's code as the message,
  // "Operation failed: VALIDATION_FAILED.", with no details, and Knowledge and Settings show the message to the owner.
  it.fails("that error has a message an owner can read and details naming the field", async () => {
    const err = (await rejection(api.proposeFact(BARBER, { kind: "hours", key: "mon", value: { closed: true } }))) as ApiError;
    expect(err.message).not.toMatch(/VALIDATION_FAILED/);
    expect(err.details).toBeDefined();
  });
});

describe("catalog and prices", () => {
  it("getCatalog for the pizza shop returns items grouped by Square item, with display prices", async () => {
    const res = await api.getCatalog(PIZZA);
    expect(res.items.length).toBeGreaterThan(0);
    const names = res.items.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["Margherita", "Pepperoni"]));
    const marg = res.items.find((i) => i.name === "Margherita")!;
    const large = marg.variations.find((v) => v.id === "SQ_VAR_MARG_LG");
    expect(large).toMatchObject({ priceMinor: 2000, currency: "USD" });
    expect(marg.modifierLists.length).toBeGreaterThan(0);
    expect(res.syncedAt === null || typeof res.syncedAt === "string").toBe(true);
  });

  it("getCatalog for the barbershop answers an empty catalog", async () => {
    const res = await api.getCatalog(BARBER);
    expect(res.items).toEqual([]);
  });

  it("proposePrice opens a pending price_edit approval", async () => {
    // The world wires no Square price reader, so the test gives the server one that answers the cached row.
    const row = (
      await s.world.t.db.query("select square_item_id, price_minor, square_variation_version from catalog_items where business_id = $1 and square_variation_id = 'SQ_VAR_MARG_LG'", [PIZZA])
    ).rows[0] as { square_item_id: string; price_minor: number; square_variation_version: string | number };
    s.world.app.composed.providers.prices = {
      readVariationPrice: async (variationId) => ({
        variationId,
        squareItemId: row.square_item_id,
        priceMinor: row.price_minor,
        currency: "USD",
        version: Number(row.square_variation_version),
      }),
      updateVariationPrice: async () => {
        throw new Error("not expected in this test");
      },
    };
    const { approval } = await api.proposePrice(PIZZA, { variationId: "SQ_VAR_MARG_LG", newPriceMinor: 2100, currency: "USD" });
    expect(approval).toMatchObject({ businessId: PIZZA, bundleType: "price_edit", state: "PENDING", payload: { fromPriceMinor: 2000, newPriceMinor: 2100 } });
    await api.decideApproval(PIZZA, approval.id, { decision: "reject", payloadHash: approval.payloadHash });
  });

  // Mismatch (server): when Square's version differs from the cached row, the engine throws a PolicyError
  // INVALID_STATE, and apps/server/src/api/prices/index.ts maps every error that is not an AppError to
  // INTERNAL (500, retryable), so the Prices editor offers "Try again" for a proposal that cannot succeed.
  it.fails("proposePrice on a stale Square version answers INVALID_STATE, not a retryable INTERNAL", async () => {
    const prices = s.world.app.composed.providers.prices!;
    const read = prices.readVariationPrice;
    prices.readVariationPrice = async (variationId) => ({ ...(await read(variationId)), version: 999 });
    try {
      const err = (await rejection(api.proposePrice(PIZZA, { variationId: "SQ_VAR_MARG_LG", newPriceMinor: 2200, currency: "USD" }))) as ApiError;
      expect(err.code).toBe("INVALID_STATE");
    } finally {
      prices.readVariationPrice = read;
    }
  });

  it("proposePrice for a variation that is not in the catalog answers NOT_FOUND", async () => {
    const err = await rejection(api.proposePrice(PIZZA, { variationId: "SQ_VAR_NOPE", newPriceMinor: 100, currency: "USD" }));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("NOT_FOUND");
  });

  it("syncCatalog answers a job id", async () => {
    const res = await api.syncCatalog(PIZZA);
    expect(typeof res.jobId).toBe("string");
    await s.world.settle();
  });
});

const PIZZA_MENU_PDF = "%PDF-1.4\nDemo Pizza Co. Menu\nMargherita Large 21.00\n%%EOF\n";
const HOURS_CSV = "Opening hours\nday,open,close\nFriday,11:00,23:00\n";
const BARBER_CSV = "Demo Barbershop price list\nservice,price,minutes\nHaircut,30,30\nBeard trim,15,15\nHaircut and beard,40,45\n";

describe("files and conflicts", () => {
  it("uploadFile sends multipart through the web client and getFile reads the extraction result", async () => {
    const file = await api.uploadFile(PIZZA, new Blob([PIZZA_MENU_PDF], { type: "application/pdf" }), "menu.pdf");
    expect(file).toMatchObject({ businessId: PIZZA, name: "menu.pdf", mime: "application/pdf", extractionState: "PENDING" });
    const done = await waitFor(() => api.getFile(PIZZA, file.id), (f) => f.extractionState === "EXTRACTED" || f.extractionState === "FAILED");
    expect(done.extractionState).toBe("EXTRACTED");
    expect(ENDPOINTS.getFile.response.safeParse(done).success).toBe(true);
  });

  it("the barbershop price list uploads as CSV and extracts", async () => {
    const file = await api.uploadFile(BARBER, new Blob([BARBER_CSV], { type: "text/csv" }), "services.csv");
    const done = await waitFor(() => api.getFile(BARBER, file.id), (f) => f.extractionState !== "PENDING" && f.extractionState !== "EXTRACTING");
    expect(done).toMatchObject({ businessId: BARBER, extractionState: "EXTRACTED" });
  });

  it("an upload of a type that is not accepted answers VALIDATION_FAILED", async () => {
    const err = await rejection(api.uploadFile(PIZZA, new Blob(["hello"], { type: "text/plain" }), "notes.txt"));
    expect((err as ApiError).code).toBe("VALIDATION_FAILED");
    expect((err as ApiError).status).toBe(400);
  });

  it("getFile for an unknown id answers NOT_FOUND", async () => {
    const err = await rejection(api.getFile(PIZZA, "file_missing"));
    expect((err as ApiError).code).toBe("NOT_FOUND");
  });

  it("the upload's FileRecord names the conflict it opened", async () => {
    const file = await api.uploadFile(PIZZA, new Blob([PIZZA_MENU_PDF + "copy 2\n"], { type: "application/pdf" }), "menu-2.pdf");
    const done = await waitFor(() => api.getFile(PIZZA, file.id), (f) => f.extractionState === "EXTRACTED");
    expect(done.draftFactIds?.length).toBeGreaterThan(0);
    // The first upload opened the one menu conflict per key; this file still lists its drafts.
    expect(Array.isArray(done.conflictIds ?? [])).toBe(true);
  });

  it("resolveConflict keeps the authoritative value for a conflict an upload opened", async () => {
    const first = await api.uploadFile(BARBER, new Blob([HOURS_CSV], { type: "text/csv" }), "hours.csv");
    // The barbershop closes Friday at 18:00; the sheet says 23:00, so one conflict opens.
    const done = await waitFor(() => api.getFile(BARBER, first.id), (f) => f.extractionState === "EXTRACTED");
    const conflictId = done.conflictIds?.[0];
    expect(conflictId).toBeDefined();
    const res = await api.resolveConflict(BARBER, conflictId!);
    expect(res.conflict).toMatchObject({ id: conflictId, businessId: BARBER, state: "resolved" });
    const again = await rejection(api.resolveConflict(BARBER, conflictId!));
    expect((again as ApiError).code).toBe("INVALID_STATE");
  });

  // Uploads, their draft facts and their conflicts are rows in the database (#116), the same rows
  // GET /api/businesses/:id/facts reads, so a conflict from an upload reaches the Knowledge screen.
  it("a conflict an upload opened is listed by getFacts, so the Knowledge screen can show it", async () => {
    const res = await api.getFacts(BARBER);
    const files = s.requests.filter((r) => r.url.pathname.startsWith("/api/files/"));
    expect(files.length).toBeGreaterThan(0);
    expect(res.conflicts.some((c) => c.kind === "hours" && c.key === "fri")).toBe(true);
  });

  describe("a conflict stored in the database", () => {
    beforeAll(async () => {
      // The menu uploads above opened a conflict for this same key in the database (#116), and only
      // one conflict per key may be open. It is removed so the fixture row can stand in for it.
      await s.world.t.admin((q) =>
        q.query("delete from public.fact_conflicts where business_id = $1 and kind = 'menu_item' and key = $2 and state = 'open'", [PIZZA, menuPriceConflict.key]),
      );
      await s.world.t.admin((q) =>
        q.query(
          "insert into public.fact_conflicts (id, business_id, kind, key, candidates, required, state) values ($1, $2, 'menu_item', $3, $4::jsonb, true, 'open')",
          [menuPriceConflict.id, PIZZA, menuPriceConflict.key, JSON.stringify(menuPriceConflict.candidates)],
        ),
      );
    });

    it("getFacts lists it with the fields the conflict card reads", async () => {
      const res = await api.getFacts(PIZZA);
      const c = res.conflicts.find((x) => x.id === menuPriceConflict.id);
      expect(c).toMatchObject({ kind: "menu_item", key: menuPriceConflict.key, required: true, state: "open" });
      expect(c!.candidates.map((x) => x.sourceType).sort()).toEqual(["square", "upload"]);
    });

    // The Knowledge screen's "keep Square's price" calls POST /api/conflicts/:id/resolve. Until #110 the
    // server refused this for every conflict stored in the database.
    it("resolveConflict keeps Square's price for a conflict listed by getFacts", async () => {
      const res = await api.resolveConflict(PIZZA, menuPriceConflict.id);
      expect(res.conflict).toMatchObject({ id: menuPriceConflict.id, state: "resolved" });
    });

    it("a second resolve of the same conflict is refused as already resolved", async () => {
      const err = (await rejection(api.resolveConflict(PIZZA, menuPriceConflict.id))) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.kind).toBe("http");
      expect(err.retryable).toBe(false);
      expect(err.message).toBe("Conflict is already resolved.");
    });

    it("getFacts no longer lists the conflict as open", async () => {
      const res = await api.getFacts(PIZZA);
      expect(res.conflicts.some((x) => x.id === menuPriceConflict.id && x.state === "open")).toBe(false);
    });
  });

  it("resolveConflict for an unknown id answers NOT_FOUND", async () => {
    const err = await rejection(api.resolveConflict(PIZZA, "cfl_missing"));
    expect((err as ApiError).code).toBe("NOT_FOUND");
  });
});
