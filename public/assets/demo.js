import { FootprintMap, LAYERS, escapeHtml } from "/assets/map.js";

const $ = (selector) => document.querySelector(selector);
const els = {
  queueCount: $("#queueCount"), queueSearch: $("#queueSearch"), queueList: $("#queueList"), legendList: $("#legendList"),
  sectorChip: $("#sectorChip"), stateChip: $("#stateChip"), companyName: $("#companyName"), companyMeta: $("#companyMeta"),
  runStep: $("#runStep"), runClock: $("#runClock"), runBar: $("#runBar"), runButton: $("#runButton"),
  runButtonText: $("#runButtonText"), flowList: $("#flowList"), flowNote: $("#flowNote"), layerToggles: $("#layerToggles"),
  mapEmpty: $("#mapEmpty"), resultsLocked: $("#resultsLocked"), inventorySearch: $("#inventorySearch"),
  inventoryLayer: $("#inventoryLayer"), inventoryCount: $("#inventoryCount"), inventoryBody: $("#inventoryBody"),
  tabProfile: $("#tabProfile"), tabStrategy: $("#tabStrategy"), tabExport: $("#tabExport"), toastRegion: $("#toastRegion"),
  kpi: {
    locations: $("#kpiLocations"), countries: $("#kpiCountries"), geo: $("#kpiGeo"), source: $("#kpiSource"),
    requests: $("#kpiRequests"), tokens: $("#kpiTokens"), cost: $("#kpiCost"),
  },
  kpiLabel: { requests: $("#kpiRequestsLabel"), tokens: $("#kpiTokensLabel"), cost: $("#kpiCostLabel") },
};

const STAGES = { plan: "Planificación", extract: "Extracción", consolidate: "Consolidación", connectors: "Conectores sectoriales" };
const STATE_LABEL = { idle: "Pendiente", running: "Analizando", done: "Completado" };
const INVENTORY_LIMIT = 300;
const number = new Intl.NumberFormat("es-ES");
const compact = new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 1 });
const usd = (value, digits = 3) => `$${value.toFixed(digits).replace(".", ",")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  index: [],
  details: new Map(),
  loading: new Map(),
  current: null,
  speed: 1,
  runs: new Map(),
  openAgent: null,
  selectedId: null,
  tab: "inventory",
};

let footprint;

// --------------------------------------------------------------------------- datos

const summaryOf = (slug) => state.index.find((c) => c.slug === slug);
const detailOf = (slug) => state.details.get(slug);

function loadDetail(slug) {
  if (state.details.has(slug)) return Promise.resolve(state.details.get(slug));
  if (!state.loading.has(slug)) {
    state.loading.set(slug, fetch(`/data/cases/${slug}.json`).then((r) => r.json()).then((data) => {
      data.byStep = new Map();
      for (const loc of data.locations) {
        if (!data.byStep.has(loc.step)) data.byStep.set(loc.step, []);
        data.byStep.get(loc.step).push(loc);
      }
      state.details.set(slug, data);
      return data;
    }));
  }
  return state.loading.get(slug);
}

function freshRun(data, status = "idle") {
  return {
    status, elapsed: 0, revealed: [], revealedIds: new Set(), countries: new Set(), layerCounts: {},
    agents: data ? data.agents.map(() => ({ status: "pending", lines: 0, tokens: 0, requests: 0, cost: 0, records: 0, progress: 0 })) : [],
  };
}

function runState(slug) {
  if (!state.runs.has(slug)) state.runs.set(slug, freshRun(detailOf(slug)));
  const run = state.runs.get(slug);
  if (!run.agents.length && detailOf(slug)) run.agents = freshRun(detailOf(slug)).agents;
  return run;
}

function reveal(run, locations) {
  for (const loc of locations) {
    if (run.revealedIds.has(loc.id)) continue;
    run.revealedIds.add(loc.id);
    run.revealed.push(loc);
    if (loc.country) run.countries.add(loc.country);
    run.layerCounts[loc.layer] = (run.layerCounts[loc.layer] || 0) + 1;
  }
}

function placeOf(headquarters) {
  const parts = String(headquarters || "").split(",").map((p) => p.replace(/\b\d{3,}\b/g, "").trim()).filter(Boolean);
  return parts.slice(-2).join(", ");
}

function hostOf(url) {
  try { return url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { return ""; }
}

// --------------------------------------------------------------------------- bandeja

function renderQueue() {
  const term = els.queueSearch.value.trim().toLowerCase();
  els.queueList.replaceChildren();
  for (const item of state.index) {
    if (term && !`${item.name} ${item.sector} ${item.headquarters}`.toLowerCase().includes(term)) continue;
    const run = runState(item.slug);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "queue-item" + (item.slug === state.current ? " is-selected" : "");
    button.setAttribute("role", "listitem");
    const t = item.totals;
    const detail = run.status === "done"
      ? `${number.format(t.locations)} localizaciones · ${t.countries} ${t.countries === 1 ? "país" : "países"}`
      : placeOf(item.headquarters);
    button.innerHTML = `
      <span class="queue-item-top"><span class="queue-sector">${escapeHtml(item.sector)}</span>
      <span class="state-pill" data-state="${run.status}">${STATE_LABEL[run.status]}</span></span>
      <span class="queue-name">${escapeHtml(item.name)}</span>
      <span class="queue-meta">${escapeHtml(detail)}</span>
      ${item.hasConnectors ? '<span class="queue-tag">Flujo + conectores sectoriales</span>' : ""}`;
    button.addEventListener("click", () => selectCase(item.slug));
    els.queueList.append(button);
  }
  els.queueCount.textContent = state.index.filter((c) => runState(c.slug).status !== "done").length;
}

function renderLegend() {
  els.legendList.innerHTML = Object.entries(LAYERS)
    .map(([key, layer]) => `<li><span class="layer-dot" data-layer="${key}"></span>${escapeHtml(layer.label)}</li>`).join("");
}

// --------------------------------------------------------------------------- cabecera e indicadores

function renderHero() {
  const item = summaryOf(state.current);
  const run = runState(item.slug);
  els.sectorChip.textContent = item.sector;
  els.companyName.textContent = item.name;
  els.companyMeta.innerHTML = `Sede <b>${escapeHtml(placeOf(item.headquarters) || "—")}</b>` +
    (item.parent ? ` · Matriz <b>${escapeHtml(item.parent)}</b>` : "") +
    (item.brands ? ` · ${item.brands} ${item.brands === 1 ? "marca" : "marcas"}` : "");
  els.stateChip.textContent = STATE_LABEL[run.status];
  els.stateChip.dataset.state = run.status;
  els.flowNote.textContent = item.hasConnectors ? "Agentes + conectores sectoriales" : "Proceso secuencial · gpt-4o-mini";
  renderProgress();
}

function renderProgress() {
  const item = summaryOf(state.current);
  const data = detailOf(item.slug);
  const run = runState(item.slug);
  const total = item.totals.steps;
  const noun = item.hasConnectors ? "pasos" : "agentes";
  const done = run.agents.filter((a) => a.status === "done").length;
  const running = run.agents.findIndex((a) => a.status === "running");
  if (!data) els.runStep.textContent = "Preparando el flujo…";
  else if (run.status === "idle") els.runStep.textContent = `${total} ${noun} listos`;
  else if (run.status === "done") els.runStep.textContent = `Análisis completado · ${total}/${total}`;
  else {
    const active = running >= 0 ? running : Math.min(done, total - 1);
    els.runStep.textContent = `${data.agents[active].label} · ${active + 1}/${total}`;
  }
  const partial = running >= 0 ? run.agents[running].progress || 0 : 0;
  els.runBar.style.width = `${total ? ((done + partial) / total) * 100 : 0}%`;
  const seconds = Math.floor(run.elapsed / 1000);
  els.runClock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  els.runButton.disabled = run.status === "running" || !data;
  els.runButton.classList.toggle("is-running", run.status === "running");
  els.runButtonText.textContent = run.status === "running" ? "Analizando…" : run.status === "done" ? "Volver a ejecutar" : "Ejecutar análisis";
}

function setKpi(key, text) {
  const el = els.kpi[key];
  if (el.textContent === text) return;
  el.textContent = text;
  const tile = el.closest(".kpi");
  tile.classList.remove("is-bumped");
  void tile.offsetWidth;
  tile.classList.add("is-bumped");
}

function renderKpis() {
  const item = summaryOf(state.current);
  const data = detailOf(item.slug);
  const run = runState(item.slug);
  const shown = run.revealed;
  setKpi("locations", number.format(shown.length));
  setKpi("countries", number.format(run.countries.size));
  const stepDone = (task) => data && run.agents[data.agents.findIndex((a) => a.task === task)]?.status === "done";
  const geocoded = stepDone("geocode_all_locations");
  const exported = stepDone("export_consolidated_data");
  const withCoords = shown.reduce((acc, l) => acc + (Number.isFinite(l.lat) ? 1 : 0), 0);
  setKpi("geo", (geocoded || exported) && shown.length ? `${Math.round((withCoords / shown.length) * 100)} %` : "—");
  setKpi("source", exported ? `${Math.round((item.totals.withSource / item.totals.locations) * 100)} %` : "—");

  if (item.hasCost) {
    els.kpiLabel.requests.textContent = "Llamadas al modelo";
    els.kpiLabel.tokens.textContent = "Tokens";
    els.kpiLabel.cost.textContent = "Coste estimado";
    const sum = (field) => run.agents.reduce((acc, a) => acc + a[field], 0);
    setKpi("requests", number.format(Math.round(sum("requests"))));
    setKpi("tokens", compact.format(Math.round(sum("tokens"))));
    setKpi("cost", usd(sum("cost")));
  } else {
    els.kpiLabel.requests.textContent = "Pasos completados";
    els.kpiLabel.tokens.textContent = "Registros de conectores";
    els.kpiLabel.cost.textContent = "Dominios de fuente";
    const done = run.agents.filter((a) => a.status === "done").length;
    const connectorRecords = data ? data.agents.reduce((acc, agent, i) => acc + (agent.kind === "connector" ? run.agents[i].records : 0), 0) : 0;
    setKpi("requests", `${done}/${item.totals.steps}`);
    setKpi("tokens", number.format(Math.round(connectorRecords)));
    setKpi("cost", exported ? number.format(item.totals.sources) : "—");
  }
}

// --------------------------------------------------------------------------- flujo

function renderFlow() {
  const data = detailOf(state.current);
  els.flowList.replaceChildren();
  if (!data) {
    els.flowList.innerHTML = '<p class="flow-loading">Cargando el flujo…</p>';
    return;
  }
  let lastStage = null;
  data.agents.forEach((agent, index) => {
    if (agent.stage !== lastStage) {
      const stage = document.createElement("p");
      stage.className = "flow-stage";
      stage.textContent = STAGES[agent.stage] || agent.stage;
      els.flowList.append(stage);
      lastStage = agent.stage;
    }
    const node = document.createElement("div");
    node.className = "agent" + (agent.kind === "connector" ? " agent-connector" : "");
    node.dataset.index = index;
    node.innerHTML = `
      <button class="agent-row" type="button">
        <span class="agent-icon"><span>${index + 1}</span></span>
        <span><span class="agent-name">${escapeHtml(agent.label)}</span><span class="agent-role">${escapeHtml(agent.agent)}</span></span>
        <span class="agent-metric"></span>
      </button>
      <div class="agent-body">
        <div class="agent-tools">${agent.tools.length ? agent.tools.map((t) => `<span>${escapeHtml(t)}</span>`).join("") : '<span class="no-tools">Razonamiento sin herramientas</span>'}</div>
        <ul class="agent-log"></ul>
        <div class="agent-stats"></div>
      </div>`;
    node.querySelector(".agent-row").addEventListener("click", () => {
      if (runState(data.slug).agents[index].status !== "done") return;
      state.openAgent = state.openAgent === index ? null : index;
      for (const other of els.flowList.querySelectorAll(".agent")) other.classList.toggle("is-open", Number(other.dataset.index) === state.openAgent);
    });
    els.flowList.append(node);
    updateAgent(index);
  });
}

function updateAgent(index) {
  const data = detailOf(state.current);
  if (!data) return;
  const run = runState(data.slug);
  const agent = data.agents[index];
  const s = run.agents[index];
  const node = els.flowList.querySelector(`.agent[data-index="${index}"]`);
  if (!node) return;
  node.dataset.state = s.status;
  node.classList.toggle("is-open", state.openAgent === index && s.status === "done");
  node.querySelector(".agent-row").disabled = s.status !== "done";
  const metric = node.querySelector(".agent-metric");
  if (s.status === "pending") metric.textContent = "—";
  else if (data.hasCost) metric.textContent = `${compact.format(Math.round(s.tokens))} tok`;
  else metric.textContent = `${compact.format(Math.round(s.records))} reg.`;

  const log = node.querySelector(".agent-log");
  const lines = agent.log.slice(0, s.lines);
  if (log.children.length !== lines.length) {
    log.replaceChildren(...lines.map((line, i) => {
      const li = document.createElement("li");
      li.textContent = line;
      if (s.status === "running" && i === lines.length - 1) li.classList.add("is-typing");
      return li;
    }));
    log.scrollTop = log.scrollHeight;
  }
  if (s.status === "done") log.querySelector(".is-typing")?.classList.remove("is-typing");

  const stats = node.querySelector(".agent-stats");
  if (s.status === "pending") stats.innerHTML = "";
  else if (data.hasCost) {
    stats.innerHTML = `<span>Modelo <b>${escapeHtml(agent.model)}</b></span><span>Llamadas <b>${number.format(Math.round(s.requests))}</b></span>` +
      `<span>Tokens <b>${number.format(Math.round(s.tokens))}</b></span><span>Coste <b>${usd(s.cost, 4)}</b></span>`;
  } else {
    stats.innerHTML = `<span>${agent.kind === "connector" ? "Conector" : "Agente"}</span>` +
      `<span>Registros <b>${number.format(Math.round(s.records))}</b></span>` +
      (agent.mapped ? `<span>En el mapa <b>${number.format(s.status === "done" ? agent.mapped : 0)}</b></span>` : "");
  }
}

// --------------------------------------------------------------------------- mapa

function renderLayerToggles() {
  const item = summaryOf(state.current);
  const run = runState(item.slug);
  const layers = Object.keys(LAYERS).filter((key) => item.totals.layers[key]);
  els.layerToggles.replaceChildren(...layers.map((key) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "layer-toggle";
    button.setAttribute("aria-pressed", String(footprint?.visibleLayers.has(key) ?? true));
    button.innerHTML = `<span class="layer-dot" data-layer="${key}"></span>${escapeHtml(LAYERS[key].short)} <b>${number.format(run.layerCounts[key] || 0)}</b>`;
    button.addEventListener("click", () => {
      const visible = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(visible));
      footprint?.setLayerVisible(key, visible);
    });
    return button;
  }));
}

function syncMap({ fit = true } = {}) {
  const run = runState(state.current);
  footprint.setLocations(run.revealed);
  els.mapEmpty.hidden = run.revealed.length > 0 || run.status === "done";
  if (run.revealed.length && fit) {
    footprint.stopSpin();
    footprint.fit(run.revealed, { duration: 1200 });
  } else if (!run.revealed.length) {
    footprint.flyToPoint(8, 30, 1.3, 1200);
    footprint.spin();
  }
}

// --------------------------------------------------------------------------- resultados

function renderResults() {
  const run = runState(state.current);
  const unlocked = run.status === "done" && detailOf(state.current);
  els.resultsLocked.hidden = Boolean(unlocked);
  els.resultsLocked.querySelector("p").innerHTML = run.status === "running"
    ? "<strong>Construyendo el dataset.</strong> El inventario, el perfil y la estrategia estarán disponibles al terminar la consolidación."
    : "<strong>Sin resultados todavía.</strong> Ejecuta el análisis para construir el inventario, el perfil y la estrategia de fuentes de la empresa.";
  for (const button of document.querySelectorAll(".tabs button")) button.disabled = !unlocked;
  for (const panel of document.querySelectorAll(".tab-body")) panel.hidden = !unlocked || panel.dataset.panel !== state.tab;
  if (!unlocked) return;
  renderInventory();
  renderProfile();
  renderStrategy();
  renderExport();
}

function renderInventory() {
  const data = detailOf(state.current);
  if (!data) return;
  const term = els.inventorySearch.value.trim().toLowerCase();
  const layer = els.inventoryLayer.value;
  const layers = Object.keys(LAYERS).filter((key) => data.totals.layers[key]);
  if (els.inventoryLayer.dataset.slug !== data.slug) {
    els.inventoryLayer.innerHTML = '<option value="">Todas las capas</option>' +
      layers.map((key) => `<option value="${key}">${escapeHtml(LAYERS[key].label)} (${number.format(data.totals.layers[key])})</option>`).join("");
    els.inventoryLayer.dataset.slug = data.slug;
  }
  const rows = [];
  let matches = 0;
  for (const loc of data.locations) {
    if (layer && loc.layer !== layer) continue;
    if (term && !`${loc.name} ${loc.type || ""} ${loc.city || ""} ${loc.region || ""} ${loc.country || ""}`.toLowerCase().includes(term)) continue;
    matches += 1;
    if (rows.length < INVENTORY_LIMIT) rows.push(loc);
  }
  els.inventoryCount.textContent = matches > rows.length
    ? `Mostrando ${number.format(rows.length)} de ${number.format(matches)} · filtra para acotar`
    : `${number.format(matches)} de ${number.format(data.locations.length)} registros`;
  els.inventoryBody.replaceChildren(...rows.map((loc) => {
    const tr = document.createElement("tr");
    tr.dataset.id = loc.id;
    tr.classList.toggle("is-selected", loc.id === state.selectedId);
    const host = hostOf(loc.sourceUrl);
    const where = [loc.city || loc.region, loc.country].filter(Boolean).join(", ");
    tr.innerHTML = `
      <td><span class="layer-chip"><span class="layer-dot" data-layer="${loc.layer}"></span>${escapeHtml(LAYERS[loc.layer].short)}</span></td>
      <td><strong>${escapeHtml(loc.name)}</strong>${loc.relationship || loc.owner ? `<small>${escapeHtml(loc.relationship || `Titular: ${loc.owner}`)}</small>` : ""}</td>
      <td>${escapeHtml(loc.type || "—")}${loc.capacity ? `<small>${escapeHtml(loc.capacity)}</small>` : loc.subtype && loc.subtype !== loc.type ? `<small>${escapeHtml(loc.subtype)}</small>` : ""}</td>
      <td>${escapeHtml(where || "—")}<small>${Number.isFinite(loc.lat) ? `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}` : "Sin coordenadas"}</small></td>
      <td>${escapeHtml(loc.status || "—")}</td>
      <td>${loc.sourceUrl ? `<a href="${escapeHtml(loc.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host)} ↗</a>` : escapeHtml(loc.source || "—")}</td>`;
    tr.addEventListener("click", (event) => {
      if (event.target.closest("a") || !Number.isFinite(loc.lat)) return;
      document.querySelector(".map-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
      footprint.select(loc.id);
    });
    return tr;
  }));
}

function chips(items, empty = "—") {
  return items?.length ? `<div class="chips">${items.map((i) => `<span>${escapeHtml(i)}</span>`).join("")}</div>` : `<p>${empty}</p>`;
}

function kv(object) {
  const entries = Object.entries(object || {});
  return entries.length ? `<dl class="kv">${entries.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>` : "<p>—</p>";
}

function links(urls) {
  return urls?.length ? `<ul class="link-list">${urls.map((u) => `<li><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a></li>`).join("")}</ul>` : "<p>—</p>";
}

function renderProfile() {
  const p = detailOf(state.current).profile;
  els.tabProfile.innerHTML = `
    <div class="profile-grid">
      <article class="info-card"><h3>Razón social</h3><p class="info-big">${escapeHtml(p.canonicalName)}</p>${p.parent ? `<p>Matriz: ${escapeHtml(p.parent)}</p>` : ""}</article>
      <article class="info-card"><h3>Sede</h3><p class="info-big">${escapeHtml(placeOf(p.headquarters) || "—")}</p><p>${escapeHtml(p.headquarters)}</p></article>
      <article class="info-card"><h3>Identificadores públicos</h3>${kv(p.identifiers)}</article>
      <article class="info-card"><h3>Códigos de actividad</h3>${kv(p.activityCodes)}</article>
      <article class="info-card"><h3>Marcas</h3>${chips(p.brands)}</article>
      <article class="info-card"><h3>Filiales principales</h3>${chips(p.subsidiaries)}</article>
      <article class="info-card"><h3>Países de operación</h3>${chips(p.countries)}</article>
      <article class="info-card"><h3>Webs oficiales</h3>${links(p.websites)}</article>
      ${p.summary ? `<article class="info-card info-card-wide"><h3>Resumen sectorial</h3><p>${escapeHtml(p.summary)}</p></article>` : ""}
      <article class="info-card info-card-wide"><h3>Fuentes del perfil</h3>${links(p.sources)}</article>
    </div>`;
}

function renderStrategy() {
  const data = detailOf(state.current);
  const plan = data.plan;
  const connectors = data.agents.filter((a) => a.kind === "connector");
  els.tabStrategy.innerHTML = `
    <div class="profile-grid">
      <article class="info-card"><h3>Sector operativo</h3><p class="info-big">${escapeHtml(plan.sector || "—")}</p>${plan.confidence ? `<p>Confianza ${escapeHtml(plan.confidence)}</p>` : ""}</article>
      <article class="info-card info-card-wide"><h3>Orden de conectores</h3>
        ${plan.connectors.length ? `<div class="chain">${plan.connectors.map((c, i) => `${i ? "<i>→</i>" : ""}<span><em>${i + 1}</em>${escapeHtml(c)}</span>`).join("")}</div>` : "<p>—</p>"}</article>
      ${connectors.length ? `<article class="info-card info-card-wide"><h3>Conectores sectoriales ejecutados</h3>
        <ul class="dataset-list">${connectors.map((c) => `<li><span>${escapeHtml(c.label)}</span><b>${number.format(c.records)} registros</b></li>`).join("")}</ul></article>` : ""}
      ${plan.notes ? `<article class="info-card info-card-wide"><h3>Criterio del planificador</h3><p class="quote">${escapeHtml(plan.notes)}</p></article>` : ""}
      <article class="info-card"><h3>Consultas de marca</h3>${chips(plan.brandQueries)}</article>
      <article class="info-card"><h3>Consultas de filiales</h3>${chips(plan.subsidiaryQueries)}</article>
    </div>`;
}

function renderExport() {
  const data = detailOf(state.current);
  const names = { assets: "physical_assets", offices: "global_offices", entities: "operational_entities",
    brand: "brand_locations_discovered", linked: "linked_assets", charging: "charging_points", other: "geocoded_locations" };
  els.tabExport.innerHTML = `
    <div class="export-grid">
      <article class="export-card"><h3>Vista maestra (CSV)</h3>
        <p>Todas las localizaciones deduplicadas, con capa, dirección, coordenadas y fuente de cada registro.</p>
        <code>all_locations_master.csv · ${number.format(data.locations.length)} filas</code>
        <button class="btn btn-light btn-sm" type="button" data-export="csv">Descargar CSV</button></article>
      <article class="export-card"><h3>Dataset completo (JSON)</h3>
        <p>Perfil corporativo, estrategia de fuentes y las capas de localizaciones en un único documento.</p>
        <code>${escapeHtml(data.slug)}_footprint.json</code>
        <button class="btn btn-light btn-sm" type="button" data-export="json">Descargar JSON</button></article>
      <article class="export-card"><h3>Capas generadas</h3>
        <ul class="dataset-list"><li><code>company_profile</code><b>1</b></li>
        ${Object.entries(data.totals.layers).map(([k, v]) => `<li><code>${names[k] || k}</code><b>${number.format(v)}</b></li>`).join("")}</ul></article>
    </div>`;
  els.tabExport.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => download(button.dataset.export)));
}

function download(kind) {
  const data = detailOf(state.current);
  let blob;
  let name;
  if (kind === "csv") {
    const header = ["layer", "name", "type", "address", "city", "region", "country", "postal_code", "latitude", "longitude", "status", "owner", "capacity", "source"];
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = data.locations.map((l) => [LAYERS[l.layer].label, l.name, l.type, l.address, l.city, l.region, l.country, l.postalCode,
      l.lat, l.lon, l.status, l.owner, l.capacity, l.sourceUrl || l.source].map(cell).join(","));
    blob = new Blob(["﻿" + [header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    name = `${data.slug}_all_locations_master.csv`;
  } else {
    const { agents, byStep, ...rest } = data;
    blob = new Blob([JSON.stringify(rest, null, 2)], { type: "application/json" });
    name = `${data.slug}_footprint.json`;
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toast(title, detail) {
  const node = document.createElement("div");
  node.className = "toast";
  node.innerHTML = `<span class="toast-icon">✓</span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
  els.toastRegion.append(node);
  setTimeout(() => node.remove(), 5200);
}

// --------------------------------------------------------------------------- ejecución

function stepDuration(agent) {
  if (agent.kind === "connector") return 5200;
  if (agent.requests) return Math.min(7600, Math.max(2300, 1500 + agent.requests * 200));
  return Math.min(6000, Math.max(2600, 2200 + agent.records * 140));
}

async function revealStep(slug, run, locations, isCurrent) {
  if (!locations?.length) return;
  if (locations.length <= 40) {
    for (const loc of locations) {
      if (state.runs.get(slug) !== run) return;
      reveal(run, [loc]);
      if (isCurrent()) {
        els.mapEmpty.hidden = true;
        footprint.stopSpin();
        footprint.addLocations([loc]);
        renderKpis();
      }
      await sleep(Math.max(40, 110 / state.speed));
    }
  } else {
    // Miles de puntos: se incorporan por lotes, con destellos solo en una muestra.
    const batches = 14;
    const size = Math.ceil(locations.length / batches);
    for (let i = 0; i < locations.length; i += size) {
      if (state.runs.get(slug) !== run) return;
      const batch = locations.slice(i, i + size);
      reveal(run, batch);
      if (isCurrent()) {
        els.mapEmpty.hidden = true;
        footprint.stopSpin();
        footprint.addLocations(batch, { maxPulses: 3 });
        renderKpis();
        renderLayerToggles();
      }
      await sleep(Math.max(60, 170 / state.speed));
    }
  }
  if (isCurrent()) {
    renderLayerToggles();
    footprint.fit(run.revealed, { duration: 1300 });
  }
}

async function runCase(slug) {
  const data = await loadDetail(slug);
  const run = freshRun(data, "running");
  state.runs.set(slug, run);
  const isCurrent = () => state.current === slug && state.runs.get(slug) === run;
  if (isCurrent()) { state.openAgent = null; renderAll({ fit: false }); }

  let lastTick = performance.now();
  const clock = setInterval(() => {
    const now = performance.now();
    run.elapsed += now - lastTick;
    lastTick = now;
    if (isCurrent()) renderProgress();
  }, 250);

  for (let index = 0; index < data.agents.length; index += 1) {
    if (state.runs.get(slug) !== run) break;
    const agent = data.agents[index];
    const s = run.agents[index];
    s.status = "running";
    if (isCurrent()) { updateAgent(index); renderProgress(); renderQueue(); }

    const base = stepDuration(agent);
    const lineCount = agent.log.length;
    let progress = 0;
    let last = performance.now();
    while (true) {
      s.progress = progress;
      s.lines = Math.min(lineCount, Math.floor(progress * lineCount) + 1);
      const eased = 1 - Math.pow(1 - progress, 1.6);
      s.tokens = agent.tokens * eased;
      s.requests = agent.requests ? Math.max(1, agent.requests * eased) : 0;
      s.cost = agent.costUsd * eased;
      s.records = agent.records * eased;
      if (isCurrent()) { updateAgent(index); renderKpis(); }
      if (progress >= 1) break;
      await sleep(140);
      const now = performance.now();
      // La velocidad se lee en cada paso para que cambiarla afecte también al paso en curso.
      progress = Math.min(1, progress + ((now - last) * state.speed) / base);
      last = now;
    }
    Object.assign(s, { status: "done", lines: lineCount, tokens: agent.tokens, requests: agent.requests, cost: agent.costUsd, records: agent.records, progress: 0 });
    if (isCurrent()) { updateAgent(index); renderProgress(); renderKpis(); }
    await revealStep(slug, run, data.byStep.get(agent.task), isCurrent);
    await sleep(350 / state.speed);
  }

  clearInterval(clock);
  if (state.runs.get(slug) !== run) return;
  // Registros sin paso propio (no debería haberlos) entran en la consolidación.
  reveal(run, data.locations);
  run.status = "done";
  run.elapsed += performance.now() - lastTick;
  if (isCurrent()) {
    renderAll({ fit: true });
    const t = data.totals;
    toast("Análisis completado", `${data.name}: ${number.format(t.locations)} localizaciones en ${t.countries} ${t.countries === 1 ? "país" : "países"}`);
  } else {
    renderQueue();
  }
}

// --------------------------------------------------------------------------- selección y arranque

function renderAll({ fit = true } = {}) {
  renderQueue();
  renderHero();
  renderKpis();
  renderFlow();
  renderLayerToggles();
  syncMap({ fit });
  renderResults();
}

async function selectCase(slug, { autorun = false } = {}) {
  if (!summaryOf(slug)) return;
  state.current = slug;
  state.openAgent = null;
  state.selectedId = null;
  els.inventorySearch.value = "";
  els.inventoryLayer.value = "";
  const url = new URL(location.href);
  url.searchParams.set("empresa", slug);
  url.searchParams.delete("ejecutar");
  history.replaceState(null, "", url);
  renderAll({ fit: true });
  await loadDetail(slug);
  if (state.current !== slug) return;
  runState(slug);
  renderAll({ fit: false });
  if (autorun) runCase(slug);
}

function bindControls() {
  els.queueSearch.addEventListener("input", renderQueue);
  els.runButton.addEventListener("click", () => runCase(state.current));
  document.querySelectorAll(".speed button").forEach((button) => button.addEventListener("click", () => {
    state.speed = Number(button.dataset.speed);
    document.querySelectorAll(".speed button").forEach((b) => b.classList.toggle("is-active", b === button));
  }));
  document.querySelectorAll("[data-projection]").forEach((button) => button.addEventListener("click", () => {
    footprint.setGlobe(button.dataset.projection === "globe");
    document.querySelectorAll("[data-projection]").forEach((b) => b.classList.toggle("is-active", b === button));
  }));
  document.querySelectorAll("[data-theme]").forEach((button) => button.addEventListener("click", () => {
    footprint.setTheme(button.dataset.theme);
    document.querySelectorAll("[data-theme]").forEach((b) => b.classList.toggle("is-active", b === button));
  }));
  $("#fitButton").addEventListener("click", () => footprint.fit());
  document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((b) => {
      b.classList.toggle("is-active", b === button);
      b.setAttribute("aria-selected", String(b === button));
    });
    renderResults();
  }));
  let searchTimer;
  els.inventorySearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderInventory, 120);
  });
  els.inventoryLayer.addEventListener("change", renderInventory);
}

async function init() {
  renderLegend();
  footprint = new FootprintMap(document.querySelector("#map"), {
    theme: "dark", globe: true,
    onSelect: (loc) => {
      state.selectedId = loc.id;
      els.inventoryBody.querySelectorAll("tr").forEach((tr) => tr.classList.toggle("is-selected", tr.dataset.id === loc.id));
    },
  });
  const { cases } = await (await fetch("/data/index.json")).json();
  state.index = cases;
  bindControls();
  const params = new URLSearchParams(location.search);
  const requested = params.get("empresa");
  await selectCase(summaryOf(requested) ? requested : cases[0].slug, { autorun: params.has("ejecutar") });
}

init();
