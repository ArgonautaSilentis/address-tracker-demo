"""Convierte las ejecuciones del flujo V4 en los datos que consume la web.

Hay dos tipos de empresa:

- Flujo completo: las nueve tareas, el resumen de costes y la vista maestra
  (`csv_exports/all_locations_master.csv`) de una misma ejecución.
- Flujo con conectores sectoriales: las tareas del flujo que existen para la
  empresa, más los datasets que aportan los conectores (GEM Wiki, webs oficiales,
  red de recarga, registro de entidades del grupo). Esas ejecuciones no guardaron
  resumen de costes, así que no se muestran tokens ni coste.

Escribe `public/data/index.json` (resumen de cada empresa) y
`public/data/cases/<empresa>.json` (detalle con todas las localizaciones).

Uso:
    python3 scripts/build_data.py [ruta/a/V4/outputs]
"""

from __future__ import annotations

import csv
import json
import os
import re
import sys
import unicodedata
from collections import Counter
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUTPUTS = os.path.expanduser(
    "~/Library/CloudStorage/OneDrive-NTTDATAEMEAL/Documentos/Optimized_flujo_PoC_SAN/V4/outputs")

# (slug, ejecución del flujo, ejecución de la que tomar el plan si falta, conectores)
CASES = [
    ("airbus", "20260413_104810_Airbus", None, None),
    ("aceitera-general-deheza", "20260413_123311_Aceitera_General_Deheza", None, None),
    ("unilever", "20260413_102236_Unilever", None, None),
    ("ikea", "20260504_135137_Ikea", None, None),
    ("john-cockerill", "20260413_111328_John_Cockerill_Netherland", None, None),
    ("iberdrola", "20260324_114759_Iberdrola", "20260409_171137_Iberdrola", "iberdrola"),
    ("glencore", "20260409_171633_Glencore", None, "glencore"),
]

PIPELINE = [
    {"task": "plan_source_strategy", "agent": "Source Strategy Planner", "stage": "plan",
     "label": "Planificación de fuentes", "tools": []},
    {"task": "research_company_profile", "agent": "Company Profile Researcher", "stage": "extract",
     "label": "Perfil corporativo", "tools": ["SerperDevTool", "SafeWebsiteContentTool"]},
    {"task": "hunt_all_company_assets", "agent": "Physical Assets Intelligence Hunter", "stage": "extract",
     "label": "Activos físicos", "tools": ["SerperDevTool", "AssetSearchQueryPlannerTool", "SafeWebsiteContentTool",
                                          "GEMWikiSearchTool", "OpenSupplyHubSearchTool",
                                          "ScrapegraphSmartScraperTool"]},
    {"task": "map_all_global_offices", "agent": "Global Offices Mapper", "stage": "extract",
     "label": "Oficinas corporativas", "tools": ["SerperDevTool", "SafeWebsiteContentTool"]},
    {"task": "map_operational_entities", "agent": "Operational Entities Mapper", "stage": "extract",
     "label": "Entidades operativas", "tools": ["SerperDevTool", "SafeWebsiteContentTool"]},
    {"task": "discover_brand_locations", "agent": "Brand Locations Discovery Specialist", "stage": "extract",
     "label": "Localizaciones de marca", "tools": ["SerperDevTool", "SafeWebsiteContentTool",
                                                  "BrandLocationDiscoveryTool"]},
    {"task": "enrich_physical_assets", "agent": "Physical Assets Enrichment Specialist", "stage": "consolidate",
     "label": "Enriquecimiento de activos", "tools": ["SerperDevTool", "AssetSearchQueryPlannerTool",
                                                     "SafeWebsiteContentTool", "BrandLocationDiscoveryTool",
                                                     "GEMWikiSearchTool", "OpenSupplyHubSearchTool",
                                                     "ScrapegraphSmartScraperTool"]},
    {"task": "geocode_all_locations", "agent": "Location Geocoder", "stage": "consolidate",
     "label": "Geocodificación", "tools": ["PlacesGeocodingTool", "OSMGeocodingTool"]},
    {"task": "export_consolidated_data", "agent": "Data Export Specialist", "stage": "consolidate",
     "label": "Consolidación y exportación", "tools": []},
]

LAYER_BY_SUFFIX = [
    ("_physical_assets", "assets"), ("_global_offices", "offices"), ("_operational_entities", "entities"),
    ("_brand_locations_discovered", "brand"), ("_geocoded_locations", "other"),
]
STEP_BY_LAYER = {"assets": "hunt_all_company_assets", "offices": "map_all_global_offices",
                 "entities": "map_operational_entities", "brand": "discover_brand_locations",
                 "other": "geocode_all_locations"}

SECTORS = {"manufacturing/industrial": "Industria y manufactura", "retail": "Retail",
           "utilities/energy": "Utilities y energía", "consumer goods": "Gran consumo", "agribusiness": "Agroindustria"}
CONFIDENCE = {"high": "alta", "medium": "media", "low": "baja"}
CONNECTORS = {"official_website": "Web oficial", "official website": "Web oficial", "gem": "GEM Wiki",
              "google places": "Google Places", "open supply hub": "Open Supply Hub",
              "advanced_scraping": "Scraping avanzado", "advanced scraping": "Scraping avanzado"}

# Tipos de fuente con los que se agrupan las URLs que citan los agentes. Solo se clasifican fuentes que aparecen
# en las salidas de la ejecución: la web no inventa ninguna.
SOURCE_KINDS = ["Web oficial", "Google Places", "GEM Wiki", "Open Supply Hub", "Wikipedia", "Registro público",
                "Web de terceros", "Dataset del grupo"]
NAME_STOPWORDS = {"inter", "holding", "group", "grupo", "general", "company", "netherland", "netherlands", "john",
                  "international", "sociedad", "limited"}
STRATEGY_NEEDS = (("corporate_profile_strategy", "Perfil corporativo"), ("physical_assets_strategy", "Activos físicos"),
                  ("visible_locations_strategy", "Localizaciones visibles"))
STATUS = {"active": "Operativo", "operational": "Operativo", "operating": "Operativo", "open": "Operativo",
          "in operation": "Operativo", "construction": "En construcción", "under construction": "En construcción",
          "planned": "Planificado", "announced": "Anunciado", "closed": "Cerrado", "inactive": "Inactivo",
          "cancelled": "Cancelado", "shelved": "Paralizado", "retired": "Retirado", "partial": "Parcial",
          "mothballed": "En reserva"}
COUNTRIES_ES = {"Spain": "España", "United States": "EE. UU.", "United Kingdom": "Reino Unido", "Brazil": "Brasil",
                "Mexico": "México", "Australia": "Australia", "Switzerland": "Suiza", "Canada": "Canadá",
                "Bermuda": "Bermudas", "South Africa": "Sudáfrica", "British Virgin Islands": "Islas Vírgenes Británicas",
                "Singapore": "Singapur", "Colombia": "Colombia", "Peru": "Perú", "Chile": "Chile",
                "Portugal": "Portugal", "Germany": "Alemania", "France": "Francia", "Italy": "Italia",
                "Netherlands": "Países Bajos", "Hungary": "Hungría", "Belgium": "Bélgica", "China": "China",
                "India": "India"}


# --------------------------------------------------------------------------- utilidades

def load(run, task):
    path = os.path.join(run, task + ".json")
    if not os.path.exists(path):
        return None
    data = json.load(open(path, encoding="utf-8"))
    parsed = data.get("parsed_json")
    if parsed is None:
        raw = data.get("raw_output") or ""
        match = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
        try:
            parsed = json.loads(match.group(1) if match else raw)
        except (ValueError, AttributeError):
            parsed = None
    return parsed


def records(parsed):
    if isinstance(parsed, dict):
        if parsed.get("records"):
            return parsed["records"]
        lists = [v for k, v in parsed.items() if k.endswith("records") and isinstance(v, list)]
        return lists[0] if lists else []
    return parsed if isinstance(parsed, list) else []


def clean(value):
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in ("none", "null", "n/a", "not available", "nan") else text


def flat(value):
    if isinstance(value, (list, tuple)):
        return ", ".join(clean(v) for v in value if clean(v))
    return clean(value)


def key(text):
    text = unicodedata.normalize("NFKD", clean(text)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def number(n):
    return f"{n:,}".replace(",", ".")


def plural(n, one, many):
    return "%s %s" % (number(n), one if n == 1 else many)


def country_es(name):
    return COUNTRIES_ES.get(name, name)


def connector(name):
    low = clean(name).lower()
    if low in CONNECTORS:
        return CONNECTORS[low]
    for needle, label in (("official", "Web oficial"), ("gem", "GEM Wiki"), ("places", "Google Places"),
                          ("supply hub", "Open Supply Hub"), ("scrap", "Scraping avanzado"),
                          ("sector", "Datasets sectoriales"), ("search", "Búsqueda web"),
                          ("annual report", "Informes anuales"), ("report", "Informes sectoriales"),
                          ("publication", "Publicaciones sectoriales"), ("director", "Directorios de empresas"),
                          ("registr", "Registros mercantiles"), ("linkedin", "LinkedIn"), ("news", "Prensa")):
        if needle in low:
            return label
    return clean(name).replace("_", " ").capitalize()


def sector_label(raw):
    low = clean(raw).lower()
    for k, v in SECTORS.items():
        if k in low:
            return v
    return clean(raw).replace("/", " / ").capitalize()


def status_label(raw):
    return STATUS.get(clean(raw).lower(), "")


def place(city, country):
    return ", ".join(x for x in (clean(city), clean(country)) if x)


def to_float(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None


def compact(loc):
    """Quita los campos vacíos: con miles de puntos de recarga, el JSON adelgaza mucho."""
    return {k: v for k, v in loc.items() if v not in ("", None) or k in ("lat", "lon")}


def host(url):
    try:
        return urlparse(url).netloc.replace("www.", "")
    except ValueError:
        return ""


def official_hosts(profile, name):
    """Dominios de la propia empresa: sus webs oficiales y los que llevan su nombre."""
    hosts = {host(u) for u in (profile.get("official_websites") or []) if clean(u)}
    tokens = [w for w in key(name).split() if len(w) >= 4 and w not in NAME_STOPWORDS]
    return {h for h in hosts if h}, tokens


def source_kind(url, source_type, officials):
    hosts, tokens = officials
    h = host(url)
    kind = clean(source_type).lower()
    if "gem.wiki" in h or "globalenergymonitor" in h:
        return "GEM Wiki"
    if "opensupplyhub" in h:
        return "Open Supply Hub"
    if "places" in kind or h.startswith("maps.google") or "google.com/maps" in url:
        return "Google Places"
    if "wikipedia" in h:
        return "Wikipedia"
    compact_host = h.replace(".", "").replace("-", "")
    if h in hosts or any(h.endswith("." + o) for o in hosts) or any(t in compact_host for t in tokens) or "official" in kind:
        return "Web oficial"
    if h.endswith(".gov") or ".gov." in h or "regist" in kind:
        return "Registro público"
    return "Web de terceros"


def url_sources(recs, officials, url_fields=("source_url",), type_fields=("source_type", "discovery_source_system", "source_role")):
    """Una entrada por URL citada, con cuántos registros la citan, en orden de aparición."""
    groups = {}
    for rec in recs:
        url = next((clean(rec.get(f)) for f in url_fields if clean(rec.get(f))), "")
        if not url.lower().startswith("http"):
            continue
        kind_hint = next((clean(rec.get(f)) for f in type_fields if clean(rec.get(f))), "")
        item = groups.setdefault(url, {"url": url, "host": host(url), "kind": source_kind(url, kind_hint, officials), "records": 0})
        item["records"] += 1
    return sorted(groups.values(), key=lambda i: -i["records"])


def host_sources(locations, officials):
    """Para los conectores, con cientos de URLs: una entrada por dominio con una URL de ejemplo."""
    groups = {}
    for loc in locations:
        url = loc.get("sourceUrl") or ""
        if url.startswith("http"):
            item = groups.setdefault(host(url), {"url": url, "host": host(url), "kind": source_kind(url, "", officials),
                                                 "records": 0, "grouped": True})
            item["records"] += 1
        elif loc.get("source"):
            item = groups.setdefault(loc["source"], {"url": "", "host": "", "label": loc["source"],
                                                     "kind": "Dataset del grupo", "records": 0})
            item["records"] += 1
    return sorted(groups.values(), key=lambda i: -i["records"])


def geocoding_service(raw):
    low = clean(raw).lower()
    if "places" in low:
        return "Google Places"
    if "google" in low:
        return "Google Geocoding"
    if "osm" in low or "openstreetmap" in low or "nominatim" in low:
        return "OpenStreetMap"
    return clean(raw) or "Sin geocodificar"


def as_list(value):
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value if clean(v)]
    return [clean(value)] if clean(value) else []


def plan_strategy(plan):
    rows = []
    for field, need in STRATEGY_NEEDS:
        strategy = plan.get(field) or {}
        lead = strategy.get("lead_source") or strategy.get("primary_source")
        others = as_list(strategy.get("additional_sources")) + as_list(strategy.get("secondary_sources")) + as_list(
            strategy.get("secondary_source"))
        if lead or others:
            rows.append({"need": need, "lead": connector(lead) if lead else "", "others": [connector(o) for o in others],
                         "notes": clean(strategy.get("notes"))})
    fallback = plan.get("fallback_strategy") or {}
    if isinstance(fallback, dict):
        fallback_text = " ".join(clean(fallback.get(k)) for k in ("conditions", "notes", "strategy") if clean(fallback.get(k)))
    else:
        fallback_text = flat(fallback)
    return rows, fallback_text


def top(counter, n=5, translate=False):
    return " · ".join("%s %s" % (country_es(k) if translate else k, number(v)) for k, v in counter.most_common(n))


# --------------------------------------------------------------------------- tareas del flujo

def record_lines(recs, name_field, extra_fields, noun_one, noun_many, feminine=False, limit=7):
    verb = ("identificada" if len(recs) == 1 else "identificadas") if feminine else (
        "identificado" if len(recs) == 1 else "identificados")
    result = ["%s %s" % (plural(len(recs), noun_one, noun_many), verb)]
    for rec in recs[:limit]:
        city = rec.get("location_city") or rec.get("city")
        country = rec.get("location_country") or rec.get("country")
        extra = next((clean(rec.get(f)) for f in extra_fields if clean(rec.get(f))), "")
        result.append("%s · %s%s" % (clean(rec.get(name_field)), place(city, country) or "ubicación por confirmar",
                                     (" · " + extra) if extra else ""))
    if len(recs) > limit:
        result.append("… y %s más" % plural(len(recs) - limit, "registro", "registros"))
    return result


def flow_logs(out, plan, profile, name):
    logs = {}
    order = [connector(c) for c in plan.get("preferred_connector_order") or []]
    if plan:
        lines = ["Sector operativo: %s · confianza %s" % (sector_label(plan.get("workflow_sector")),
                                                           CONFIDENCE.get(clean(plan.get("confidence")).lower(),
                                                                          clean(plan.get("confidence"))))]
        if order:
            lines.append("Orden de conectores: " + " → ".join(order))
        for field, label in (("corporate_profile_strategy", "Perfil corporativo"),
                             ("physical_assets_strategy", "Activos físicos"),
                             ("visible_locations_strategy", "Localizaciones visibles")):
            strategy = plan.get(field) or {}
            lead = strategy.get("lead_source") or strategy.get("primary_source")
            if lead:
                lines.append("%s: lidera %s" % (label, connector(lead)))
        queries = (plan.get("recommended_brand_queries") or [])[:3]
        if queries:
            lines.append("Consultas de marca: " + " · ".join("«%s»" % q for q in queries))
        lines.append("Estrategia enviada al resto de agentes")
        logs["plan_source_strategy"] = lines

    ids = profile.get("public_company_identifiers") or {}
    codes = profile.get("economic_activity_codes") or {}
    lines = ["Razón social: " + name, "Sede: " + clean(profile.get("headquarters"))]
    lines.append("%s · %s · %s" % (plural(len(profile.get("brand_names") or []), "marca", "marcas"),
                                    plural(len(profile.get("major_subsidiaries") or []), "filial principal",
                                           "filiales principales"),
                                    plural(len(profile.get("countries_of_operation") or []), "país", "países")))
    ident = ["%s %s" % (k.replace("_", " "), flat(v)) for k, v in ids.items() if flat(v)]
    if ident:
        lines.append("Identificadores: " + " · ".join(ident[:3]))
    act = ["%s %s" % (k.replace("_", " "), flat(v)) for k, v in codes.items() if flat(v)]
    if act:
        lines.append("Actividad: " + " · ".join(act[:3]))
    lines.append("Perfil verificado contra %s" % plural(len(profile.get("source_urls") or []), "fuente", "fuentes"))
    logs["research_company_profile"] = lines

    logs["hunt_all_company_assets"] = record_lines(records(out["hunt_all_company_assets"]), "asset_name",
                                                   ["asset_type"], "activo físico", "activos físicos")
    logs["map_all_global_offices"] = record_lines(records(out["map_all_global_offices"]), "office_name",
                                                  ["office_type"], "oficina", "oficinas", feminine=True)
    logs["map_operational_entities"] = record_lines(records(out["map_operational_entities"]), "entity_name",
                                                    ["relationship_to_company", "entity_type"],
                                                    "entidad operativa", "entidades operativas", feminine=True)
    brand = records(out["discover_brand_locations"])
    lines = record_lines(brand, "location_name", ["location_type"], "localización visible",
                         "localizaciones visibles", feminine=True)
    systems = Counter(clean(r.get("discovery_source_system")) or "web" for r in brand)
    if systems:
        lines.insert(1, "Origen: " + top(systems, 3))
    logs["discover_brand_locations"] = lines

    hunted = len(records(out["hunt_all_company_assets"]))
    enriched = records(out["enrich_physical_assets"])
    lines = ["Inventario de activos: %d → %d registros" % (hunted, len(enriched))]
    statuses = Counter(clean(r.get("validation_status")) or "sin estado" for r in enriched)
    if statuses:
        lines.append("Validación: " + top(statuses, 3))
    for rec in enriched[:5]:
        lines.append("%s · %s" % (clean(rec.get("asset_name")), clean(rec.get("asset_subtype")) or clean(rec.get("asset_type"))))
    logs["enrich_physical_assets"] = lines

    geo = records(out["geocode_all_locations"])
    sources = Counter(clean(r.get("geocoding_source_system")) or clean(r.get("geocoding_source")) or "—" for r in geo)
    lines = ["%s procesados" % plural(len(geo), "registro", "registros").capitalize()]
    if sources:
        lines.append("Fuentes: " + top(sources, 3))
    for rec in geo[:5]:
        if to_float(rec.get("latitude")) is not None:
            lines.append("%s → %.4f, %.4f" % (clean(rec.get("source_record_name")), rec["latitude"], rec["longitude"]))
    logs["geocode_all_locations"] = lines
    return logs, order


def layer_details(out):
    details = {}
    for rec in records(out["enrich_physical_assets"]) or records(out["hunt_all_company_assets"]):
        details[("assets", key(rec.get("asset_name")))] = {
            "detail": clean(rec.get("technical_or_business_details")), "subtype": clean(rec.get("asset_subtype")),
            "sourceUrl": clean(rec.get("source_url")), "type": clean(rec.get("asset_type"))}
    for rec in records(out["map_all_global_offices"]):
        details[("offices", key(rec.get("office_name")))] = {
            "detail": clean(rec.get("operational_functions")), "sourceUrl": clean(rec.get("source_url")),
            "type": clean(rec.get("office_type"))}
    for rec in records(out["map_operational_entities"]):
        details[("entities", key(rec.get("entity_name")))] = {
            "detail": clean(rec.get("operational_role")), "relationship": clean(rec.get("relationship_to_company")),
            "sourceUrl": clean(rec.get("source_url")), "type": clean(rec.get("entity_type"))}
    for rec in records(out["discover_brand_locations"]):
        details[("brand", key(rec.get("location_name")))] = {
            "detail": clean(rec.get("discovery_notes")), "system": clean(rec.get("discovery_source_system")),
            "sourceUrl": clean(rec.get("source_url")), "type": clean(rec.get("location_type"))}
    return details


def flow_locations(run, out):
    """Localizaciones del flujo: la vista maestra si existe; si no, los registros geocodificados."""
    details = layer_details(out)
    geo = {key(r.get("source_record_name")): r for r in records(out["geocode_all_locations"])
           if to_float(r.get("latitude")) is not None}
    master_path = os.path.join(run, "csv_exports", "all_locations_master.csv")
    rows = []
    if os.path.exists(master_path):
        for row in csv.DictReader(open(master_path, encoding="utf-8-sig")):
            layer = next((lay for suffix, lay in LAYER_BY_SUFFIX if row["source_dataset"].endswith(suffix)), "other")
            rows.append({"layer": layer, "name": clean(row["name"]), "type": clean(row["type"]),
                         "address": clean(row["address"]), "city": clean(row["city"]), "region": clean(row["region"]),
                         "country": clean(row["country"]), "postalCode": clean(row["postal_code"]),
                         "lat": to_float(row["latitude"]), "lon": to_float(row["longitude"]),
                         "status": status_label(row["status"]),
                         "confidence": "" if clean(row["confidence"]).startswith("geocoded_") else clean(row["confidence"]),
                         "sourceUrl": clean(row["source_url"])})
    else:
        by_name = {}
        for (lay, name_key) in details:
            by_name.setdefault(name_key, lay)
        seen_geo = set()
        for rec in records(out["geocode_all_locations"]):
            dataset = clean(rec.get("source_dataset")).lower()
            name_key = key(rec.get("source_record_name"))
            if (name_key, rec.get("latitude")) in seen_geo:
                continue
            seen_geo.add((name_key, rec.get("latitude")))
            layer = by_name.get(name_key) or (
                "assets" if any(w in dataset for w in ("physical", "asset", "operation")) else
                "offices" if "office" in dataset else "entities" if "entit" in dataset else
                "brand" if "brand" in dataset else "other")
            rows.append({"layer": layer, "name": clean(rec.get("source_record_name")),
                         "address": clean(rec.get("normalized_address")), "city": clean(rec.get("city")),
                         "region": clean(rec.get("region")), "country": clean(rec.get("country")),
                         "postalCode": clean(rec.get("postal_code")), "lat": to_float(rec.get("latitude")),
                         "lon": to_float(rec.get("longitude"))})

    # Completa coordenadas con la salida del geocodificador y quita los duplicados que deja la capa «otras».
    for row in rows:
        if row["lat"] is None and key(row["name"]) in geo:
            g = geo[key(row["name"])]
            row["lat"], row["lon"] = to_float(g["latitude"]), to_float(g["longitude"])
    named = {key(r["name"]) for r in rows if r["layer"] != "other"}
    rows = [r for r in rows if not (r["layer"] == "other" and key(r["name"]) in named)]

    hunt_keys = {key(r.get("asset_name")) for r in records(out["hunt_all_company_assets"])}
    has_enrich = out["enrich_physical_assets"] is not None
    locations = []
    for row in rows:
        extra = details.get((row["layer"], key(row["name"])), {})
        for field in ("type", "sourceUrl"):
            if not row.get(field) and extra.get(field):
                row[field] = extra[field]
        step = STEP_BY_LAYER[row["layer"]]
        if row["layer"] == "assets" and has_enrich and key(row["name"]) not in hunt_keys:
            step = "enrich_physical_assets"
        locations.append({**row, "step": step,
                          **{k: v for k, v in extra.items() if k not in ("type", "sourceUrl") and v}})
    return locations


# --------------------------------------------------------------------------- conectores sectoriales

GROUP_OWNERS = ("iberdrola", "avangrid", "neoenergia", "scottish power", "scottishpower", "elektro", "coelba",
                "celpe", "cosern")
TECHNOLOGY = {"wind": "Parque eólico", "solar": "Planta solar", "hydro": "Central hidroeléctrica",
              "gas": "Central de gas", "coal": "Central de carbón", "battery": "Almacenamiento en baterías",
              "nuclear": "Central nuclear", "oil": "Central de fuel", "bioenergy": "Planta de bioenergía",
              "geothermal": "Central geotérmica"}
GLENCORE_TYPES = {"mine": "Mina", "power_station": "Central eléctrica", "terminal": "Terminal",
                  "pipeline": "Gasoducto u oleoducto", "oil_gas_field": "Yacimiento de petróleo y gas"}


def external_rows(outputs, run):
    path = os.path.join(outputs, "runs", run, "csv_exports", "all_locations_master.csv")
    return list(csv.DictReader(open(path, encoding="utf-8-sig")))


def connectors_iberdrola(outputs):
    rows = external_rows(outputs, "20260413_131000_Iberdrola_External_Assets")
    gem = {key(r["asset_name"]): r for r in csv.DictReader(open(
        os.path.join(outputs, "gem_exports", "iberdrola_productive_assets_with_gem_status.csv"), encoding="utf-8-sig"))}
    steps, locations = [], []

    # Activos productivos: GEM Wiki y proyectos emblemáticos de la web oficial.
    productive_all = [r for r in rows if r["type"] == "productive_asset"]
    productive = [r for r in productive_all if to_float(r["latitude"]) is not None]
    discarded = len(productive_all) - len(productive)
    owned = linked = 0
    techs, statuses = Counter(), Counter()
    for r in productive:
        g = gem.get(key(r["name"]), {})
        owner = clean(g.get("gem_owner"))
        official = "iberdrola.com" in r["source_url"]
        is_group = official or any(k in owner.lower() for k in GROUP_OWNERS)
        tech = clean(g.get("technology")).split(";")[0]
        status = status_label(g.get("gem_status"))
        techs[TECHNOLOGY.get(tech, "Otros")] += 1
        if status:
            statuses[status] += 1
        owned += is_group
        linked += not is_group
        capacity = to_float(g.get("capacity_mw"))
        locations.append({
            "layer": "assets" if is_group else "linked", "step": "connector_gem", "name": clean(r["name"]),
            "type": TECHNOLOGY.get(tech, "Activo productivo"), "country": clean(r["country"]),
            "lat": to_float(r["latitude"]), "lon": to_float(r["longitude"]), "status": status,
            "owner": owner or ("Iberdrola (web oficial)" if official else ""),
            "capacity": ("%s MW" % ("%g" % capacity).replace(".", ",")) if capacity else "",
            "sourceUrl": clean(r["source_url"]),
        })
    steps.append({
        "task": "connector_gem", "agent": "GEM Wiki connector", "stage": "connectors", "label": "Conector GEM Wiki",
        "tools": ["GEMWikiSearchTool"], "records": len(productive),
        "log": [
            "Búsqueda de activos productivos del grupo en GEM Wiki",
            "%s · %s de GEM Wiki y %s de la web oficial" % (
                plural(len(productive), "activo productivo", "activos productivos"),
                number(sum(1 for r in productive if "gem.wiki" in r["source_url"])),
                number(sum(1 for r in productive if "iberdrola.com" in r["source_url"]))),
            "Tecnologías: " + top(techs, 4),
            "Estado: " + top(statuses, 4),
            "Titularidad del grupo confirmada en %s activos" % number(owned),
            "%s con otro titular o sin titular: capa «Activos vinculados»" % number(linked),
            "%s sin coordenadas descartadas: empresas o artículos, no activos" % plural(discarded, "página", "páginas"),
        ],
    })

    offices = [r for r in rows if r["type"] in ("office", "corporate_headquarters", "foundation", "other_center")]
    office_types = {"office": "Oficina", "corporate_headquarters": "Sede corporativa", "foundation": "Fundación",
                    "other_center": "Otro centro"}
    for r in offices:
        locations.append({"layer": "offices", "step": "connector_offices", "name": clean(r["name"]),
                          "type": office_types[r["type"]], "address": clean(r["address"]), "country": clean(r["country"]),
                          "lat": to_float(r["latitude"]), "lon": to_float(r["longitude"]),
                          "sourceUrl": clean(r["source_url"])})
    countries = Counter(r["country"] for r in offices if r["country"])
    steps.append({
        "task": "connector_offices", "agent": "Official website connector", "stage": "connectors",
        "label": "Sedes y oficinas del grupo", "tools": ["SafeWebsiteContentTool", "OSMGeocodingTool"],
        "records": len(offices),
        "log": ["Directorio de oficinas del grupo en iberdrola.com",
                "%s en %s" % (plural(len(offices), "sede u oficina", "sedes y oficinas"), plural(len(countries), "país", "países")),
                "Países: " + top(countries, 5, translate=True),
                "Direcciones geocodificadas con OpenStreetMap"] +
               ["%s · %s" % (clean(r["name"]), country_es(clean(r["country"]))) for r in offices[:4]],
    })

    chargers = [r for r in rows if r["type"] == "charger"]
    active = [r for r in chargers if r["status"] != "BAJA"]
    for r in active:
        locations.append({"layer": "charging", "step": "connector_charging", "name": clean(r["name"]),
                          "type": "Punto de recarga", "address": clean(r["address"]), "region": clean(r["region"]).title(),
                          "country": clean(r["country"]), "lat": to_float(r["latitude"]), "lon": to_float(r["longitude"]),
                          "status": "Operativo" if r["status"] == "OPER" else clean(r["status"]),
                          "source": "Exportación de la red de recarga"})
    states = Counter(r["status"] for r in chargers)
    regions = Counter(clean(r["region"]).title() for r in active if r["region"])
    steps.append({
        "task": "connector_charging", "agent": "Charging network connector", "stage": "connectors",
        "label": "Red de puntos de recarga", "tools": ["Exportación de la red de recarga"], "records": len(active),
        "log": ["Exportación de la red de puntos de recarga del grupo",
                "%s leídos · %s operativos · %s en estado EC_APR" % (
                    number(len(chargers)), number(states["OPER"]), number(states["EC_APR"])),
                "%s de baja excluidos del inventario" % plural(states["BAJA"], "punto", "puntos"),
                "Provincias con más puntos: " + top(regions, 5),
                "%s incorporados al mapa" % plural(len(active), "punto de recarga", "puntos de recarga")],
    })
    return steps, locations


def connectors_glencore(outputs):
    rows = external_rows(outputs, "20260413_132000_Glencore_External_Assets")
    steps, locations = [], []
    entities = [r for r in rows if r["type"] == "office"]
    for r in entities:
        locations.append({"layer": "entities", "step": "connector_entities", "name": clean(r["name"]),
                          "type": "Entidad del grupo", "address": clean(r["address"]), "country": clean(r["country"]),
                          "lat": to_float(r["latitude"]), "lon": to_float(r["longitude"]),
                          "sourceUrl": clean(r["source_url"])})
    countries = Counter(r["country"] for r in entities if r["country"])
    addresses = Counter(re.sub(r"^(Level|Suite|Floor)\s+\w+,\s*", "", clean(r["address"])) for r in entities if r["address"])
    busiest, busiest_n = addresses.most_common(1)[0]
    steps.append({
        "task": "connector_entities", "agent": "Group entities connector", "stage": "connectors",
        "label": "Entidades del grupo", "tools": ["SafeWebsiteContentTool", "OSMGeocodingTool"],
        "records": len(entities),
        "log": ["Listado de entidades del grupo publicado en glencore.com",
                "%s con domicilio registrado en %s" % (plural(len(entities), "entidad", "entidades"),
                                                        plural(len(countries), "jurisdicción", "jurisdicciones")),
                "Jurisdicciones: " + top(countries, 6, translate=True),
                "Domicilio más repetido: %s entidades en %s" % (number(busiest_n), busiest),
                "Domicilios geocodificados con OpenStreetMap"],
    })

    assets = [r for r in rows if r["type"] in GLENCORE_TYPES]
    for r in assets:
        locations.append({"layer": "assets", "step": "connector_gem", "name": clean(r["name"]),
                          "type": GLENCORE_TYPES[r["type"]], "country": clean(r["country"]),
                          "lat": to_float(r["latitude"]), "lon": to_float(r["longitude"]),
                          "sourceUrl": clean(r["source_url"])})
    kinds = Counter(GLENCORE_TYPES[r["type"]] for r in assets)
    steps.append({
        "task": "connector_gem", "agent": "GEM Wiki connector", "stage": "connectors", "label": "Conector GEM Wiki",
        "tools": ["GEMWikiSearchTool"], "records": len(assets),
        "log": ["Activos vinculados a Glencore en GEM Wiki",
                "%s: %s" % (plural(len(assets), "activo", "activos"), top(kinds, 5)),
                "Países: " + top(Counter(r["country"] for r in assets if r["country"]), 5, translate=True)] +
               ["%s · %s · %s" % (clean(r["name"]), GLENCORE_TYPES[r["type"]], country_es(clean(r["country"]))) for r in assets[:4]],
    })
    return steps, locations


CONNECTOR_BUILDERS = {"iberdrola": connectors_iberdrola, "glencore": connectors_glencore}


# --------------------------------------------------------------------------- empresa

def build_case(slug, run_id, plan_run, connectors_key, outputs):
    runs = os.path.join(outputs, "runs")
    run = os.path.join(runs, run_id)
    out = {task["task"]: load(run, task["task"]) for task in PIPELINE}
    export = out["export_consolidated_data"] or {}
    datasets = export.get("datasets", export) if isinstance(export, dict) else {}

    plan = out["plan_source_strategy"]
    if plan is None and plan_run:
        plan = load(os.path.join(runs, plan_run), "plan_source_strategy")
        out["plan_source_strategy"] = plan
    plan = plan or {}
    profile = out["research_company_profile"]
    if not isinstance(profile, dict):
        profile = next((v for k, v in datasets.items() if k.endswith("_company_profile") and isinstance(v, dict)), {})

    cost_path = os.path.join(run, "cost_summary.json")
    cost = json.load(open(cost_path, encoding="utf-8")) if os.path.exists(cost_path) else None
    cost_by_agent = {a["agent_name"]: a for a in cost["by_agent"]} if cost else {}

    name = clean(profile.get("canonical_company_name")) or run_id.split("_", 2)[2].replace("_", " ")
    logs, order = flow_logs(out, plan, profile, name)
    locations = flow_locations(run, out)
    officials = official_hosts(profile, name)
    task_sources = {task: url_sources(records(out[task]), officials) for task in (
        "hunt_all_company_assets", "map_all_global_offices", "map_operational_entities", "discover_brand_locations",
        "enrich_physical_assets")}
    task_sources["research_company_profile"] = [
        {"url": u, "host": host(u), "kind": source_kind(u, "", officials), "records": 1}
        for u in dict.fromkeys(clean(u) for u in (profile.get("source_urls") or [])) if u.startswith("http")]
    geocoded = records(out["geocode_all_locations"])
    services = Counter(geocoding_service(r.get("geocoding_source_system") or r.get("geocoding_source")) for r in geocoded)

    connector_steps = []
    if connectors_key:
        connector_steps, connector_locations = CONNECTOR_BUILDERS[connectors_key](outputs)
        seen = {key(loc["name"]) for loc in connector_locations}
        locations = [loc for loc in locations if key(loc["name"]) not in seen] + connector_locations

    locations = [compact({"id": "%s-%05d" % (slug, index + 1), **loc}) for index, loc in enumerate(locations)]

    with_coords = sum(1 for loc in locations if loc["lat"] is not None)
    with_source = sum(1 for loc in locations if loc.get("sourceUrl") or loc.get("source"))
    countries = {loc["country"] for loc in locations if loc.get("country")}
    sources = {host(loc["sourceUrl"]) for loc in locations if loc.get("sourceUrl")}
    logs["export_consolidated_data"] = [
        "Deduplicación y normalización de %s" % plural(len(locations), "localización", "localizaciones"),
        "Vista maestra: %s registros · %s con coordenadas" % (number(len(locations)), number(with_coords)),
        "%s registros con fuente trazable · %s" % (number(with_source), plural(len(sources), "dominio web", "dominios web")),
        "Capas: perfil corporativo y %s" % plural(len({loc["layer"] for loc in locations}), "capa de localizaciones",
                                                  "capas de localizaciones"),
        "Exportación JSON y CSV lista",
    ]

    step_counts = Counter(loc["step"] for loc in locations)
    agents = []
    for step in PIPELINE:
        # Un paso existe si la tarea dejó su fichero, aunque su salida no fuese JSON válido (perfil de IKEA).
        ran = os.path.exists(os.path.join(run, step["task"] + ".json")) or (
            step["task"] == "plan_source_strategy" and bool(plan))
        if not ran:
            continue
        if step["task"] == "export_consolidated_data":
            for connector_step in connector_steps:
                step_locations = [loc for loc in locations if loc["step"] == connector_step["task"]]
                agents.append({**connector_step, "kind": "connector", "model": "", "requests": 0, "tokens": 0,
                               "costUsd": 0, "mapped": step_counts.get(connector_step["task"], 0),
                               "sources": host_sources(step_locations, officials)})
        metrics = cost_by_agent.get(step["agent"], {})
        if step["task"] == "export_consolidated_data":
            task_records = len(locations)
        elif step["task"] in ("plan_source_strategy", "research_company_profile"):
            task_records = 1
        else:
            task_records = len(records(out[step["task"]]))
        extra = {}
        if step["task"] in task_sources:
            extra["sources"] = task_sources[step["task"]]
        elif step["task"] == "geocode_all_locations":
            extra["services"] = [{"name": k, "records": v} for k, v in services.most_common()]
        elif step["task"] == "plan_source_strategy":
            extra["strategy"], extra["fallback"] = plan_strategy(plan)
        agents.append({**step, "kind": "agent", "model": metrics.get("model", "gpt-4o-mini"),
                       "requests": metrics.get("successful_requests", 0), "tokens": metrics.get("total_tokens", 0),
                       "costUsd": metrics.get("estimated_cost_usd", 0), "records": task_records,
                       "log": logs[step["task"]], "mapped": step_counts.get(step["task"], 0), **extra})

    # Resumen de fuentes: lo que planificó el primer agente frente a lo que citan de verdad las salidas.
    cited = Counter()
    domains = {}
    for agent in agents:
        for item in agent.get("sources", []):
            cited[item["kind"]] += item["records"]
            if not item.get("host"):
                continue
            row = domains.setdefault(item["host"], {"host": item["host"], "url": item["url"], "kinds": [], "agents": [],
                                                    "cited": 0, "records": 0})
            row["cited"] += item["records"]
            if item["kind"] not in row["kinds"]:
                row["kinds"].append(item["kind"])
            if agent["label"] not in row["agents"]:
                row["agents"].append(agent["label"])
    for loc in locations:
        h = host(loc.get("sourceUrl") or "")
        if h in domains:
            domains[h]["records"] += 1
        elif h:
            domains[h] = {"host": h, "url": loc["sourceUrl"], "kinds": [source_kind(loc["sourceUrl"], "", officials)],
                          "agents": [], "cited": 0, "records": 1}
    planned = []
    for name_ in order:
        if name_ == "Scraping avanzado":
            status = "reserve"
        elif name_ in SOURCE_KINDS:
            status = "used" if cited[name_] else "empty"
        else:
            status = "untraced"
        planned.append({"name": name_, "status": status, "cited": cited.get(name_, 0)})
    source_summary = {
        "planned": planned,
        "unplanned": [{"kind": k, "cited": cited[k]} for k in SOURCE_KINDS if cited[k] and k not in order],
        "kinds": [{"kind": k, "cited": cited[k]} for k in SOURCE_KINDS if cited[k]],
        "domains": sorted(domains.values(), key=lambda d: (-d["records"], -d["cited"], d["host"])),
        "geocoding": [{"name": k, "records": v} for k, v in services.most_common()],
        "withoutSource": sum(1 for loc in locations if not (loc.get("sourceUrl") or loc.get("source"))),
    }

    layer_counts = Counter(loc["layer"] for loc in locations)
    summary = {
        "slug": slug, "name": name, "runDate": "%s-%s-%s" % (run_id[:4], run_id[4:6], run_id[6:8]),
        "sector": sector_label(plan.get("workflow_sector")), "headquarters": clean(profile.get("headquarters")),
        "brands": len(profile.get("brand_names") or []), "parent": clean(profile.get("parent_company")),
        "hasCost": cost is not None, "hasConnectors": bool(connector_steps),
        "totals": {
            "locations": len(locations), "withCoordinates": with_coords, "withSource": with_source,
            "countries": len(countries), "sources": len(sources), "layers": dict(layer_counts),
            "connectorRecords": sum(s["records"] for s in connector_steps), "steps": len(agents),
            "requests": cost["total"]["successful_requests"] if cost else None,
            "tokens": cost["total"]["total_tokens"] if cost else None,
            "costUsd": cost["total"]["estimated_cost_usd"] if cost else None,
        },
    }
    detail = {
        **summary,
        "plan": {
            "sector": sector_label(plan.get("workflow_sector")),
            "confidence": CONFIDENCE.get(clean(plan.get("confidence")).lower(), clean(plan.get("confidence"))),
            "notes": clean(plan.get("company_handling_notes")), "connectors": order,
            "brandQueries": plan.get("recommended_brand_queries") or [],
            "subsidiaryQueries": plan.get("recommended_subsidiary_queries") or [],
        },
        "profile": {
            "canonicalName": name, "parent": clean(profile.get("parent_company")),
            "headquarters": clean(profile.get("headquarters")), "brands": profile.get("brand_names") or [],
            "subsidiaries": profile.get("major_subsidiaries") or [], "websites": profile.get("official_websites") or [],
            "countries": profile.get("countries_of_operation") or [],
            "identifiers": {k.replace("_", " "): flat(v) for k, v in (profile.get("public_company_identifiers") or {}).items() if flat(v)},
            "activityCodes": {k.replace("_", " "): flat(v) for k, v in (profile.get("economic_activity_codes") or {}).items() if flat(v)},
            "summary": clean(profile.get("sector_summary")), "sources": profile.get("source_urls") or [],
        },
        "sourceSummary": source_summary,
        "agents": agents,
        "locations": locations,
    }
    return summary, detail


def main():
    outputs = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUTPUTS
    cases_dir = os.path.join(ROOT, "public", "data", "cases")
    os.makedirs(cases_dir, exist_ok=True)
    index = []
    for slug, run_id, plan_run, connectors_key in CASES:
        summary, detail = build_case(slug, run_id, plan_run, connectors_key, outputs)
        index.append(summary)
        path = os.path.join(cases_dir, slug + ".json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(detail, handle, ensure_ascii=False, separators=(",", ":"))
        t = summary["totals"]
        print("%-30s %6s localizaciones · %6s con coordenadas · %3d países · %s · %d KB" % (
            summary["name"], number(t["locations"]), number(t["withCoordinates"]), t["countries"], t["layers"],
            os.path.getsize(path) // 1024))
    with open(os.path.join(ROOT, "public", "data", "index.json"), "w", encoding="utf-8") as handle:
        json.dump({"cases": index}, handle, ensure_ascii=False, separators=(",", ":"))
    legacy = os.path.join(ROOT, "public", "data", "cases.json")
    if os.path.exists(legacy):
        os.remove(legacy)


if __name__ == "__main__":
    main()
