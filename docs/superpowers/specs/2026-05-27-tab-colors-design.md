# Colores de pestañas por carpeta — Diseño

**Fecha:** 2026-05-27
**Estado:** Aprobado para planificar

## Objetivo

Dar a cada pestaña un color de fondo tintado. Por defecto el color se deriva
automáticamente de la carpeta asociada a la pestaña (misma carpeta → mismo
color, siempre). El usuario puede sobrescribir el color de una pestaña concreta
desde su menú contextual.

## Decisiones (acordadas con el usuario)

1. **Color por defecto: automático por hash de la ruta de la carpeta.** Sin
   configuración. Determinista: la misma ruta produce siempre el mismo matiz.
2. **Tratamiento visual: fondo tintado.** Suave en pestañas inactivas, más
   intenso en la activa. El texto mantiene los tokens del tema (sin tocar
   contraste).
3. **Override manual por pestaña.** Clic derecho → elegir color, o "Automático"
   para volver al derivado de la carpeta.
4. **Alcance: todas las pestañas con carpeta.** Terminal (`cwd`),
   editor/markdown (carpeta del archivo = `dirname(path)`), git-diff /
   git-history / git-commit-file (`repoRoot`). Las pestañas `preview` (url) no
   tienen carpeta → sin tinte (estilo actual).

## Modelo: representar el color como *matiz* (hue 0–360)

Se guarda **solo el hue** (un número), no un color RGB fijo. Tanto el automático
como el override son hues. Ventajas:

- El tinte se calcula con una única fórmula HSL para ambos casos.
- Activo vs inactivo = mismo hue, distinto alpha.
- Se adapta al tema sin almacenar variantes por tema.

`null`/`undefined` en una pestaña significa "usa el automático". Si tampoco hay
carpeta (preview), no hay tinte.

## Componentes

### 1. `src/modules/tabs/lib/tabColor.ts` (nuevo)

Módulo puro, sin dependencias de React. Una responsabilidad: resolver el matiz
de una pestaña.

```ts
/** Carpeta asociada a la pestaña, o null si no tiene (p. ej. preview). */
export function folderForTab(tab: Tab): string | null;
//  terminal        -> tab.cwd ?? null
//  editor|markdown -> dirname(tab.path)
//  git-*           -> tab.repoRoot
//  preview         -> null

/** Hash determinista de la ruta -> hue [0,360). */
export function hashHue(folder: string): number;

/** Matiz efectivo de la pestaña, o null si no debe tintarse.
 *  Override (tab.colorHue) tiene prioridad; si no, hash de la carpeta. */
export function resolveHue(tab: Tab): number | null;
//  tab.colorHue != null            -> tab.colorHue
//  folderForTab(tab) != null       -> hashHue(folder)
//  en otro caso                    -> null
```

`dirname` y `hashHue` son helpers locales del módulo. `hashHue` usa un hash
simple y estable (p. ej. variante de djb2/FNV) y reduce módulo 360.

**Pruebas (puras, fáciles):** `folderForTab` por cada kind; `hashHue`
determinista y bien distribuido en un rango de rutas; `resolveHue` con/sin
override y con/sin carpeta.

### 2. Tipos y estado — `src/modules/tabs/lib/useTabs.ts`

- Añadir `colorHue?: number | null` a **cada** variante de `Tab` (o a un tipo
  base común reusado por todas). Es ortogonal al `kind`, así que todas las
  variantes lo admiten, incluida `preview` (donde se ignora al renderizar).
- Añadir `colorHue?: number | null` a `TabPatch`.
- En `updateTab`, propagar `colorHue` en **todas** las ramas por kind
  (`...(patch.colorHue !== undefined && { colorHue: patch.colorHue })`).
  `null` se conserva tal cual (resetea a automático).

### 3. Render del tinte — `src/modules/tabs/TabBar.tsx`

Para cada pestaña se calcula `const hue = resolveHue(t);`.

Cuando `hue !== null`:

- Se fija como variable CSS inline en el trigger: `style={{ "--tab-h": hue }}`.
- El fondo se aplica con clases Tailwind de valor arbitrario, en dos niveles de
  alpha. **No** se incluyen las clases de fondo por defecto
  (`data-[state=active]:bg-accent`) para evitar que dos reglas compitan por el
  mismo estado; el className se compone condicionalmente:
  - inactiva: `bg-[hsl(var(--tab-h)_60%_55%_/_0.10)]`
  - activa: `data-[state=active]:bg-[hsl(var(--tab-h)_65%_55%_/_0.26)]`

Cuando `hue === null`: se mantiene exactamente el className actual
(`data-[state=active]:bg-accent`), sin variable inline.

Saturación/luminosidad fijas (60–65% / 55%) elegidas para funcionar de forma
razonable en tema claro y oscuro. (Refinamiento futuro posible: exponer S/L como
tokens del tema; fuera de alcance ahora.)

La celda de renombrado en línea (rama `editingId`) puede mantener su `bg-accent`
actual sin tintar: es un estado transitorio y breve.

### 4. Override manual — menú contextual en `TabBar.tsx`

Hoy el `ContextMenu` solo envuelve pestañas terminal. Cambios:

- Extender el menú contextual a **todas las pestañas que tengan carpeta**
  (`folderForTab(t) !== null`). Las terminal conservan además su "Rename" y
  "Close" actuales; los demás kinds obtienen al menos el submenú de color (y
  "Close" si procede según las reglas actuales de cierre).
- Añadir un grupo **"Color"**: ~8 muestras de hue equiespaciadas + una opción
  **"Automático"**.
  - Elegir muestra → `onSetColor(t.id, hue)` → `updateTab(id, { colorHue: hue })`.
  - "Automático" → `onSetColor(t.id, null)` → `updateTab(id, { colorHue: null })`.
- Cada muestra es un pequeño swatch redondo coloreado con la misma fórmula HSL
  (alpha alto para que se vea sólido en el menú). La activa se marca.

Se añade un prop `onSetColor: (id: number, hue: number | null) => void` a
`TabBar`, conectado en el contenedor (App / Header) a `updateTab`.

### 5. Persistencia — `src/modules/workspace/lib/workspaceStore.ts`

Sin cambios de código. `serializeWorkspace` conserva los objetos `Tab`
completos (filtra por kind y por `private`, no por lista de campos), así que
`colorHue` se persiste y rehidrata automáticamente en `terax-workspace.json`.
El override sobrevive a reinicios para los kinds restaurables; los kinds
transitorios (git-diff, git-commit-file) no se persisten igual que hoy, lo cual
es aceptable: al reabrirse recuperan el automático.

## Flujo de datos

```
Tab (cwd/path/repoRoot, colorHue?)
        │
        ▼
resolveHue(tab)  ──► null ──► className actual (bg-accent)
        │
        └─ number ─► style="--tab-h:<hue>" + clases bg-[hsl(...)]  (inactiva / activa)

clic derecho → "Color" → onSetColor(id, hue|null) → updateTab → setTabs
        │
        ▼
scheduleWorkspaceSave (debounce 200ms) → terax-workspace.json
```

## Errores y casos límite

- **Terminal sin `cwd`** (aún no resuelto): `folderForTab` devuelve null → sin
  tinte hasta que llega el primer OSC 7; entonces aparece. Aceptable.
- **`path` sin separador** en editor/markdown: `dirname` cae a la propia cadena;
  igual produce un hue estable. Sin crash.
- **Preview con override**: `resolveHue` devuelve el override si existe, pero el
  menú de color no se ofrece a preview (no tiene carpeta), así que en la práctica
  preview nunca tendrá `colorHue`. Si llegara a tenerlo (datos viejos), se
  tintaría; inofensivo.
- **Hash colisión** (dos carpetas distintas, mismo hue): aceptable; es estético,
  no funcional.

## Pruebas

- Unitarias del módulo `tabColor.ts` (ver §1).
- Verificación manual en la app: abrir terminales en carpetas distintas → colores
  distintos; misma carpeta → mismo color; activar/desactivar → cambia intensidad;
  override por menú → persiste tras recargar; "Automático" → vuelve al hash.

## Fuera de alcance (YAGNI)

- Override por carpeta compartido entre pestañas (se eligió override por pestaña).
- Tokens de tema para S/L del tinte.
- Color en pestañas preview.
- Paleta configurable por el usuario.
```