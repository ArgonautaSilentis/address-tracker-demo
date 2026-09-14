"""Convierte las ejecuciones del flujo V4 en los datos que consume la web.

Lee, por cada empresa, las salidas de las nueve tareas, el resumen de costes y la
vista maestra de localizaciones (`csv_exports/all_locations_master.csv`), y
escribe `public/data/cases.json`.

Uso:
    python3 scripts/build_data.py [ruta/a/V4/outputs/runs]
"""

from __future__ import annotations

import csv
import json
import os
import re
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_RUNS = os.path.expanduser(
    "~/Library/CloudStorage/OneDrive-NTTDATAEMEAL/Documentos/Optimized_flujo_PoC_SAN/V4/outputs/runs")

CASES = [
    ("airbus", "20260413_104810_Airbus"),
    ("aceitera-general-deheza", "20260413_123311_Aceitera_General_Deheza"),
    ("unilever", "20260413_102236_Unilever"),
    ("ikea", "20260504_135137_Ikea"),
]

# Orden de ejecución del flujo secuencial (crew.py) y su presentación.
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
     "label": "Geocodificación", "tools": ["OSMGeocodingTool"]},
    {"task": "export_consolidated_data", "agent": "Data Export Specialist", "stage": "consolidate",
     "label": "Consolidación y exportación", "tools": []},
]

LAYER_BY_SUFFIX = [
    ("_physical_assets", "assets"),
    ("_global_offices", "offices"),
    ("_operational_entities", "entities"),
    ("_brand_locations_discovered", "brand"),
    ("_geocoded_locations", "other"),
]

SECTORS = {
    "manufacturing/industrial": "Industria y manufactura",
    "retail": "Retail",
    "utilities/energy": "Utilities y energía",
    "consumer goods": "Gran consumo",
    "agribusiness": "Agroindustria",
}
CONFIDENCE = {"high": "alta", "medium": "media", "low": "baja"}
CONNECTORS = {
    "official_website": "Web oficial", "official website": "Web oficial", "official websites": "Web oficial",
    "gem": "GEM Wiki", "google places": "Google Places", "open supply hub": "Open Supply Hub",
    "advanced_scraping": "Scraping avanzado", "advanced scraping": "Scraping avanzado",
    "serper": "Búsqueda web", "web_search": "Búsqueda web", "web search": "Búsqueda web",
}


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
        return parsed.get("records") or []
    if isinstance(parsed, list):
        return parsed
    return []


def clean(value):
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in ("none", "null", "n/a", "not available", "nan") else text


def key(text):
    text = unicodedata.normalize("NFKD", clean(text)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def connector(name):
    low = clean(name).lower()
    if low in CONNECTORS:
        return CONNECTORS[low]
    for needle, label in (("official", "Web oficial"), ("gem", "GEM Wiki"), ("places", "Google Places"),
                          ("supply hub", "Open Supply Hub"), ("scrap", "Scraping avanzado"),
                          ("sector", "Datasets sectoriales"), ("search", "Búsqueda web")):
        if needle in low:
            return label
    return clean(name).replace("_", " ").capitalize()


def sector_label(raw):
    low = clean(raw).lower()
    for k, v in SECTORS.items():
        if k in low:
            return v
    return clean(raw).replace("/", " / ").capitalize()


def plural(n, one, many):
    return "%d %s" % (n, one if n == 1 else many)


def flat(value):
    if isinstance(value, (list, tuple)):
        return ", ".join(clean(v) for v in value if clean(v))
    return clean(value)


STATUS = {"active": "Operativo", "operational": "Operativo", "operating": "Operativo", "open": "Operativo",
          "in operation": "Operativo", "construction": "En construcción", "under construction": "En construcción",
          "planned": "Planificado", "announced": "Anunciado", "closed": "Cerrado", "inactive": "Inactivo"}


def status_label(raw):
    # Solo estados operativos reconocibles: la columna de origen mezcla estados de geocodificación y relaciones.
    return STATUS.get(clean(raw).lower(), "")


def place(city, country):
    return ", ".join(x for x in (clean(city), clean(country)) if x)


def build_case(slug, run_id, runs_dir):
    run = os.path.join(runs_dir, run_id)
    out = {task["task"]: load(run, task["task"]) for task in PIPELINE}
    export = out["export_consolidated_data"] or {}
    datasets = export.get("datasets", export) if isinstance(export, dict) else {}

    plan = out["plan_source_strategy"] or {}
    profile = out["research_company_profile"]
    if not isinstance(profile, dict):
        profile = next((v for k, v in datasets.items() if k.endswith("_company_profile") and isinstance(v, dict)), {})

    cost = json.load(open(os.path.join(run, "cost_summary.json"), encoding="utf-8"))
    cost_by_agent = {a["agent_name"]: a for a in cost["by_agent"]}

    # Vista maestra deduplicada, con la capa de origen y la fuente de cada registro.
    master = list(csv.DictReader(open(os.path.join(run, "csv_exports", "all_locations_master.csv"),
                                      encoding="utf-8-sig")))
    details = {}
    for rec in records(out["enrich_physical_assets"]) or records(out["hunt_all_company_assets"]):
        details[("assets", key(rec.get("asset_name")))] = {
            "detail": clean(rec.get("technical_or_business_details")), "subtype": clean(rec.get("asset_subtype")),
            "validation": clean(rec.get("validation_status"))}
    for rec in records(out["map_all_global_offices"]):
        details[("offices", key(rec.get("office_name")))] = {
            "detail": clean(rec.get("operational_functions")), "scope": clean(rec.get("regional_scope")),
            "website": clean(rec.get("website"))}
    for rec in records(out["map_operational_entities"]):
        details[("entities", key(rec.get("entity_name")))] = {
            "detail": clean(rec.get("operational_role")), "relationship": clean(rec.get("relationship_to_company")),
            "website": clean(rec.get("website"))}
    for rec in records(out["discover_brand_locations"]):
        details[("brand", key(rec.get("location_name")))] = {
            "detail": clean(rec.get("discovery_notes")), "system": clean(rec.get("discovery_source_system")),
            "agreement": clean(rec.get("source_agreement_status"))}

    locations = []
    for index, row in enumerate(master):
        layer = next((lay for suffix, lay in LAYER_BY_SUFFIX if row["source_dataset"].endswith(suffix)), "other")
        try:
            lat, lon = float(row["latitude"]), float(row["longitude"])
        except ValueError:
            lat = lon = None
        extra = details.get((layer, key(row["name"])), {})
        locations.append({
            "id": "%s-%02d" % (slug, index + 1), "layer": layer, "name": clean(row["name"]),
            "type": clean(row["type"]), "address": clean(row["address"]), "city": clean(row["city"]),
            "region": clean(row["region"]), "country": clean(row["country"]), "postalCode": clean(row["postal_code"]),
            "lat": lat, "lon": lon, "status": status_label(row["status"]),
            "confidence": "" if clean(row["confidence"]).startswith("geocoded_") else clean(row["confidence"]),
            "sourceUrl": clean(row["source_url"]), **{k: v for k, v in extra.items() if v},
        })

    # Registros que produce cada tarea, para ir apareciendo en el mapa según avanza el flujo.
    reveal = {"hunt_all_company_assets": [], "map_all_global_offices": [], "map_operational_entities": [],
              "discover_brand_locations": [], "enrich_physical_assets": [], "geocode_all_locations": []}
    hunt_keys = {key(r.get("asset_name")) for r in records(out["hunt_all_company_assets"])}
    for loc in locations:
        if loc["layer"] == "assets":
            target = "hunt_all_company_assets" if key(loc["name"]) in hunt_keys else "enrich_physical_assets"
        else:
            target = {"offices": "map_all_global_offices", "entities": "map_operational_entities",
                      "brand": "discover_brand_locations", "other": "geocode_all_locations"}[loc["layer"]]
        reveal[target].append(loc["id"])
    if not reveal["hunt_all_company_assets"] and reveal["enrich_physical_assets"]:
        half = max(1, len(reveal["enrich_physical_assets"]) // 2)
        reveal["hunt_all_company_assets"] = reveal["enrich_physical_assets"][:half]
        reveal["enrich_physical_assets"] = reveal["enrich_physical_assets"][half:]

    # Registro de actividad de cada agente, construido a partir de su salida.
    name = clean(profile.get("canonical_company_name")) or run_id.split("_", 2)[2].replace("_", " ")
    logs = {}
    order = [connector(c) for c in plan.get("preferred_connector_order") or []]
    lines = ["Sector operativo: %s · confianza %s" % (sector_label(plan.get("workflow_sector")),
                                                       CONFIDENCE.get(clean(plan.get("confidence")).lower(),
                                                                      clean(plan.get("confidence"))))]
    if order:
        lines.append("Orden de conectores: " + " → ".join(order))
    for field, label in (("corporate_profile_strategy", "Perfil corporativo"), ("physical_assets_strategy", "Activos físicos"),
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
                                    plural(len(profile.get("major_subsidiaries") or []), "filial principal", "filiales principales"),
                                    plural(len(profile.get("countries_of_operation") or []), "país", "países")))
    ident = [("%s %s" % (k.replace("_", " "), flat(v))) for k, v in ids.items() if flat(v)]
    if ident:
        lines.append("Identificadores: " + " · ".join(ident[:3]))
    act = [("%s %s" % (k.replace("_", " "), flat(v))) for k, v in codes.items() if flat(v)]
    if act:
        lines.append("Actividad: " + " · ".join(act[:3]))
    lines.append("Perfil verificado contra %s" % plural(len(profile.get("source_urls") or []), "fuente", "fuentes"))
    logs["research_company_profile"] = lines

    def record_lines(task, name_field, extra_fields, noun_one, noun_many, feminine=False):
        recs = records(out[task])
        verb = ("identificada" if len(recs) == 1 else "identificadas") if feminine else (
            "identificado" if len(recs) == 1 else "identificados")
        result = ["%s %s" % (plural(len(recs), noun_one, noun_many), verb)]
        for rec in recs[:7]:
            city = rec.get("location_city") or rec.get("city")
            country = rec.get("location_country") or rec.get("country")
            extra = next((clean(rec.get(f)) for f in extra_fields if clean(rec.get(f))), "")
            result.append("%s · %s%s" % (clean(rec.get(name_field)), place(city, country) or "ubicación por confirmar",
                                         (" · " + extra) if extra else ""))
        if len(recs) > 7:
            result.append("… y %s más" % plural(len(recs) - 7, "registro", "registros"))
        return result

    logs["hunt_all_company_assets"] = record_lines("hunt_all_company_assets", "asset_name", ["asset_type"],
                                                   "activo físico", "activos físicos")
    logs["map_all_global_offices"] = record_lines("map_all_global_offices", "office_name", ["office_type"],
                                                  "oficina", "oficinas", feminine=True)
    logs["map_operational_entities"] = record_lines("map_operational_entities", "entity_name",
                                                    ["relationship_to_company", "entity_type"],
                                                    "entidad operativa", "entidades operativas", feminine=True)
    brand = records(out["discover_brand_locations"])
    systems = {}
    for rec in brand:
        system = clean(rec.get("discovery_source_system")) or "web"
        systems[system] = systems.get(system, 0) + 1
    lines = record_lines("discover_brand_locations", "location_name", ["location_type"],
                         "localización visible", "localizaciones visibles", feminine=True)
    if systems:
        lines.insert(1, "Origen: " + " · ".join("%s %d" % (k, v) for k, v in sorted(systems.items(), key=lambda x: -x[1])))
    logs["discover_brand_locations"] = lines
    hunted = len(records(out["hunt_all_company_assets"]))
    enriched = records(out["enrich_physical_assets"])
    lines = ["Inventario de activos: %d → %d registros" % (hunted, len(enriched))]
    statuses = {}
    for rec in enriched:
        s = clean(rec.get("validation_status")) or "sin estado"
        statuses[s] = statuses.get(s, 0) + 1
    if statuses:
        lines.append("Validación: " + " · ".join("%s %d" % (k, v) for k, v in statuses.items()))
    for rec in enriched[:5]:
        lines.append("%s · %s" % (clean(rec.get("asset_name")), clean(rec.get("asset_subtype")) or clean(rec.get("asset_type"))))
    logs["enrich_physical_assets"] = lines
    geo = records(out["geocode_all_locations"])
    ok = [r for r in geo if clean(r.get("geocoding_status")).lower() in ("success", "geocoded", "ok", "succeeded", "already_geocoded", "preserved")]
    sources = {}
    for rec in geo:
        s = clean(rec.get("geocoding_source_system")) or clean(rec.get("geocoding_source")) or "—"
        sources[s] = sources.get(s, 0) + 1
    lines = ["%s procesados" % plural(len(geo), "registro", "registros").capitalize()]
    if sources:
        lines.append("Fuentes: " + " · ".join("%s %d" % (k, v) for k, v in sorted(sources.items(), key=lambda x: -x[1])[:3]))
    for rec in geo[:5]:
        if rec.get("latitude") is not None:
            lines.append("%s → %.4f, %.4f" % (clean(rec.get("source_record_name")), rec["latitude"], rec["longitude"]))
    logs["geocode_all_locations"] = lines
    with_coords = sum(1 for loc in locations if loc["lat"] is not None)
    with_source = sum(1 for loc in locations if loc["sourceUrl"])
    logs["export_consolidated_data"] = [
        "Deduplicación y normalización de %s" % plural(len(locations), "localización", "localizaciones"),
        "Vista maestra: %d registros · %d con coordenadas" % (len(locations), with_coords),
        "%d registros con URL de fuente" % with_source,
        "Capas: perfil, activos, oficinas, entidades, marca y geocodificación",
        "Exportación JSON y CSV lista",
    ]

    agents = []
    for step in PIPELINE:
        metrics = cost_by_agent.get(step["agent"], {})
        agents.append({**step, "model": metrics.get("model", "gpt-4o-mini"),
                       "requests": metrics.get("successful_requests", 0), "tokens": metrics.get("total_tokens", 0),
                       "costUsd": metrics.get("estimated_cost_usd", 0), "log": logs[step["task"]],
                       "reveals": reveal.get(step["task"], [])})

    layer_counts = {}
    for loc in locations:
        layer_counts[loc["layer"]] = layer_counts.get(loc["layer"], 0) + 1
    countries = sorted({loc["country"] for loc in locations if loc["country"]})

    return {
        "slug": slug, "name": name, "runDate": "%s-%s-%s" % (run_id[:4], run_id[4:6], run_id[6:8]),
        "sector": sector_label(plan.get("workflow_sector")), "sectorRaw": clean(plan.get("workflow_sector")),
        "headquarters": clean(profile.get("headquarters")),
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
            "identifiers": {k.replace("_", " "): flat(v) for k, v in ids.items() if flat(v)},
            "activityCodes": {k.replace("_", " "): flat(v) for k, v in codes.items() if flat(v)},
            "summary": clean(profile.get("sector_summary")), "sources": profile.get("source_urls") or [],
        },
        "agents": agents,
        "locations": locations,
        "totals": {
            "locations": len(locations), "withCoordinates": with_coords, "withSource": with_source,
            "countries": len(countries), "layers": layer_counts,
            "requests": cost["total"]["successful_requests"], "tokens": cost["total"]["total_tokens"],
            "costUsd": cost["total"]["estimated_cost_usd"],
        },
    }


def main():
    runs_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_RUNS
    cases = [build_case(slug, run_id, runs_dir) for slug, run_id in CASES]
    path = os.path.join(ROOT, "public", "data", "cases.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"cases": cases}, handle, ensure_ascii=False, separators=(",", ":"))
    for case in cases:
        t = case["totals"]
        print("%-26s %3d localizaciones · %d con coordenadas · %d países · %s" % (
            case["name"], t["locations"], t["withCoordinates"], t["countries"], t["layers"]))
    print("Escrito:", path, "(%d KB)" % (os.path.getsize(path) // 1024))


if __name__ == "__main__":
    main()
