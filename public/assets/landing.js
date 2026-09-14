import { FootprintMap, LAYERS, escapeHtml } from "/assets/map.js";

const DESCRIPTIONS = {
  plan_source_strategy: "Clasifica la empresa por sector y decide qué conectores lideran cada capa.",
  research_company_profile: "Razón social, matriz, marcas, filiales, sede e identificadores públicos.",
  hunt_all_company_assets: "Plantas, fábricas, hubs logísticos e infraestructuras productivas.",
  map_all_global_offices: "Sede y oficinas regionales, administrativas y comerciales.",
  map_operational_entities: "Filiales, joint ventures, terminales y operadores vinculados.",
  discover_brand_locations: "Tiendas, showrooms y puntos visibles en mapas y localizadores.",
  enrich_physical_assets: "Reclasifica, amplía vía filiales y añade contexto y confianza.",
  geocode_all_locations: "Normaliza direcciones y asigna coordenadas con su procedencia.",
  export_consolidated_data: "Deduplica, estandariza y exporta la vista maestra en JSON y CSV.",
};
const STAGES = [
  ["plan", "Planificación", "1 agente"],
  ["extract", "Extracción", "5 agentes"],
  ["consolidate", "Consolidación", "3 agentes"],
];

const number = new Intl.NumberFormat("es-ES");

const set = (key, value) => { const el = document.querySelector(`[data-stat="${key}"]`); if (el) el.textContent = value; };

function renderStats(index, details) {
  const locations = index.reduce((acc, c) => acc + c.totals.locations, 0);
  const geo = index.reduce((acc, c) => acc + c.totals.withCoordinates, 0);
  const withCost = index.filter((c) => c.hasCost);
  const cost = withCost.reduce((acc, c) => acc + c.totals.costUsd, 0) / withCost.length;
  set("cases", number.format(index.length));
  set("locations", number.format(locations));
  set("geo", `${Math.round((geo / locations) * 100)} %`);
  set("cost", `${cost.toFixed(2).replace(".", ",")} US$`);
  if (details) {
    const countries = new Set(details.flatMap((d) => d.locations.map((l) => l.country)).filter(Boolean));
    set("countries", number.format(countries.size));
  }
}

function renderConnectorStats(index) {
  const iberdrola = index.find((c) => c.slug === "iberdrola");
  const glencore = index.find((c) => c.slug === "glencore");
  if (iberdrola) {
    const l = iberdrola.totals.layers;
    set("ib-locations", number.format(iberdrola.totals.locations));
    set("ib-charging", number.format(l.charging || 0));
    set("ib-assets", number.format(l.assets || 0));
    set("ib-offices", number.format(l.offices || 0));
    set("ib-countries", number.format(iberdrola.totals.countries));
  }
  if (glencore) {
    const l = glencore.totals.layers;
    set("gl-entities", number.format(l.entities || 0));
    set("gl-assets", number.format(l.assets || 0));
    set("gl-countries", number.format(glencore.totals.countries));
    set("gl-locations", number.format(glencore.totals.locations));
  }
}

function renderPipeline(agents, example) {
  const root = document.querySelector("#pipeline");
  let index = 0;
  root.innerHTML = STAGES.map(([stage, title, count]) => {
    const cards = agents.filter((a) => a.stage === stage).map((agent) => {
      index += 1;
      const wide = stage === "extract" && agent.task === "research_company_profile";
      return `<article class="agent-card${wide ? " agent-card-wide" : ""}">
        <span class="agent-card-num">${index}</span>
        <h3>${escapeHtml(agent.label)}</h3><p>${escapeHtml(agent.agent)}</p>
        <p class="agent-card-desc">${escapeHtml(DESCRIPTIONS[agent.task] || "")}</p>
        <div class="tool-row">${agent.tools.length ? agent.tools.map((t) => `<span>${escapeHtml(t.replace(/Tool$/, ""))}</span>`).join("") : "<span>Razonamiento</span>"}</div>
      </article>`;
    }).join("");
    const extra = stage === "plan" && example ? `<div class="plan-example">
        <p class="plan-example-kicker">Plan generado · ${escapeHtml(example.name)}</p>
        <p class="plan-example-sector">${escapeHtml(example.plan.sector)} <span>· confianza ${escapeHtml(example.plan.confidence)}</span></p>
        <ol class="plan-chain">${example.plan.connectors.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ol>
      </div>` : "";
    return `<div class="stage-col stage-col-${stage}"><div class="stage-head"><strong>${title}</strong><span>${count}</span></div><div class="stage-agents">${cards}</div>${extra}</div>`;
  }).join("");
}

function heroMap() {
  const container = document.querySelector("#heroMap");
  const map = new FootprintMap(container, { theme: "dark", globe: true, interactive: false, center: [-28, 18], zoom: 2.05 });
  map.spin(4);
  return map;
}

function renderExplorer(index, loadDetail) {
  const tabs = document.querySelector("#explorerTabs");
  const side = document.querySelector("#explorerSide");
  const map = new FootprintMap(document.querySelector("#explorerMap"), { theme: "light", globe: false, center: [0, 25], zoom: 1.2 });
  let requested = null;

  async function show(slug) {
    requested = slug;
    for (const tab of tabs.querySelectorAll("button")) tab.setAttribute("aria-selected", String(tab.dataset.slug === slug));
    const data = await loadDetail(slug);
    if (requested !== slug) return;
    map.setLocations(data.locations);
    map.fit(data.locations, { duration: 1400, padding: 60, maxZoom: 7 });
    const layers = Object.keys(LAYERS).filter((key) => data.totals.layers[key]);
    const total = data.totals.locations;
    const featured = data.locations.filter((l) => (l.layer === "assets" || l.layer === "offices") && Number.isFinite(l.lat)).slice(0, 6);
    side.innerHTML = `
      <div><p class="side-title">${escapeHtml(data.name)}</p><p class="side-sub">${escapeHtml(data.sector)} · ${data.totals.countries} ${data.totals.countries === 1 ? "país" : "países"}</p></div>
      <div class="side-bar">${layers.map((key) => `<span style="width:${(data.totals.layers[key] / total) * 100}%;background:${LAYERS[key].color}"></span>`).join("")}</div>
      <ul class="side-counts">${layers.map((key) => `<li><span class="layer-dot" data-layer="${key}"></span>${escapeHtml(LAYERS[key].label)}<b>${number.format(data.totals.layers[key])}</b></li>`).join("")}</ul>
      <div class="side-metrics">
        <div><b>${number.format(total)}</b><span>localizaciones</span></div>
        <div><b>${Math.round((data.totals.withCoordinates / total) * 100)} %</b><span>geolocalizadas</span></div>
        ${data.hasCost ? `<div><b>${data.totals.costUsd.toFixed(2).replace(".", ",")} $</b><span>coste LLM</span></div>`
          : `<div><b>${data.totals.countries}</b><span>países</span></div>`}
      </div>
      <ul class="side-list">${featured.map((l) => `<li><button type="button" data-id="${l.id}"><span class="layer-dot" data-layer="${l.layer}"></span>${escapeHtml(l.name)}<small>${escapeHtml(l.city || l.country || "")}</small></button></li>`).join("")}</ul>
      <a class="btn btn-light btn-sm side-link" href="/demo?empresa=${data.slug}">Analizar en la mesa →</a>`;
    side.querySelectorAll("[data-id]").forEach((button) => button.addEventListener("click", () => map.select(button.dataset.id)));
  }

  tabs.innerHTML = index.map((c) => `<button class="explorer-tab" type="button" role="tab" data-slug="${c.slug}" aria-selected="false">
    <strong>${escapeHtml(shortName(c.name))}</strong><span>${number.format(c.totals.locations)} localizaciones</span></button>`).join("");
  tabs.querySelectorAll("button").forEach((tab) => tab.addEventListener("click", () => show(tab.dataset.slug)));

  // El mapa se prepara cuando la sección entra en pantalla, para que el encuadre se anime a la vista.
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      observer.disconnect();
      map.resize();
      show(index[0].slug);
    }
  }, { threshold: 0.25 });
  observer.observe(document.querySelector(".explorer"));
}

function shortName(name) {
  return name.replace(/,?\s+(S\.A\.|PLC|plc|SE|Holding B\.V\.|Netherland)$/, "").replace(/^Inter\s+/, "");
}

async function init() {
  const { cases: index } = await (await fetch("/data/index.json")).json();
  const cache = new Map();
  const loadDetail = (slug) => {
    if (!cache.has(slug)) cache.set(slug, fetch(`/data/cases/${slug}.json`).then((r) => r.json()));
    return cache.get(slug);
  };
  renderStats(index);
  renderConnectorStats(index);
  const hero = heroMap();
  renderExplorer(index, loadDetail);
  const first = await loadDetail(index[0].slug);
  renderPipeline(first.agents, first);
  // El globo se va poblando empresa a empresa; la más pesada, al final.
  const order = [...index].sort((a, b) => a.totals.locations - b.totals.locations);
  const details = [];
  for (const item of order) {
    const data = await loadDetail(item.slug);
    details.push(data);
    hero.addLocations(data.locations, { pulse: false });
  }
  renderStats(index, details);
}

init();
