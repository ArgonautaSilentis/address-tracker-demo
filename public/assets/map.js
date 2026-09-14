// Mapa de la huella corporativa sobre MapLibre (global `maplibregl`, cargado antes que este módulo).

export const LAYERS = {
  assets: { label: "Activos físicos", short: "Activos", color: "#ffc400" },
  offices: { label: "Oficinas corporativas", short: "Oficinas", color: "#4f8cff" },
  entities: { label: "Entidades operativas", short: "Entidades", color: "#2fbf8f" },
  brand: { label: "Localizaciones de marca", short: "Marca", color: "#ff6b9a" },
  linked: { label: "Activos vinculados", short: "Vinculados", color: "#fb923c" },
  charging: { label: "Red de recarga", short: "Recarga", color: "#a78bfa" },
  other: { label: "Otras localizaciones", short: "Otras", color: "#9ca5b5" },
};

const STYLES = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
};

const SOURCE = "locations";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function featureCollection(locations) {
  return {
    type: "FeatureCollection",
    features: locations
      .filter((loc) => Number.isFinite(loc.lat) && Number.isFinite(loc.lon))
      .map((loc) => ({
        type: "Feature",
        id: loc.id,
        geometry: { type: "Point", coordinates: [loc.lon, loc.lat] },
        properties: { id: loc.id, layer: loc.layer, name: loc.name },
      })),
  };
}

const colorExpression = ["match", ["get", "layer"],
  "assets", LAYERS.assets.color, "offices", LAYERS.offices.color, "entities", LAYERS.entities.color,
  "brand", LAYERS.brand.color, "linked", LAYERS.linked.color, "charging", LAYERS.charging.color, LAYERS.other.color];

const isDense = ["==", ["get", "layer"], "charging"];

export function popupHtml(loc) {
  const layer = LAYERS[loc.layer] || LAYERS.other;
  const place = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
  const meta = [loc.status, loc.capacity, loc.confidence && `Confianza ${loc.confidence.toLowerCase()}`, loc.relationship, loc.system]
    .filter(Boolean).slice(0, 3);
  let host = "";
  try { host = loc.sourceUrl ? new URL(loc.sourceUrl).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }
  return `
    <div class="popup-layer"><span class="layer-dot" data-layer="${loc.layer}"></span>${escapeHtml(layer.label)}</div>
    <p class="popup-name">${escapeHtml(loc.name)}</p>
    ${loc.type ? `<p class="popup-type">${escapeHtml(loc.type)}${loc.subtype && loc.subtype !== loc.type ? ` · ${escapeHtml(loc.subtype)}` : ""}</p>` : ""}
    <p class="popup-address">${escapeHtml(loc.address || place)}</p>
    ${meta.length ? `<div class="popup-meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join("")}</div>` : ""}
    ${loc.owner ? `<p class="popup-owner">Titular: ${escapeHtml(loc.owner)}</p>` : ""}
    ${Number.isFinite(loc.lat) ? `<p class="popup-coords">${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}</p>` : ""}
    ${loc.sourceUrl ? `<a class="popup-source" href="${escapeHtml(loc.sourceUrl)}" target="_blank" rel="noopener noreferrer">Fuente · ${escapeHtml(host)} ↗</a>`
      : loc.source ? `<p class="popup-source-text">Fuente · ${escapeHtml(loc.source)}</p>` : ""}`;
}

export class FootprintMap {
  constructor(container, { theme = "dark", globe = true, interactive = true, onSelect = null, center = [8, 30], zoom = 1.3 } = {}) {
    this.container = container;
    this.theme = theme;
    this.globe = globe;
    this.onSelect = onSelect;
    this.locations = [];
    this.visibleLayers = new Set(Object.keys(LAYERS));
    this.byId = new Map();
    this.ready = false;
    this.popup = null;
    this.spinning = false;

    if (typeof maplibregl === "undefined") {
      this.fail();
      return;
    }
    try {
      this.map = new maplibregl.Map({
        container, style: STYLES[theme], center, zoom, interactive,
        attributionControl: { compact: true }, fadeDuration: 0,
      });
    } catch {
      this.fail();
      return;
    }
    if (interactive) this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    this.map.on("style.load", () => this.install());
    this.map.on("click", "loc-point", (event) => {
      const id = event.features?.[0]?.properties?.id;
      if (id) this.select(id, { fly: false });
    });
    this.map.on("mouseenter", "loc-point", () => { this.map.getCanvas().style.cursor = "pointer"; });
    this.map.on("mouseleave", "loc-point", () => { this.map.getCanvas().style.cursor = ""; });
    this.map.on("error", (event) => {
      if (!this.ready && event?.error?.status >= 400) this.fail();
      else if (event?.error) console.warn("Mapa:", event.error.message || event.error);
    });
  }

  fail() {
    if (this.container.querySelector(".map-fallback")) return;
    const box = document.createElement("div");
    box.className = "map-fallback";
    box.textContent = "No se pudo cargar la cartografía. Las localizaciones siguen disponibles en el inventario.";
    this.container.append(box);
  }

  install() {
    const map = this.map;
    if (this.globe) map.setProjection({ type: "globe" });
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: "geojson", data: featureCollection(this.visible()), promoteId: "id" });
    }
    const glowOpacity = this.theme === "dark" ? 0.28 : 0.12;
    if (!map.getLayer("loc-glow")) {
      map.addLayer({
        id: "loc-glow", type: "circle", source: SOURCE, filter: ["!", isDense],
        paint: {
          "circle-color": colorExpression, "circle-opacity": glowOpacity, "circle-blur": 0.9,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 13, 4, 16, 8, 20, 12, 24],
        },
      });
      map.addLayer({
        id: "loc-point", type: "circle", source: SOURCE,
        paint: {
          "circle-color": colorExpression,
          // «zoom» solo puede ir en un interpolate de primer nivel: la distinción por capa va dentro de cada parada.
          "circle-radius": ["interpolate", ["linear"], ["zoom"],
            1, ["case", isDense, 1.7, 5], 4, ["case", isDense, 2.2, 6], 8, ["case", isDense, 3.4, 7], 12, ["case", isDense, 5.5, 9]],
          "circle-opacity": ["case", isDense, 0.85, 1],
          "circle-stroke-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, isDense, 0, 1.4],
          "circle-stroke-color": this.theme === "dark" ? "#060d20" : "#ffffff",
        },
      });
    }
    this.ready = true;
    this.refresh();
  }

  visible() {
    return this.locations.filter((loc) => this.visibleLayers.has(loc.layer));
  }

  refresh() {
    if (!this.ready) return;
    this.map.getSource(SOURCE)?.setData(featureCollection(this.visible()));
  }

  setLocations(locations) {
    this.locations = [...locations];
    this.byId = new Map(this.locations.map((loc) => [loc.id, loc]));
    this.closePopup();
    this.refresh();
  }

  addLocations(locations, { pulse = true, maxPulses = 24 } = {}) {
    let pulses = 0;
    const step = Math.max(1, Math.floor(locations.length / maxPulses));
    locations.forEach((loc, index) => {
      if (this.byId.has(loc.id)) return;
      this.locations.push(loc);
      this.byId.set(loc.id, loc);
      if (pulse && this.map && pulses < maxPulses && index % step === 0 && this.visibleLayers.has(loc.layer) && Number.isFinite(loc.lat)) {
        this.pulse(loc);
        pulses += 1;
      }
    });
    this.refresh();
  }

  pulse(loc) {
    const el = document.createElement("div");
    el.className = "pulse-marker";
    el.style.setProperty("--pulse-color", (LAYERS[loc.layer] || LAYERS.other).color);
    const marker = new maplibregl.Marker({ element: el }).setLngLat([loc.lon, loc.lat]).addTo(this.map);
    setTimeout(() => marker.remove(), 1800);
  }

  setLayerVisible(layer, visible) {
    if (visible) this.visibleLayers.add(layer); else this.visibleLayers.delete(layer);
    this.refresh();
  }

  setTheme(theme) {
    if (!this.map || theme === this.theme) return;
    this.theme = theme;
    this.ready = false;
    this.map.setStyle(STYLES[theme]);
  }

  setGlobe(globe) {
    this.globe = globe;
    if (this.map && this.ready) this.map.setProjection({ type: globe ? "globe" : "mercator" });
  }

  fit(locations = this.visible(), { duration = 1600, maxZoom = 8, padding = 70 } = {}) {
    if (!this.map) return;
    const pts = locations.filter((loc) => Number.isFinite(loc.lat));
    if (!pts.length) return;
    if (pts.length === 1) {
      this.map.flyTo({ center: [pts[0].lon, pts[0].lat], zoom: 6, duration });
      return;
    }
    // Centroide esférico y distancia angular de cada punto. Se encuadra el 90 % más cercano para que unos
    // pocos puntos lejanos (una oficina en Australia) no alejen la cámara de donde se concentra la huella.
    const rad = Math.PI / 180;
    let x = 0; let y = 0; let z = 0;
    for (const loc of pts) {
      x += Math.cos(loc.lat * rad) * Math.cos(loc.lon * rad);
      y += Math.cos(loc.lat * rad) * Math.sin(loc.lon * rad);
      z += Math.sin(loc.lat * rad);
    }
    const lon = Math.atan2(y, x) / rad;
    const lat = Math.atan2(z, Math.hypot(x, y)) / rad;
    const distance = (loc) => {
      const cos = Math.sin(lat * rad) * Math.sin(loc.lat * rad) +
        Math.cos(lat * rad) * Math.cos(loc.lat * rad) * Math.cos((loc.lon - lon) * rad);
      return Math.acos(Math.min(1, Math.max(-1, cos))) / rad;
    };
    const measured = pts.map((loc) => [distance(loc), loc]).sort((a, b) => a[0] - b[0]);
    const cut = pts.length > 20 ? Math.floor(measured.length * 0.9) : measured.length - 1;
    const spread = measured[cut][0];
    const inliers = measured.slice(0, cut + 1).map(([, loc]) => loc);

    if (this.globe && spread > 12) {
      const zoom = spread > 70 ? 1.15 : spread > 45 ? 1.6 : spread > 30 ? 2.2 : spread > 20 ? 2.8 : 3.4;
      this.map.flyTo({ center: [lon, lat], zoom, duration, essential: true });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const loc of inliers) bounds.extend([loc.lon, loc.lat]);
    this.map.fitBounds(bounds, { padding, maxZoom, duration });
  }

  flyToPoint(lon, lat, zoom = 3.2, duration = 2200) {
    this.map?.flyTo({ center: [lon, lat], zoom, duration, essential: true });
  }

  select(id, { fly = true } = {}) {
    const loc = this.byId.get(id);
    if (!loc || !this.map || !Number.isFinite(loc.lat)) return;
    if (this.selectedId && this.ready) this.map.setFeatureState({ source: SOURCE, id: this.selectedId }, { selected: false });
    this.selectedId = id;
    if (this.ready) this.map.setFeatureState({ source: SOURCE, id }, { selected: true });
    if (fly) this.map.flyTo({ center: [loc.lon, loc.lat], zoom: Math.max(this.map.getZoom(), 9), duration: 1400 });
    this.closePopup();
    this.popup = new maplibregl.Popup({ offset: 12, maxWidth: "320px" })
      .setLngLat([loc.lon, loc.lat]).setHTML(popupHtml(loc)).addTo(this.map);
    this.onSelect?.(loc);
  }

  closePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  // Giro lento del globo para las vistas en reposo.
  spin(degreesPerSecond = 3) {
    if (!this.map || this.spinning) return;
    this.spinning = true;
    let last = performance.now();
    const step = (now) => {
      if (!this.spinning) return;
      const dt = (now - last) / 1000;
      last = now;
      if (!this.map.isMoving() && this.ready) {
        const center = this.map.getCenter();
        this.map.setCenter([center.lng - degreesPerSecond * dt, center.lat]);
      }
      this.spinFrame = requestAnimationFrame(step);
    };
    this.spinFrame = requestAnimationFrame(step);
    const stop = () => this.stopSpin();
    this.map.once("mousedown", stop);
    this.map.once("touchstart", stop);
    this.map.once("wheel", stop);
  }

  stopSpin() {
    this.spinning = false;
    if (this.spinFrame) cancelAnimationFrame(this.spinFrame);
  }

  resize() {
    this.map?.resize();
  }
}
