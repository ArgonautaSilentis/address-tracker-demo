import { FootprintMap, LAYERS, escapeHtml } from "/assets/map.js";

const $ = (selector) => document.querySelector(selector);
const els = {
  queueCount: $("#queueCount"), queueSearch: $("#queueSearch"), queueList: $("#queueList"), legendList: $("#legendList"),
  sectorChip: $("#sectorChip"), stateChip: $("#stateChip"), companyName: $("#companyName"), companyMeta: $("#companyMeta"),
  runStep: $("#runStep"), runClock: $("#runClock"), runBar: $("#runBar"), runButton: $("#runButton"),
  runButtonText: $("#runButtonText"), flowList: $("#flowList"), layerToggles: $("#layerToggles"), mapEmpty: $("#mapEmpty"),
  resultsLocked: $("#resultsLocked"), inventorySearch: $("#inventorySearch"), inventoryLayer: $("#inventoryLayer"),
  inventoryCount: $("#inventoryCount"), inventoryBody: $("#inventoryBody"), tabProfile: $("#tabProfile"),
  tabStrategy: $("#tabStrategy"), tabExport: $("#tabExport"), toastRegion: $("#toastRegion"),
  kpi: {
    locations: $("#kpiLocations"), countries: $("#kpiCountries"), geo: $("#kpiGeo"), source: $("#kpiSource"),
    requests: $("#kpiRequests"), tokens: $("#kpiTokens"), cost: $("#kpiCost"),
  },
};

const STAGES = { plan: "Planificación", extract: "Extracción", consolidate: "Consolidación" };
const number = new Intl.NumberFormat("es-ES");
const compact = new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 1 });
const usd = (value, digits = 3) => `$${value.toFixed(digits).replace(".", ",")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  cases: [],
  current: null,
  speed: 1,
  runs: new Map(),
  openAgent: null,
  selectedId: null,
  tab: "inventory",
};

// --------------------------------------------------------------------------- estado por empresa

function runState(slug) {
  if (!state.runs.has(slug)) {
    const data = caseBySlug(slug);
    state.runs.set(slug, {
      status: "idle", step: -1, elapsed: 0, revealed: new Set(),
      agents: data.agents.map(() => ({ status: "pending", lines: 0, tokens: 0, requests: 0, cost: 0 })),
    });
  }
  return state.runs.get(slug);
}

const caseBySlug = (slug) => state.cases.find((c) => c.slug === slug);
const current = () => caseBySlug(state.current);

function revealedLocations(data, run) {
  return data.locations.filter((loc) => run.revealed.has(loc.id));
}

function placeOf(headquarters) {
  const parts = String(headquarters || "").split(",").map((p) => p.replace(/\b\d{3,}\b/g, "").trim()).filter(Boolean);
  return parts.slice(-2).join(", ");
}

// --------------------------------------------------------------------------- bandeja

function renderQueue() {
  const term = els.queueSearch.value.trim().toLowerCase();
  els.queueList.replaceChildren();
  const visible = state.cases.filter((c) => !term || `${c.name} ${c.sector} ${c.headquarters}`.toLowerCase().includes(term));
  for (const data of visible) {
    const run = runState(data.slug);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "queue-item" + (data.slug === state.current ? " is-selected" : "");
    item.setAttribute("role", "listitem");
    const label = { idle: "Pendiente", running: "Analizando", done: "Completado" }[run.status];
    const detail = run.status === "done" ? `${data.totals.locations} localizaciones · ${data.totals.countries} ${data.totals.countries === 1 ? "país" : "países"}` : placeOf(data.headquarters);
    item.innerHTML = `
      <span class="queue-item-top"><span class="queue-sector">${escapeHtml(data.sector)}</span>
      <span class="state-pill" data-state="${run.status}">${label}</span></span>
      <span class="queue-name">${escapeHtml(data.name)}</span>
      <span class="queue-meta">${escapeHtml(detail)}</span>`;
    item.addEventListener("click", () => selectCase(data.slug));
    els.queueList.append(item);
  }
  els.queueCount.textContent = state.cases.filter((c) => runState(c.slug).status !== "done").length;
}

function renderLegend() {
  els.legendList.innerHTML = Object.entries(LAYERS)
    .map(([key, layer]) => `<li><span class="layer-dot" data-layer="${key}"></span>${escapeHtml(layer.label)}</li>`).join("");
}

// --------------------------------------------------------------------------- cabecera e indicadores

function renderHero() {
  const data = current();
  const run = runState(data.slug);
  els.sectorChip.textContent = data.sector;
  els.companyName.textContent = data.name;
  const brands = data.profile.brands.length;
  els.companyMeta.innerHTML = `Sede <b>${escapeHtml(placeOf(data.headquarters) || "—")}</b>` +
    (data.profile.parent ? ` · Matriz <b>${escapeHtml(data.profile.parent)}</b>` : "") +
    (brands ? ` · ${brands} ${brands === 1 ? "marca" : "marcas"}` : "");
  const label = { idle: "Pendiente", running: "Analizando", done: "Completado" }[run.status];
  els.stateChip.textContent = label;
  els.stateChip.dataset.state = run.status;
  renderProgress();
}

function renderProgress() {
  const data = current();
  const run = runState(data.slug);
  const done = run.agents.filter((a) => a.status === "done").length;
  const total = data.agents.length;
  const running = run.agents.findIndex((a) => a.status === "running");
  if (run.status === "idle") els.runStep.textContent = `${total} agentes listos`;
  else if (run.status === "done") els.runStep.textContent = `Análisis completado · ${total}/${total}`;
  else {
    const active = running >= 0 ? running : Math.min(done, total - 1);
    els.runStep.textContent = `${data.agents[active].label} · ${active + 1}/${total}`;
  }
  const partial = running >= 0 ? run.agents[running].progress || 0 : 0;
  els.runBar.style.width = `${((done + partial) / total) * 100}%`;
  const seconds = Math.floor(run.elapsed / 1000);
  els.runClock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  els.runButton.disabled = run.status === "running";
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
  const data = current();
  const run = runState(data.slug);
  const shown = revealedLocations(data, run);
  const sum = (field) => run.agents.reduce((acc, a) => acc + a[field], 0);
  setKpi("locations", number.format(shown.length));
  setKpi("countries", number.format(new Set(shown.map((l) => l.country).filter(Boolean)).size));
  const geocoded = run.agents[7].status === "done";
  const exported = run.agents[8].status === "done";
  setKpi("geo", geocoded && shown.length ? `${Math.round((shown.filter((l) => Number.isFinite(l.lat)).length / shown.length) * 100)} %` : "—");
  setKpi("source", exported ? `${Math.round((data.totals.withSource / data.totals.locations) * 100)} %` : "—");
  setKpi("requests", number.format(Math.round(sum("requests"))));
  setKpi("tokens", compact.format(Math.round(sum("tokens"))));
  setKpi("cost", usd(sum("cost")));
}

// --------------------------------------------------------------------------- flujo de agentes

function renderFlow() {
  const data = current();
  const run = runState(data.slug);
  els.flowList.replaceChildren();
  let lastStage = null;
  data.agents.forEach((agent, index) => {
    if (agent.stage !== lastStage) {
      const stage = document.createElement("p");
      stage.className = "flow-stage";
      stage.textContent = `${STAGES[agent.stage]}`;
      els.flowList.append(stage);
      lastStage = agent.stage;
    }
    const node = document.createElement("div");
    node.className = "agent";
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
      const s = runState(data.slug).agents[index];
      if (s.status !== "done") return;
      state.openAgent = state.openAgent === index ? null : index;
      for (const other of els.flowList.querySelectorAll(".agent")) other.classList.toggle("is-open", Number(other.dataset.index) === state.openAgent);
    });
    els.flowList.append(node);
    updateAgent(index);
  });
}

function updateAgent(index) {
  const data = current();
  const run = runState(data.slug);
  const agent = data.agents[index];
  const s = run.agents[index];
  const node = els.flowList.querySelector(`.agent[data-index="${index}"]`);
  if (!node) return;
  node.dataset.state = s.status;
  node.classList.toggle("is-open", state.openAgent === index && s.status === "done");
  node.querySelector(".agent-row").disabled = s.status !== "done";
  const metric = node.querySelector(".agent-metric");
  metric.textContent = s.status === "pending" ? "—" : `${compact.format(Math.round(s.tokens))} tok`;

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

  node.querySelector(".agent-stats").innerHTML = s.status === "pending" ? "" :
    `<span>Modelo <b>${escapeHtml(agent.model)}</b></span><span>Llamadas <b>${number.format(Math.round(s.requests))}</b></span>` +
    `<span>Tokens <b>${number.format(Math.round(s.tokens))}</b></span><span>Coste <b>${usd(s.cost, 4)}</b></span>`;
}

// --------------------------------------------------------------------------- mapa

let footprint;

function renderLayerToggles() {
  const data = current();
  const run = runState(data.slug);
  const shown = revealedLocations(data, run);
  const counts = {};
  for (const loc of shown) counts[loc.layer] = (counts[loc.layer] || 0) + 1;
  const layers = Object.keys(LAYERS).filter((key) => data.totals.layers[key]);
  els.layerToggles.replaceChildren(...layers.map((key) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "layer-toggle";
    button.setAttribute("aria-pressed", String(footprint?.visibleLayers.has(key) ?? true));
    button.innerHTML = `<span class="layer-dot" data-layer="${key}"></span>${escapeHtml(LAYERS[key].short)} <b>${counts[key] || 0}</b>`;
    button.addEventListener("click", () => {
      const visible = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(visible));
      footprint?.setLayerVisible(key, visible);
    });
    return button;
  }));
}

function syncMap({ fit = true } = {}) {
  const data = current();
  const run = runState(data.slug);
  const shown = revealedLocations(data, run);
  footprint.setLocations(shown);
  els.mapEmpty.hidden = shown.length > 0 || run.status === "done";
  if (shown.length && fit) {
    footprint.stopSpin();
    footprint.fit(shown, { duration: 1200 });
  } else if (!shown.length) {
    footprint.flyToPoint(8, 30, 1.3, 1200);
    footprint.spin();
  }
}

// --------------------------------------------------------------------------- resultados

function renderResults() {
  const data = current();
  const run = runState(data.slug);
  const unlocked = run.status === "done";
  els.resultsLocked.hidden = unlocked;
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
  const data = current();
  const term = els.inventorySearch.value.trim().toLowerCase();
  const layer = els.inventoryLayer.value;
  const layers = Object.keys(LAYERS).filter((key) => data.totals.layers[key]);
  if (els.inventoryLayer.dataset.slug !== data.slug) {
    els.inventoryLayer.innerHTML = '<option value="">Todas las capas</option>' +
      layers.map((key) => `<option value="${key}">${escapeHtml(LAYERS[key].label)} (${data.totals.layers[key]})</option>`).join("");
    els.inventoryLayer.dataset.slug = data.slug;
  }
  const rows = data.locations.filter((loc) => (!layer || loc.layer === layer) &&
    (!term || `${loc.name} ${loc.type} ${loc.city} ${loc.region} ${loc.country}`.toLowerCase().includes(term)));
  els.inventoryCount.textContent = `${rows.length} de ${data.locations.length} registros`;
  els.inventoryBody.replaceChildren(...rows.map((loc) => {
    const tr = document.createElement("tr");
    tr.dataset.id = loc.id;
    tr.classList.toggle("is-selected", loc.id === state.selectedId);
    let host = "";
    try { host = loc.sourceUrl ? new URL(loc.sourceUrl).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }
    tr.innerHTML = `
      <td><span class="layer-chip"><span class="layer-dot" data-layer="${loc.layer}"></span>${escapeHtml(LAYERS[loc.layer].short)}</span></td>
      <td><strong>${escapeHtml(loc.name)}</strong>${loc.relationship ? `<small>${escapeHtml(loc.relationship)}</small>` : ""}</td>
      <td>${escapeHtml(loc.type || "—")}${loc.subtype && loc.subtype !== loc.type ? `<small>${escapeHtml(loc.subtype)}</small>` : ""}</td>
      <td>${escapeHtml([loc.city, loc.country].filter(Boolean).join(", ") || "—")}<small>${Number.isFinite(loc.lat) ? `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}` : ""}</small></td>
      <td>${escapeHtml(loc.status || "—")}</td>
      <td>${loc.sourceUrl ? `<a href="${escapeHtml(loc.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host)} ↗</a>` : "—"}</td>`;
    tr.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      document.querySelector(".map-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
      footprint.select(loc.id);
    });
    return tr;
  }));
}

function list(items, empty = "—") {
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
  const p = current().profile;
  els.tabProfile.innerHTML = `
    <div class="profile-grid">
      <article class="info-card"><h3>Razón social</h3><p class="info-big">${escapeHtml(p.canonicalName)}</p>${p.parent ? `<p>Matriz: ${escapeHtml(p.parent)}</p>` : ""}</article>
      <article class="info-card"><h3>Sede</h3><p class="info-big">${escapeHtml(placeOf(p.headquarters) || "—")}</p><p>${escapeHtml(p.headquarters)}</p></article>
      <article class="info-card"><h3>Identificadores públicos</h3>${kv(p.identifiers)}</article>
      <article class="info-card"><h3>Códigos de actividad</h3>${kv(p.activityCodes)}</article>
      <article class="info-card"><h3>Marcas</h3>${list(p.brands)}</article>
      <article class="info-card"><h3>Filiales principales</h3>${list(p.subsidiaries)}</article>
      <article class="info-card"><h3>Países de operación</h3>${list(p.countries)}</article>
      <article class="info-card"><h3>Webs oficiales</h3>${links(p.websites)}</article>
      ${p.summary ? `<article class="info-card info-card-wide"><h3>Resumen sectorial</h3><p>${escapeHtml(p.summary)}</p></article>` : ""}
      <article class="info-card info-card-wide"><h3>Fuentes del perfil</h3>${links(p.sources)}</article>
    </div>`;
}

function renderStrategy() {
  const plan = current().plan;
  els.tabStrategy.innerHTML = `
    <div class="profile-grid">
      <article class="info-card"><h3>Sector operativo</h3><p class="info-big">${escapeHtml(plan.sector)}</p><p>Confianza ${escapeHtml(plan.confidence)}</p></article>
      <article class="info-card info-card-wide"><h3>Orden de conectores</h3>
        <div class="chain">${plan.connectors.map((c, i) => `${i ? "<i>→</i>" : ""}<span><em>${i + 1}</em>${escapeHtml(c)}</span>`).join("")}</div></article>
      ${plan.notes ? `<article class="info-card info-card-wide"><h3>Criterio del planificador</h3><p class="quote">${escapeHtml(plan.notes)}</p></article>` : ""}
      <article class="info-card"><h3>Consultas de marca</h3>${list(plan.brandQueries)}</article>
      <article class="info-card"><h3>Consultas de filiales</h3>${list(plan.subsidiaryQueries)}</article>
    </div>`;
}

function renderExport() {
  const data = current();
  const names = { assets: "physical_assets", offices: "global_offices", entities: "operational_entities", brand: "brand_locations_discovered", other: "geocoded_locations" };
  els.tabExport.innerHTML = `
    <div class="export-grid">
      <article class="export-card"><h3>Vista maestra (CSV)</h3>
        <p>Todas las localizaciones deduplicadas, con capa, dirección normalizada, coordenadas y URL de la fuente.</p>
        <code>all_locations_master.csv · ${data.locations.length} filas</code>
        <button class="btn btn-light btn-sm" type="button" data-export="csv">Descargar CSV</button></article>
      <article class="export-card"><h3>Dataset completo (JSON)</h3>
        <p>Perfil corporativo, estrategia de fuentes y las capas de localizaciones en un único documento.</p>
        <code>${escapeHtml(data.slug)}_footprint.json</code>
        <button class="btn btn-light btn-sm" type="button" data-export="json">Descargar JSON</button></article>
      <article class="export-card"><h3>Capas generadas</h3>
        <ul class="dataset-list"><li><code>company_profile</code><b>1</b></li>
        ${Object.entries(data.totals.layers).map(([k, v]) => `<li><code>${names[k]}</code><b>${v}</b></li>`).join("")}</ul></article>
    </div>`;
  els.tabExport.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => download(button.dataset.export)));
}

function download(kind) {
  const data = current();
  let blob;
  let name;
  if (kind === "csv") {
    const header = ["layer", "name", "type", "address", "city", "region", "country", "postal_code", "latitude", "longitude", "status", "confidence", "source_url"];
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = data.locations.map((l) => [LAYERS[l.layer].label, l.name, l.type, l.address, l.city, l.region, l.country, l.postalCode, l.lat, l.lon, l.status, l.confidence, l.sourceUrl].map(cell).join(","));
    blob = new Blob(["﻿" + [header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    name = `${data.slug}_all_locations_master.csv`;
  } else {
    const { agents, ...rest } = data;
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

function agentDuration(agent) {
  return Math.min(7600, Math.max(2300, 1500 + agent.requests * 200));
}

async function runCase(slug) {
  const data = caseBySlug(slug);
  const fresh = { status: "running", step: 0, elapsed: 0, revealed: new Set(),
    agents: data.agents.map(() => ({ status: "pending", lines: 0, tokens: 0, requests: 0, cost: 0, progress: 0 })) };
  state.runs.set(slug, fresh);
  const run = fresh;
  const isCurrent = () => state.current === slug && state.runs.get(slug) === run;
  if (isCurrent()) { state.openAgent = null; renderAll({ fit: false }); }

  let lastTick = performance.now();
  const clock = setInterval(() => {
    const now = performance.now();
    run.elapsed += (now - lastTick);
    lastTick = now;
    if (isCurrent()) renderProgress();
  }, 250);

  for (let index = 0; index < data.agents.length; index += 1) {
    if (state.runs.get(slug) !== run) break;
    const agent = data.agents[index];
    const s = run.agents[index];
    s.status = "running";
    run.step = index;
    if (isCurrent()) { updateAgent(index); renderProgress(); renderQueue(); }

    const base = agentDuration(agent);
    const lineCount = agent.log.length;
    let progress = 0;
    let last = performance.now();
    while (true) {
      s.progress = progress;
      s.lines = Math.min(lineCount, Math.floor(progress * lineCount) + 1);
      const eased = 1 - Math.pow(1 - progress, 1.6);
      s.tokens = agent.tokens * eased;
      s.requests = Math.max(1, agent.requests * eased);
      s.cost = agent.costUsd * eased;
      if (isCurrent()) { updateAgent(index); renderKpis(); }
      if (progress >= 1) break;
      await sleep(140);
      const now = performance.now();
      // La velocidad se lee en cada paso para que cambiarla afecte también al agente en curso.
      progress = Math.min(1, progress + ((now - last) * state.speed) / base);
      last = now;
    }
    s.status = "done";
    s.lines = lineCount;
    s.tokens = agent.tokens;
    s.requests = agent.requests;
    s.cost = agent.costUsd;
    s.progress = 0;

    const newOnes = data.locations.filter((loc) => agent.reveals.includes(loc.id));
    if (isCurrent()) { updateAgent(index); renderProgress(); renderKpis(); }
    if (newOnes.length) {
      for (const loc of newOnes) run.revealed.add(loc.id);
      if (isCurrent()) {
        els.mapEmpty.hidden = true;
        footprint.stopSpin();
        for (const loc of newOnes) {
          footprint.addLocations([loc]);
          renderKpis();
          await sleep(Math.max(40, 110 / state.speed));
        }
        renderLayerToggles();
        footprint.fit(revealedLocations(data, run), { duration: 1300 });
      }
    }
    await sleep(350 / state.speed);
  }

  clearInterval(clock);
  if (state.runs.get(slug) !== run) return;
  run.status = "done";
  run.elapsed += performance.now() - lastTick;
  if (isCurrent()) {
    renderAll({ fit: true });
    toast("Análisis completado", `${data.name}: ${data.totals.locations} localizaciones en ${data.totals.countries} ${data.totals.countries === 1 ? "país" : "países"}`);
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

function selectCase(slug) {
  if (!caseBySlug(slug)) return;
  state.current = slug;
  state.openAgent = null;
  state.selectedId = null;
  els.inventorySearch.value = "";
  els.inventoryLayer.value = "";
  const url = new URL(location.href);
  url.searchParams.set("empresa", slug);
  history.replaceState(null, "", url);
  renderAll({ fit: true });
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
  els.inventorySearch.addEventListener("input", renderInventory);
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
  const response = await fetch("/data/cases.json");
  const payload = await response.json();
  state.cases = payload.cases;
  bindControls();
  const params = new URLSearchParams(location.search);
  const requested = params.get("empresa");
  selectCase(caseBySlug(requested) ? requested : state.cases[0].slug);
  if (params.has("ejecutar")) runCase(state.current);
}

init();
