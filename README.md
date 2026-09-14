# Address Tracker · Huella corporativa geolocalizada

Portada y mesa de análisis del flujo multiagente que reconstruye la huella corporativa, operativa y geográfica de una empresa a partir de su nombre.

- `/`: portada con el reto, la arquitectura de nueve agentes, las capas de salida, un explorador de resultados sobre el mapa y los casos de uso.
- `/demo`: mesa de análisis. Se elige una empresa, se ejecuta el flujo y las localizaciones aparecen en el mapa a medida que cada agente termina. Incluye inventario filtrable, perfil corporativo, estrategia de fuentes y exportación a CSV y JSON.

## Estructura

```
public/
  index.html, demo.html     páginas
  assets/                   estilos, módulo del mapa y lógica de cada página
  data/index.json           resumen de cada empresa (bandeja y portada)
  data/cases/<empresa>.json detalle: pasos del flujo, perfil, estrategia y localizaciones
  vendor/                   MapLibre GL JS (UMD, BSD-3)
scripts/
  build_data.py             genera public/data desde las salidas del flujo V4
  serve.mjs                 servidor estático local con las mismas URLs que Vercel
test/data.test.mjs          integridad de los datos
```

Sitio estático, sin dependencias ni paso de build. La cartografía usa los estilos vectoriales de [OpenFreeMap](https://openfreemap.org) (sin clave).

## Uso local

```bash
npm run dev      # http://127.0.0.1:8795
npm test
```

## Regenerar los datos

`scripts/build_data.py` lee `V4/outputs`. Las empresas y sus ejecuciones están en la lista `CASES` del script.

- **Flujo completo** (Airbus, Aceitera General Deheza, Unilever, IKEA, John Cockerill): salidas de las tareas, `cost_summary.json` y la vista maestra `csv_exports/all_locations_master.csv`.
- **Flujo con conectores sectoriales** (Iberdrola, Glencore): las tareas del flujo disponibles más los datasets de `runs/*_External_Assets` y `gem_exports`. Esas ejecuciones no guardaron costes, así que la mesa muestra registros y fuentes en lugar de tokens.

Criterios de consolidación: los registros de la capa «otras» que repiten un nombre de otra capa se eliminan; las coordenadas que faltan en la vista maestra se completan con la salida del geocodificador; en Iberdrola, los activos de GEM Wiki con otro titular o sin titular van a la capa «Activos vinculados», las páginas de GEM sin coordenadas se descartan y los puntos de recarga de baja no se incluyen.

```bash
npm run data                                   # ruta por defecto en OneDrive
python3 scripts/build_data.py /ruta/a/V4/outputs
```

## Despliegue en Vercel

1. Crear un repositorio en GitHub y subir este directorio.
2. En Vercel, «Add New… → Project», importar el repositorio. No hace falta configurar nada: `vercel.json` fija `public` como directorio de salida y URLs limpias (`/demo`).
