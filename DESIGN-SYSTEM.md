# WILD FRONTIER — Design System

Status: Phase 1 (planning). These are the visual and interaction rules for every UI surface. They implement PRD §16 (UI/UX), §7 (controls), and §20 (polish). Tokens defined here become CSS custom properties in `src/styles/main.css`.

## 1. Principles

1. **Wilderness, not dashboard.** The palette is dark and earthy (charred wood, moss, slate, ember). The UI should look like something carved, inked, or stitched, not like a SaaS admin panel.
2. **The world is the hero.** The HUD is minimal and sits at the edges, and it fades when nothing changes. Full panels appear only when the player asks for them.
3. **Every control is real.** No decorative buttons. If an action is unavailable, it is visibly disabled and says why (tooltip/subtext), or it is hidden. Example: Continue is hidden when no valid save exists.
4. **Touch first.** Every target is at least 44×44 CSS px (game action buttons 56–64 px). Layout is verified at 360–430 px wide in portrait and landscape.
5. **Cheap to render.** Only `opacity` and `transform` are animated. `backdrop-filter` is used on at most one large surface at a time, and never on Low preset or on the HUD (PRD: avoid excessive glassmorphism; protects Android FPS).

## 2. Colour tokens

### 2.1 Base surfaces

| Token | Value | Use |
|---|---|---|
| `--c-ink-900` | `#0d0f0c` | Deepest background (menus, death screen) |
| `--c-ink-800` | `#151a15` | Panel base |
| `--c-ink-700` | `#1e251e` | Raised panel / slot |
| `--c-ink-600` | `#2a332a` | Hover/selected slot base |
| `--c-line` | `rgba(226, 214, 186, 0.14)` | Hairline borders, dividers |
| `--c-line-strong` | `rgba(226, 214, 186, 0.28)` | Focus/selected outline base |
| `--c-panel` | `rgba(16, 20, 16, 0.86)` | Translucent panel (opaque enough for legibility; no blur needed) |
| `--c-scrim` | `rgba(6, 8, 6, 0.6)` | Behind modals |

### 2.2 Text

| Token | Value | Contrast on `--c-ink-800` |
|---|---|---|
| `--c-text` | `#ece4d0` (bone parchment) | ≥ 12:1 |
| `--c-text-dim` | `#b4ab95` | ≥ 7:1 |
| `--c-text-faint` | `#7f786a` | ≥ 4.5:1 (only for secondary labels, never body text) |

### 2.3 Accents

| Token | Value | Meaning |
|---|---|---|
| `--c-ember` | `#e08a3c` | Primary accent: primary buttons, focus, selection, logo glow |
| `--c-ember-strong` | `#f4a65a` | Hover/active state of ember |
| `--c-moss` | `#8fae5a` | Success, valid placement, "+resource" toasts |
| `--c-danger` | `#d9573f` | Danger, invalid placement, damage |
| `--c-river` | `#5fa3b8` | Water/thirst, map water |
| `--c-frost` | `#9cc6e0` | Cold |
| `--c-gold` | `#d8b45a` | Discovery, rare items |

### 2.4 Stat colours

Stats are always paired with a distinct **icon** (colour-blind safe; colour is never the only signal).

| Stat | Colour | Icon |
|---|---|---|
| Health | `#d9573f` | Heart |
| Hunger | `#d39a4a` | Drumstick/berry |
| Thirst | `#5fa3b8` | Droplet |
| Stamina | `#c9c26a` | Lightning-leaf |
| Temperature | Gradient `--c-frost` → `#ece4d0` → `--c-ember`, with a needle marker | Thermometer |

Low-stat warning: when a stat drops below 25%, its icon pulses at 1 Hz with opacity 1 ↔ 0.55 (transform-free, cheap). Below 10%, a subtle vignette tint shows at the screen edge in that stat's colour, at max 0.25 opacity. It is disabled when Reduce Motion is on, and the pulse becomes a static outline.

## 3. Typography

No web-font download is needed, so the game works offline with zero font assets.

| Token | Stack | Use |
|---|---|---|
| `--f-display` | `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Noto Serif", serif` | Logo fallback, screen titles, discovery banners |
| `--f-ui` | `system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif` | All UI text |
| `--f-mono` | `ui-monospace, "Roboto Mono", Menlo, monospace` | Diagnostics overlay only |

Type scale (`clamp` keeps phones legible without overflowing landscape height):

| Token | Size | Weight / style | Use |
|---|---|---|---|
| `--t-hero` | `clamp(2.2rem, 7vmin, 4.2rem)` | 600, letter-spacing 0.18em, uppercase | Logo wordmark |
| `--t-title` | `clamp(1.25rem, 4vmin, 1.75rem)` | 600 display | Panel titles |
| `--t-body` | `0.95rem` | 400 | Descriptions |
| `--t-label` | `0.8rem` | 600, letter-spacing 0.08em, uppercase | Button labels, section headers |
| `--t-micro` | `0.7rem` | 500 | Stack counts, key hints (never below 11px) |

**Logo.** "WILD FRONTIER" is an original inline SVG: a wordmark with wide tracking plus a simple mark (pine silhouette over a mountain ridge inside a thin compass ring) in `--c-text` with an ember sunrise line. Being SVG, it scales crisply and needs no file request.

## 4. Spacing, radius, elevation, layering

- Spacing scale (`--s-*`): 4, 8, 12, 16, 24, 32, 48 px.
- Radius: `--r-sm 4px` (slots, chips), `--r-md 8px` (buttons, panels), `--r-pill 999px` (toggles, stat pills). Corners stay modest; no bubbly UI.
- Borders: 1 px `--c-line`. Selected/focused elements use a 2 px `--c-ember` inner outline + soft outer glow `0 0 0 3px rgba(224,138,60,0.25)`.
- Elevation: one shadow token, `--shadow-panel: 0 8px 24px rgba(0,0,0,0.45)`. HUD elements use a text/drop shadow `0 1px 2px rgba(0,0,0,0.8)` instead of backgrounds where possible.
- Texture: panels have a 1 px top highlight `inset 0 1px 0 rgba(255,240,210,0.06)` to suggest a worn, carved edge. No image textures.
- Z-layers: `canvas 0` → `hud 10` → `touch-controls 20` → `toasts 30` → `panels 40` → `modal 50` → `error-overlay 90`.

## 5. Motion

| Token | Value | Use |
|---|---|---|
| `--m-fast` | 120 ms | Button press, hover |
| `--m-base` | 200 ms | Panel fade/slide, tab switch |
| `--m-slow` | 320 ms | Screen transitions, discovery banner |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Entrances |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Exits |

- Panels: fade + 8 px translateY. Toasts: slide in from the left edge plus fade, stacked (max 4 visible; extra ones merge, e.g. "+3 Wood" becomes "+6 Wood").
- Screen transitions: fade through `--c-ink-900` (also hides chunk/world loading).
- Button press: scale(0.96) on `:active`.
- **Reduce Motion** setting (defaults to `prefers-reduced-motion`): removes translate/scale, keeps short fades, and also reduces camera-shake/head-bob in game.

## 6. Iconography

- Original inline SVG set (`ui/Icons.ts`) on a 24×24 grid with 1.75 px strokes and rounded joins. Single colour `currentColor` with an optional fill accent. Hand-drawn feel: slightly irregular silhouettes, no emoji, no icon fonts.
- Required icons:
  - Stats: health, hunger, thirst, stamina, temperature
  - Resources: wood, stone, fiber, berries, water
  - Items: wooden axe, stone pickaxe, stone knife, torch, campfire, shelter, water flask, bandage
  - UI: inventory, crafting, map, pause, settings, close, rotate, confirm, cancel, jump, sprint, crouch, interact (hand), marker, compass, save, sound, warning
- Item slot icons: 36 px inside a 52 px slot, in a per-category tint (resources bone, tools ember, consumables moss, placeables gold).

## 7. Components

Each component lists states. All interactive components support `:hover` (pointer devices only, via `@media (hover:hover)`), `:active`, `:focus-visible` (ember outline), and `[disabled]` (40% opacity, `cursor:not-allowed`, explanation text where useful).

### 7.1 Buttons

| Variant | Look | Use |
|---|---|---|
| Primary | Ember fill gradient `#e08a3c → #c46f2a`, `--c-ink-900` text, `--t-label` | New Game, Craft, Confirm |
| Secondary | Transparent, `--c-line-strong` border, `--c-text` | Settings, Cancel |
| Ghost / icon | Icon only, 44 px hit area, `aria-label` required | Close, map zoom |
| Danger | `--c-danger` border/text; fills on confirm | Delete save, Quit |

- Min height 44 px (menu buttons 52 px), horizontal padding 20 px.
- Menu buttons also show the keyboard hint on desktop (e.g. `[Esc]`).

### 7.2 Panels

`--c-panel` background, `--r-md`, 1 px `--c-line` border, `--shadow-panel`. Header row: title (`--t-title`) + close button. Panels sit centred and are max 920×600 px. On small screens they go full-bleed, respecting `env(safe-area-inset-*)`.

### 7.3 Inventory slot grid

- 52 px square slots, 6 columns in landscape (24 slots = 4 rows). Portrait narrow: 5 columns, scrollable.
- Stack count bottom-right (`--t-micro`, text-shadow). Durability bar for tools: 3 px, bottom edge.
- States: empty (dim outline), filled, selected (ember outline), invalid drop (danger outline).
- The selected item detail pane shows icon, name, description, stats, and action buttons (Use/Eat/Drink, Equip, Place, Drop). Only the actions valid for that item appear.
- Interaction: tap to select, tap an action button to act. Drag to rearrange/move into quick slots works with mouse and touch; tap-tap move is also available, so drag is never required.

### 7.4 Crafting list

- Left: recipe list with icon + name + "can craft" indicator (moss dot when you have all materials; dim when missing).
- Right: required materials, each showing `have / need` (danger-coloured when short). The Craft button is disabled with the text "Missing: 2 Stone" until requirements are met, or "Inventory full" when there is no output space. Pressing Craft plays the craft sound, adds a toast, and updates counts immediately.

### 7.5 HUD

- **Stats cluster** (bottom-left landscape, above the joystick zone on touch; top-left in portrait): 5 compact horizontal bars (icon + 72 px bar, 6 px tall, rounded) using stat colours. Temperature uses the gradient bar with a needle. The cluster fades to 55% opacity after 4 s of no change and returns to full on change or warning.
- **Compass** (top centre): 280 px strip (220 px on phones). Shows N/E/S/W letters, 15° ticks, POI and marker glyphs, and heading in degrees. It is a translated strip (`transform`), not re-rendered.
- **Interaction prompt** (centre-low): key hint chip (`E`, or a hand icon on touch) + verb + target ("Chop Pine", "Drink Water", "Search Crate"), plus a radial progress ring for multi-hit actions.
- **Toasts** (left, middle): resource gains, item crafted, inventory full, tool broke.
- **Discovery banner** (top centre, under the compass): display font, gold hairlines left/right, "DISCOVERED — Silver Lake", 3 s.
- **Time/weather chip** (top right, small): sun/moon icon + weather icon. It is informational and therefore not a button.
- **Save indicator**: small save icon that pulses briefly during an autosave, next to the time chip.
- **Build-mode bar**: replaces the prompt. It shows the validity reason (moss "Valid" / danger "Too steep") and Rotate / Place / Cancel buttons (touch) or key hints (desktop).

### 7.6 Touch controls (PRD §7)

| Control | Spec |
|---|---|
| Joystick | Floating; base 120 px circle (`--c-line-strong` ring, 15% fill) + 52 px knob (`--c-text` at 70%). Appears under the thumb within the left 40% of the screen; idle hint ring at the bottom-left when unused |
| Camera zone | Right 60% (outside buttons); invisible. A one-time first-run hint, "Swipe to look", shows briefly |
| Action buttons | Right side arc: Jump 64 px (primary, lowest-right), Interact 60 px (above Jump; disabled/dim until an interactable is in range; shows target icon), Sprint 56 px (toggle, ember fill when active), Crouch 56 px (toggle, ember fill when active), Inventory 52 px. All circles: `--c-ink-800` at 70%, 1.5 px `--c-line-strong` border, icon `--c-text` |
| Top-right | Map, Pause icon buttons (44 px) |

- Pressed: scale 0.92 + brighter border; optional haptic via `navigator.vibrate(10)` when supported and enabled.
- Layout uses `env(safe-area-inset-*)` and `vmin`-based sizing, and adapts to screen size (PRD §7). Settings offers a **Button size** option (S/M/L) and **Left-handed** mirroring.
- Portrait: buttons stack in a tighter 2×3 grid bottom-right; joystick zone is the bottom-left 50%; stats move to the top.

### 7.7 Map

Full-screen panel. The canvas map is hand-drawn-styled: hillshade in muted greens/ochres, water `--c-river`, forest stippling, contour lines every 40 m, and fog-of-war as a parchment-dark overlay. Controls: zoom +/− buttons, a recentre button, and a "Markers" toggle. Tapping the map places a marker; tapping a marker removes it, after a confirm chip. Legend at the bottom-left.

### 7.8 Form controls (Settings)

- Slider: 44 px tall hit area, 4 px track, 20 px thumb, value shown on the right.
- Toggle: 52×30 pill.
- Segmented control for presets (Low / Medium / High / Ultra) and FPS cap.
- Tabs: Graphics, Controls, Audio, Gameplay, Accessibility.
- Changes apply live where safe. Changing the preset applies on the next frame and shows a short "Applied" chip. Every setting control changes something real; there are no placeholder options.

### 7.9 Dialogs

Centred modal with scrim, title, body, and 1–2 buttons. Used for save confirmation ("Game saved" / error), overwrite/quit confirmations, damaged save, IndexedDB unavailable, and the death screen ("You collapsed" + cause + penalty + Respawn / Main Menu).

### 7.10 Main menu (PRD §16)

- Background: the live 3D world renders behind the menu. A slow cinematic camera orbits a fixed scenic spot of the seeded world at golden hour. On Low it renders at reduced resolution, and pausing the orbit is allowed.
- Logo top-left/centre. Vertical button stack: **New Game**, **Continue** (only when a valid save exists; subtext "Day 4 · 2h 13m"), **Settings**, **Credits**.
- Credits screen: authorship, "All art and audio procedurally generated", three.js MIT notice. It has a working Back button.
- Before the first gesture, a "Tap to begin" overlay is shown. It unlocks audio, then reveals the menu.

## 8. Layout and breakpoints

| Context | Rule |
|---|---|
| Landscape phone (primary, e.g. 800×360 to 930×430) | HUD at the edges, panels full-height with a 2-column layout (grid + detail) |
| Portrait phone (360–430 wide) | Panels become a single column with the detail pane as a bottom sheet; HUD stats at the top; touch buttons in a compact grid |
| Tablet / desktop (≥ 1024 wide) | Panels centred at max width; key hints visible; touch UI hidden unless touch is used |
| Short height (≤ 380 px) | Tighter vertical spacing (`--s-*` scaled 0.75), compass narrower, toasts limited to 3 |

- Use `100dvh` (with a `100vh` fallback) and `env(safe-area-inset-*)`, and handle notches on both sides in landscape.
- Global: `html, body { overscroll-behavior: none; }`; game root `touch-action: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;`. Panels with scrollable lists use `touch-action: pan-y` locally.

## 9. In-world feedback (3D side of the design system)

| Event | Feedback |
|---|---|
| Interactable highlight | Subtle rim/emissive lift (+15%) on the targeted object; no outline post-process |
| Gather hit | Small particle burst (chips/dust/leaves, ≤ 12 particles, pooled), tiny camera nudge (0.05 m, off with Reduce Motion), sound |
| Damage | Red edge vignette flash 200 ms + low thump |
| Build preview | Semi-transparent ghost (opacity 0.5), moss tint when valid, danger tint when invalid, footprint ring on the ground |
| Campfire | Warm light flicker (noise-driven intensity ±15%), embers |
| Landing | Camera dip proportional to fall speed, dust puff |

## 10. Accessibility

- Contrast ≥ 4.5:1 for all text on its actual background (HUD text has a shadow to hold contrast over bright sky).
- Colour is never the sole signal (icons + text reasons).
- Options: Reduce Motion, UI scale (90/100/115%), button size, invert Y, sensitivity, subtitles-style text for key sound cues (wolf nearby, rain starting) as HUD notes.
- Keyboard: all menus navigable with Tab/Enter/Esc; focus visible.
- `aria-label` on icon-only buttons; HUD toasts in an `aria-live="polite"` region.
