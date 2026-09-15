import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (path) => JSON.parse(await readFile(new URL(`../public/data/${path}`, import.meta.url), "utf8"));
const { cases: index } = await read("index.json");
const details = await Promise.all(index.map((item) => read(`cases/${item.slug}.json`)));
const LAYERS = new Set(["assets", "offices", "entities", "brand", "linked", "charging", "other"]);

test("el índice y el detalle de cada empresa coinciden", () => {
  assert.equal(index.length, 7);
  for (const [i, item] of index.entries()) {
    const data = details[i];
    assert.equal(data.slug, item.slug);
    assert.deepEqual(data.totals, item.totals, item.name);
    assert.equal(data.agents.length, item.totals.steps, item.name);
  }
});

test("cada paso tiene registro y las métricas solo aparecen si hay resumen de costes", () => {
  for (const data of details) {
    for (const agent of data.agents) {
      assert.ok(agent.log.length > 0, `${data.name} · ${agent.task} sin registro`);
      if (data.hasCost && agent.kind === "agent") assert.ok(agent.tokens > 0 && agent.requests > 0, `${data.name} · ${agent.task}`);
      if (!data.hasCost) assert.equal(agent.tokens, 0, `${data.name} · ${agent.task} con tokens inventados`);
    }
  }
});

test("cada localización tiene capa, paso que la revela y coordenadas válidas si las tiene", () => {
  for (const data of details) {
    const steps = new Set(data.agents.map((agent) => agent.task));
    const ids = new Set();
    for (const loc of data.locations) {
      assert.ok(!ids.has(loc.id), `${loc.id} repetida`);
      ids.add(loc.id);
      assert.ok(LAYERS.has(loc.layer), `${loc.id}: capa ${loc.layer}`);
      assert.ok(steps.has(loc.step), `${loc.id}: paso ${loc.step} inexistente`);
      if (loc.lat !== null) {
        assert.ok(Math.abs(loc.lat) <= 90 && Math.abs(loc.lon) <= 180, `${loc.id}: coordenadas`);
      }
      if (loc.sourceUrl) assert.match(loc.sourceUrl, /^https?:\/\//, `${loc.id}: fuente`);
    }
  }
});

test("los totales cuadran con el detalle", () => {
  for (const data of details) {
    const t = data.totals;
    assert.equal(t.locations, data.locations.length);
    assert.equal(t.withCoordinates, data.locations.filter((l) => l.lat !== null).length);
    assert.equal(Object.values(t.layers).reduce((a, b) => a + b, 0), t.locations);
    if (data.hasCost) assert.equal(data.agents.reduce((acc, a) => acc + a.tokens, 0), t.tokens, data.name);
  }
});

test("en Iberdrola, los activos con otro titular no se atribuyen al grupo", () => {
  const iberdrola = details.find((d) => d.slug === "iberdrola");
  const foreign = iberdrola.locations.filter((l) => l.step === "connector_gem" && l.owner && !/iberdrola|avangrid|neoenergia|scottish|elektro|coelba|celpe|cosern/i.test(l.owner));
  assert.ok(foreign.length > 0);
  assert.ok(foreign.every((l) => l.layer === "linked"));
});

test("las fuentes de cada paso son URLs reales citadas por sus registros y cuadran con el resumen", () => {
  const KINDS = new Set(["Web oficial", "Google Places", "GEM Wiki", "Open Supply Hub", "Wikipedia", "Registro público", "Web de terceros", "Dataset del grupo"]);
  for (const data of details) {
    const planner = data.agents.find((agent) => agent.task === "plan_source_strategy");
    assert.ok(planner.strategy.length > 0, `${data.name}: el planificador no enseña su estrategia`);
    const cited = new Map();
    for (const agent of data.agents) {
      for (const item of agent.sources || []) {
        assert.ok(KINDS.has(item.kind), `${data.name} · ${agent.task}: tipo ${item.kind}`);
        assert.ok(item.records > 0, `${data.name} · ${agent.task}: fuente sin registros`);
        if (item.url) assert.match(item.url, /^https?:\/\//, `${data.name} · ${agent.task}: ${item.url}`);
        else assert.equal(item.kind, "Dataset del grupo");
        cited.set(item.kind, (cited.get(item.kind) || 0) + item.records);
      }
    }
    const summary = data.sourceSummary;
    for (const { kind, cited: count } of summary.kinds) assert.equal(count, cited.get(kind), `${data.name}: citas de ${kind}`);
    for (const planned of summary.planned) {
      if (planned.status === "used") assert.ok(planned.cited > 0, `${data.name}: ${planned.name} usada sin citas`);
      if (planned.status === "empty") assert.ok(!cited.get(planned.name), `${data.name}: ${planned.name} sin resultados pero citada`);
    }
    // Todo dominio que respalda una localización del dataset figura en la tabla de dominios.
    const hosts = new Set(summary.domains.map((d) => d.host));
    for (const loc of data.locations) {
      if (loc.sourceUrl) assert.ok(hosts.has(new URL(loc.sourceUrl).hostname.replace(/^www\./, "")), `${data.name}: ${loc.sourceUrl}`);
    }
    assert.equal(summary.withoutSource, data.locations.filter((l) => !l.sourceUrl && !l.source).length, data.name);
  }
});
