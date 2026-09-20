// Capa de movimiento: revelados al hacer scroll, contadores, escenas ligadas al scroll,
// parallax y foco que sigue al puntero. Sin dependencias: IntersectionObserver + rAF.
// Todo respeta `prefers-reduced-motion`: con movimiento reducido el contenido aparece ya colocado.

export const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------- revelados al entrar en pantalla ---------------- */

// Marca `is-in` en cada `[data-reveal]` cuando entra en pantalla. El retardo escalonado lo
// calcula el propio grupo: `[data-reveal-group]` numera a sus hijos en la variable `--i`.
export function initReveal(root = document) {
  // Le dice a la red de seguridad del `<head>` que el módulo sí ha llegado.
  document.documentElement.dataset.motion = "on";
  // Es idempotente: lo ya revelado no se vuelve a observar, así se puede llamar otra vez
  // cuando se inyecta contenido nuevo sin duplicar observadores sobre lo viejo.
  const items = [...root.querySelectorAll("[data-reveal]:not(.is-in)")];
  if (!items.length) return;

  for (const group of root.querySelectorAll("[data-reveal-group]")) {
    [...group.children].forEach((child, i) => child.style.setProperty("--i", String(i)));
  }

  if (reduced) {
    for (const item of items) item.classList.add("is-in");
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-in");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });

  for (const item of items) observer.observe(item);
}

/* ---------------- contadores ---------------- */

const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

// Anima hasta `text` conservando prefijos, sufijos y el formato de miles y decimales
// del texto final (`14.433`, `0,14 US$`, `100 %`). Si no hay número, lo escribe tal cual.
export function countTo(el, text, { duration = 1100 } = {}) {
  const value = String(text);
  const match = value.match(/-?[\d.,]*\d/);
  // En una pestaña en segundo plano el navegador suspende `requestAnimationFrame`, así que
  // la cuenta no llegaría a escribir nada y el número se quedaría en su marcador. Ahí se
  // escribe el valor directamente: la animación no la ve nadie, pero el dato tiene que estar.
  if (reduced || document.hidden || !match || !el.isConnected) { el.textContent = value; return; }

  const raw = match[0];
  const target = Number(raw.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(target)) { el.textContent = value; return; }

  const decimals = (raw.split(",")[1] || "").length;
  const format = new Intl.NumberFormat("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const before = value.slice(0, match.index);
  const after = value.slice(match.index + raw.length);

  el.style.fontVariantNumeric = "tabular-nums";
  cancelAnimationFrame(el.dataset.countFrame || 0);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = `${before}${format.format(target * easeOutExpo(t))}${after}`;
    if (t < 1) el.dataset.countFrame = requestAnimationFrame(step);
    else el.textContent = value;
  };
  el.dataset.countFrame = requestAnimationFrame(step);
}

// Lanza el contador la primera vez que el elemento entra en pantalla. Hasta entonces deja
// lo que ya hubiera escrito: si lo vaciara, un valor fijado mientras el elemento está fuera
// de pantalla lo dejaría en blanco hasta que alguien se desplazara hasta él.
const pendingCount = new WeakMap();

const inViewport = (el) => {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.bottom > 0 && rect.top < (window.innerHeight || 0);
};

export function countOnView(el, text, options) {
  if (reduced || el.dataset.counted) { el.textContent = text; return; }
  // Un valor nuevo antes de contar sustituye al anterior: solo se anima el último.
  pendingCount.get(el)?.disconnect();
  // Lo que ya está en pantalla cuenta ahora, sin pasar por el observador: así las cifras
  // de cabecera aparecen aunque el navegador retrase o no dispare la intersección.
  if (inViewport(el)) {
    pendingCount.delete(el);
    el.dataset.counted = "on";
    countTo(el, text, options);
    return;
  }
  const observer = new IntersectionObserver((entries, obs) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    obs.disconnect();
    pendingCount.delete(el);
    el.dataset.counted = "on";
    countTo(el, text, options);
  }, { threshold: 0.2 });
  pendingCount.set(el, observer);
  observer.observe(el);
}

/* ---------------- escenas ligadas al scroll ---------------- */

// Llama a `onProgress(p)` con p ∈ [0, 1] según avanza `element` por la ventana.
// `from`/`to` son fracciones de la altura de la ventana medidas sobre el borde superior
// del elemento: por defecto, de cuando su parte alta toca el borde inferior a cuando lo abandona.
export function scrollScene(element, onProgress, { from = 1, to = -1 } = {}) {
  if (!element) return () => {};
  let frame = 0;
  let last = -1;

  const measure = () => {
    frame = 0;
    const rect = element.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    const span = (from - to) * vh + rect.height;
    const travelled = from * vh - rect.top;
    const p = Math.min(1, Math.max(0, travelled / (span || 1)));
    if (Math.abs(p - last) < 0.001) return;
    last = p;
    onProgress(p, rect);
  };

  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  measure();
  return () => {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
  };
}

/* ---------------- barra de progreso de lectura ---------------- */

export function initScrollProgress(bar) {
  if (!bar) return;
  let frame = 0;
  const update = () => {
    frame = 0;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  update();
}

/* ---------------- parallax ---------------- */

// Desplaza `[data-parallax]` una fracción de su recorrido por la ventana. El valor del
// atributo es la intensidad en píxeles del recorrido total (negativo = sube más despacio).
export function initParallax(root = document) {
  const items = [...root.querySelectorAll("[data-parallax]")];
  if (!items.length || reduced) return;
  let frame = 0;
  const update = () => {
    frame = 0;
    const vh = window.innerHeight || 1;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom < -vh || rect.top > vh * 2) continue;
      const centre = (rect.top + rect.height / 2 - vh / 2) / vh;
      item.style.setProperty("--parallax", `${centre * Number(item.dataset.parallax || 40)}px`);
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  update();
}

/* ---------------- foco que sigue al puntero ---------------- */

// Publica la posición del puntero dentro de cada `[data-spotlight]` en `--mx`/`--my`
// para que el CSS dibuje el halo. Un solo listener delegado para toda la página.
export function initSpotlight(root = document) {
  if (reduced || !window.matchMedia("(hover: hover)").matches) return;
  root.addEventListener("pointermove", (event) => {
    const card = event.target.closest?.("[data-spotlight]");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    card.style.setProperty("--my", `${event.clientY - rect.top}px`);
  }, { passive: true });
}

/* ---------------- navegación que sigue a la sección visible ---------------- */

export function initSectionNav(links) {
  const targets = [...links].map((link) => {
    const id = link.getAttribute("href")?.slice(1);
    return id ? { link, section: document.getElementById(id) } : null;
  }).filter((entry) => entry?.section);
  if (!targets.length) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const match = targets.find((t) => t.section === entry.target);
      if (match) match.visible = entry.isIntersecting && entry.intersectionRatio > 0.12;
    }
    const current = targets.find((t) => t.visible);
    for (const t of targets) t.link.classList.toggle("is-current", t === current);
  }, { threshold: [0, 0.12, 0.5], rootMargin: "-25% 0px -50% 0px" });

  for (const t of targets) observer.observe(t.section);
}
