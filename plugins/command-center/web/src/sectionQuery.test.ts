import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionHash, workflowListHash } from "./sectionQuery.ts";

test("los filtros conservan el proyecto, la pestaña y los parámetros de otras vistas", () => {
  const hash = collectionHash("#project/m:p?tab=sections&other=keep", "sectionSearch", "API y web");
  const params = new URLSearchParams(hash.split("?")[1]);
  assert.equal(hash.split("?")[0], "#project/m:p");
  assert.equal(params.get("tab"), "sections");
  assert.equal(params.get("other"), "keep");
  assert.equal(params.get("sectionSearch"), "API y web");
  assert.equal(new URLSearchParams(collectionHash(hash, "sectionSearch", "").split("?")[1]).has("sectionSearch"), false);
});

test("entrar y volver de una ejecución conserva filtros sin copiar el identificador de ejecución", () => {
  const run = workflowListHash("#work/flows?run=r", "#work/flows?flowQuery=API&flowLibraryPage=2");
  const back = workflowListHash("#work/flows", run);
  const params = new URLSearchParams(back.split("?")[1]);
  assert.equal(params.get("flowQuery"), "API");
  assert.equal(params.get("flowLibraryPage"), "2");
  assert.equal(params.has("run"), false);
});
