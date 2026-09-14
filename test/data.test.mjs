import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { cases } = JSON.parse(await readFile(new URL("../public/data/cases.json", import.meta.url), "utf8"));
const LAYERS = new Set(["assets", "offices", "entities", "brand", "other"]);

test("hay cuatro empresas con nueve agentes cada una", () => {
  assert.equal(cases.length, 4);
  for (const data of cases) {
    assert.equal(data.agents.length, 9, data.name);
    for (const agent of data.agents) {
      assert.ok(agent.log.length > 0, `${data.name} · ${agent.task} sin registro`);
      assert.ok(agent.tokens > 0 && agent.requests > 0, `${data.name} · ${agent.task} sin métricas`);
    }
  }
});

test("cada localización tiene capa válida, coordenadas y aparece una sola vez en el flujo", () => {
  for (const data of cases) {
    const revealed = data.agents.flatMap((agent) => agent.reveals);
    assert.equal(new Set(revealed).size, revealed.length, `${data.name}: localizaciones repetidas`);
    assert.deepEqual(new Set(revealed), new Set(data.locations.map((loc) => loc.id)), `${data.name}: reveals incompletos`);
    for (const loc of data.locations) {
      assert.ok(LAYERS.has(loc.layer), `${loc.id}: capa ${loc.layer}`);
      assert.ok(Number.isFinite(loc.lat) && Math.abs(loc.lat) <= 90, `${loc.id}: latitud`);
      assert.ok(Number.isFinite(loc.lon) && Math.abs(loc.lon) <= 180, `${loc.id}: longitud`);
      if (loc.sourceUrl) assert.match(loc.sourceUrl, /^https?:\/\//, `${loc.id}: fuente`);
    }
  }
});

test("los totales cuadran con el detalle", () => {
  for (const data of cases) {
    const t = data.totals;
    assert.equal(t.locations, data.locations.length);
    assert.equal(t.withCoordinates, data.locations.filter((l) => Number.isFinite(l.lat)).length);
    assert.equal(Object.values(t.layers).reduce((a, b) => a + b, 0), t.locations);
    const tokens = data.agents.reduce((acc, a) => acc + a.tokens, 0);
    assert.equal(tokens, t.tokens, `${data.name}: tokens por agente frente al total`);
  }
});
