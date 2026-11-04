import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../../app/db.server", () => ({default: {}}));
vi.mock("../../app/services/merchant-knowledge/merchant-knowledge-entitlement.server", () => ({loadCurrentMerchantKnowledgeEntitlement: async () => ({kind: "entitled", configuration: {}})}));
import { reorderMerchantKnowledgeSources } from "../../app/services/merchant-knowledge/merchant-knowledge.server";
let rows: Array<{id: string; position: number}>;
beforeEach(() => { rows = [{id: "a", position: 0}, {id: "b", position: 1}]; });
function fixture() {
 const tx = {$queryRaw: vi.fn().mockResolvedValue([{id: "shop"}]), $executeRaw: vi.fn(async (...args: unknown[]) => {void args; return rows.length;}),
   merchantKnowledgeSource: {findMany: vi.fn(async () => rows)}};
 return {tx, database: {$transaction: async (callback: (value: unknown) => Promise<unknown>) => callback(tx)} as never};
}
it.each([false, true])("dense unchanged/empty order has zero writes, empty=%s", async empty => {
 if (empty) rows = []; const f = fixture();
 await expect(reorderMerchantKnowledgeSources({shopId: "shop", sourceIds: rows.map(r => r.id), database: f.database})).resolves.toEqual({ok: true});
 expect(f.tx.$executeRaw).not.toHaveBeenCalled();
});
it("changed order uses two statements with one bound array and safe disjoint offset", async () => {
 const f = fixture(); await reorderMerchantKnowledgeSources({shopId: "shop", sourceIds: ["b", "a"], database: f.database});
 expect(f.tx.$executeRaw).toHaveBeenCalledTimes(2);
 const [first, last] = f.tx.$executeRaw.mock.calls.map(call => call[0] as unknown as {sql: string; values: unknown[]});
 expect(first.values).toContain(2); expect(first.sql).not.toContain("updatedAt");
 expect(last.sql).toContain("WITH ORDINALITY"); expect(last.values).toContainEqual(["b", "a"]);
});
it.each([-1, 2147483647])("invalid persisted position %s fails before writes", async position => {
 rows[0].position = position; const f = fixture();
 await expect(reorderMerchantKnowledgeSources({shopId: "shop", sourceIds: ["b", "a"], database: f.database})).rejects.toMatchObject({code: "CONFLICT", cause: expect.any(Error)});
 expect(f.tx.$executeRaw).not.toHaveBeenCalled();
});
it("exact-set mismatch and affected-count mismatch fail without silent success", async () => {
 const f = fixture(); await expect(reorderMerchantKnowledgeSources({shopId: "shop", sourceIds: ["other"], database: f.database})).rejects.toMatchObject({code: "CONFLICT"});
 f.tx.$executeRaw.mockResolvedValueOnce(0);
 await expect(reorderMerchantKnowledgeSources({shopId: "shop", sourceIds: ["b", "a"], database: f.database})).rejects.toMatchObject({code: "CONFLICT"});
 expect(f.tx.$executeRaw).toHaveBeenCalledOnce();
});
