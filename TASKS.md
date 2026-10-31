# WILD FRONTIER — Tasks

Each phase is finished and verified before the next one starts (PRD §22). Status legend: `[ ]` not started · `[~]` in progress · `[x]` done and verified · `[!]` blocked/limited (see note).

Verification column: **T** = `tsc --noEmit`, **B** = `vite build`, **U** = node unit test, **M** = manual check on device (needs the user, see ARCHITECTURE.md R1), **D** = diagnostics overlay measurement.

---

## Phase 1 — Repository inspection and planning ✅ (approved)

- [x] Read PRD.md completely (459 lines)
- [x] Inspect folder: only `PRD.md`, `src/.gitkeep`, `public/.gitkeep`; no package.json, no git
- [x] Inspect environment: Termux, Android 16 aarch64, Node 26.12.1, npm 12.2.1, ~1.9 GB free RAM, no browser automation
- [x] Survey dependency versions and Android-arm64 native support (no install)
- [x] Identify risks: ARCHITECTURE.md §2 (R1–R13)
- [x] Write ARCHITECTURE.md, DESIGN-SYSTEM.md, TASKS.md
- [x] **User approval to start Phase 2** (2026-10-31)

User decisions (2026-10-31), recorded in ARCHITECTURE.md:
- Vite: use `vite@7.3.7` directly; Vite 8 is not attempted.
- Death: respawn at last campfire/shelter; lose a small portion (15%, rounded down) of raw resources only; tools are safe.
- git: initialise the repo and commit after Phase 2.

## Phase 2 — Project foundation

| # | Task | Verify | Status |
|---|---|---|---|
| 2.1 | `package.json` with pinned `three@0.187.0`, `@types/three@0.187.0`, `typescript@6.0.3`, `vite@7.3.7`; scripts `dev` (`--host`), `build`, `preview`, `typecheck`, `test` | install succeeds on Termux | [x] |
| 2.2 | Record actual installed versions and native bindings in ARCHITECTURE.md §1.4 | B | [x] |
| 2.3 | `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit` | T | [x] |
| 2.4 | `index.html` (viewport no-zoom, theme colour), `styles/main.css` with design tokens and gesture blocking | M | [~] (T+B pass; pull-to-refresh & pinch-zoom blocking not yet manually tested) |
| 2.5 | `main.ts` boot: WebGL capability check + styled fallback screen with a working Retry | M (simulate by forcing failure flag) | [~] (T+B pass; `?nowebgl=once` & Retry button not yet manually tested) |
| 2.6 | `EventBus`, `math`, `Random` (seeded PRNG) | U | [x] |
| 2.7 | `GameLoop`: rAF, clamped dt, fixed 60 Hz step with accumulator, FPS cap, pause on `visibilitychange` | U (accumulator logic), M | [x] (U+M pass on Mali-G57 MC2: 30 FPS cap & 90 FPS uncapped) |
| 2.8 | `SceneManager`: renderer, camera, resize/orientation handling, pixel ratio control | M | [~] (T+B+M render pass; portrait/landscape rotation not yet manually tested) |
| 2.9 | `AssetManager`: shared geometry/material/texture registry, procedural texture helpers, dispose | T | [x] (T+U pass) |
| 2.10 | `DeviceProfile` + `GraphicsSettings` (Low/Medium/High/Ultra tables, apply at runtime) | U (preset selection), M | [x] (U+M pass on Mali-G57 MC2: Medium 30 FPS, Ultra 90 FPS, live preset switch) |
| 2.11 | `PerformanceMonitor` + adaptive resolution controller with hysteresis | U | [x] |
| 2.12 | `DiagnosticsUI`: FPS/frame ms/draw calls/triangles/pixel ratio + error overlay (window errors, rejections) | M | [x] (T+B+M pass: diagnostics visible, no errors) |
| 2.13 | `Game` state machine skeleton (Boot → MainMenu → Loading → Playing ⇄ Paused), with a minimal test scene that proves the loop renders | M | [x] (U+T+B+M pass on Android Chrome) |
| 2.14 | `node --test` setup with first tests passing | U | [x] (52/52 tests pass) |
| 2.15 | Gate: T + B + U pass; user confirms the test scene runs in Android Chrome with diagnostics visible | T B U M | [x] (Confirmed on Android Chrome Mali-G57 MC2, 2026-10-31) |

## Phase 3 — World and player

| # | Task | Verify | Status |
|---|---|---|---|
| 3.1 | `Noise` (seeded simplex, fBm, ridged) | U determinism | [x] (U pass) |
| 3.2 | `Heightfield` + `WorldGenerator` macro layout (mountains, valley, lake basin, river splines + carving, boundary ring, POI placement) | U same seed gives identical output | [x] (U pass) |
| 3.3 | `ChunkWorker`: chunk geometry (3 LODs + skirts) and material weights as transferables | U (pure builder), M | [x] (U+T+B+M pass on Mali-G57 MC2 Ultra [441 chunks] & Medium [169 chunks], no seam gaps; Low preset not yet manually tested) |
| 3.4 | `Terrain`: chunk manager, LOD rings, time-sliced uploads, geometry pooling, blended terrain material | D no hitches, M | [x] (U+T+B+M+D pass on Mali-G57 MC2: Ultra 60 FPS [441 chunks, 68 calls, ~50k tris] & Medium cap 30 [30 FPS, CPU 1.6–4.4 ms, 50–82 calls, 28–45k tris, 169 chunks, q=0, no errors]; Low preset not yet manually tested) |
| 3.5 | `Water`: lake plane + river ribbons + waterfall shader; shallow/deep water detection | M | [~] (U+T+B pass; M pass for lake & shoreline on Mali-G57 MC2 Ultra & Medium; non-collinear rotated ripple octaves + distance fade added to fix distant water grid pattern, awaiting M re-verify; rivers, waterfall, and Low preset not yet manually tested) |
| 3.6 | `Collision`: spatial hash (circles, boxes), push-out resolution | U | [x] (U pass) |
| 3.7 | `PlayerController`: walk/run/sprint/crouch/jump, damping, coyote time, jump buffer, gravity, ground snap, slope limit, swim, world-boundary soft stop | U (kinematics), M | [~] (U+T+B pass; M pass on Mali-G57 MC2 Medium for Idle, Walk, Run, Sprint, Crouch, Jump, ground snap; swim and world-boundary walk not yet manually tested on device) |
| 3.8 | `CameraController`: orbit follow, smoothing, zoom, terrain + collider avoidance, sensitivity, invert Y | M camera never clips | [x] (U+T+B+M pass on Mali-G57 MC2 Medium: third-person orbit follow & terrain/collider avoidance verified, 30 FPS, no errors) |
| 3.9 | `CharacterModel` + `AnimationController` FSM: idle, walk, run, sprint, jump, fall, land, crouch, gather, swim, drink | U (FSM transitions), M | [~] (U+T+B pass; M pass on Mali-G57 MC2 Medium for Idle, Walk, Run, Sprint, Crouch, Jump/Fall/Land, Gather pose; Drink and Swim poses not yet manually tested on device) |
| 3.10 | `KeyboardMouseInput` (WASD, Space, Shift, E, I, C, Esc, pointer lock) | M (desktop; may be untested, see R2) | [~] (U+T+B pass; desktop browser M untested on Termux per R2) |
| 3.11 | `TouchInput` + `TouchControlsUI`: floating joystick, camera swipe, pinch zoom, buttons; multitouch by pointerId; gesture blocking | M multitouch move+look+jump at once | [~] (U+T+B pass; M pass on Mali-G57 MC2 Medium [30 FPS, CPU 2.5–3.4 ms, no errors]: joystick, Crouch, Sprint, Jump, Drink disabled without water, Bag disabled labeled Phase 5 verified; multitouch simultaneous move+look+jump, right-zone camera swipe/pinch, portrait/landscape rotation, pull-to-refresh gesture blocking, and Drink at water edge not yet manually tested) |
| 3.12 | Gate: walk to every boundary; no falling through terrain; camera never clips; chunks stream without hitches (D) | M D | [~] (U+T+B pass; D pass on Ultra & Medium [30 FPS, CPU 2.5–3.4 ms, no errors]; terrain ground snap & camera avoidance verified; walking all the way to world boundaries not yet manually tested on device) |

**Recorded polish notes from Phase 3 Group A & Phase 4 Group A device tests:**
- [x] **Phase 4 lighting/vegetation polish:** Trees appear too dark under current lighting — verified fixed on Mali-G57 MC2 Medium (`Environment` upward-biased foliage normals, bottom-to-top vertex colour gradient, subtle moss emissive lift, and boosted `HemisphereLight`).
- [~] **Water polish:** Distant water surface exhibits a subtle grid/box pattern — addressed in `Water.ts` (rotated 3-octave non-collinear ripples, removed extra UV grid offset, added distance ripple attenuation); awaiting M verification on device.
- [~] **Grass & pine/rock polish (Phase 4 Group A follow-up):** Grass replaced with 9 thin pointed triangular blades per tuft (~0.25–0.50 m tall, varied blade heights & meadow/olive colours, gentle root-anchored wind sway, instanced, off on Low); pine cone tiers changed to open-ended cones (`openEnded = true`) with upward-clamped normals and no self-shadowing bands to fix thin horizontal dark lines between canopy tiers; Phase 2 placeholder grey box pedestal removed and rock polyhedra faceted with mineral/moss tint; awaiting M re-verify on device.

## Phase 4 — Environment

Split into 3 small session groups to keep each session lightweight:
- **Group A (Tasks 4.1–4.4):** Procedural vegetation (pine 3 LODs + far impostor, deciduous, dead trees), rule-based scatter & clearings, chunk-grouped `InstancedMesh` with frustum culling & LOD swap, rocks, bushes (berry + fiber), and player-centred grass ring with wind shader.
- **Group B (Task 4.5):** `Landmarks` and POI structures (cabins, campsites, rock-shell caves with shelter flag, watchtower, ruined bridge) with colliders and loot containers.
- **Group C (Tasks 4.6–4.10):** `Sky` dome shader, `DayNightCycle` keyframed palettes & sun/moon lighting, `Weather` FSM & transitions, `Particles` (pooled rain, mist, dust/pollen, embers), and Phase 4 verification gate.

### Group A — Forests, vegetation, rocks, instancing & LOD (Tasks 4.1–4.4)

| # | Task | Verify | Status |
|---|---|---|---|
| 4.1 | Procedural pine (3 LODs) + far impostor baked at load; deciduous/dead tree variants | M | [~] (U+T+B pass; M pass on Mali-G57 MC2 Medium for pine, deciduous, and far impostor; open-ended cone fix for horizontal seam & dead tree variant awaiting M check) |
| 4.2 | Rule-based scatter: forest density, clustering, clearings around POIs/rivers/paths | U (rules), M | [x] (U+T+B+M pass on Mali-G57 MC2 Medium) |
| 4.3 | `Environment`: per-chunk-group InstancedMesh, frustum culling, LOD swap, stable instance IDs | D draw calls within budget | [x] (U+T+B+D+M pass on Mali-G57 MC2 Medium cap 30: 30 FPS, 33.3 ms frame, CPU 3.66 ms, 82 calls, 40.4k tris, 15 MB heap, no errors; Low & High presets not yet manually tested) |
| 4.4 | Rocks, bushes (berry + fiber), grass ring with wind shader | M | [~] (U+T+B pass; pointed thin grass blades [0.25–0.5 m] + faceted rocks updated, awaiting M re-verify; rocks, berry bushes, Low & High presets not yet manually tested) |

### Group B — Landmarks and POI structures (Task 4.5)

| # | Task | Verify | Status |
|---|---|---|---|
| 4.5 | `Landmarks`: cabins, campsites, caves (rock-shell, shelter flag), watchtower, ruined bridge, with colliders and containers | M | [~] (U+T+B pass; awaiting M on Android Chrome) |

### Group C — Sky, day/night, lighting, fog, weather & particles (Tasks 4.6–4.10)

| # | Task | Verify | Status |
|---|---|---|---|
| 4.6 | `Sky`: dome shader with gradient, sun/moon discs, stars | M | [ ] |
| 4.7 | `DayNightCycle`: keyframed palettes, smooth interpolation, sun/moon light swap, shadow frustum follow | U (palette interpolation), M | [ ] |
| 4.8 | `Weather`: Clear/Cloudy/Fog/Rain FSM, 60 s cross-fades, wind strength drives the shaders | U (FSM), M | [ ] |
| 4.9 | `Particles`: pooled rain, mist, dust/pollen, embers with preset caps | D | [ ] |
| 4.10 | Gate: world looks composed rather than random scatter (user visual review); smooth transitions; budgets measured | M D | [ ] |

## Phase 5 — Gameplay systems

| # | Task | Verify |
|---|---|---|
| 5.1 | `ItemDatabase` (resources, tools, consumables, placeables) + `InventorySystem` (24 + 4 slots, stacking, durability, no-loss overflow) | U |
| 5.2 | `Recipes` + `CraftingSystem` (atomic; checks output space; never creates without resources) | U |
| 5.3 | `PlayerStats` + `SurvivalSystem` (hunger, thirst, stamina, temperature, health regen/damage; difficulty scale) | U |
| 5.4 | Death → respawn at last campfire/shelter (else spawn camp); lose 15% (floor) of raw resource stacks only; tools/consumables/placeables kept; never stuck | U + M |
| 5.5 | `InteractionSystem` (nearest interactable, prompt, 10 Hz query) | M |
| 5.6 | `GatheringSystem`: chop/mine/pick/search/drink, each with animation hit event + sound + toast + inventory update; depletion & respawn rules | U (depletion), M |
| 5.7 | Consumables: eat berries, drink water/flask, bandage | U, M |
| 5.8 | Equip tools/torch (torch = light + warmth + keeps wolves away) | M |
| 5.9 | `BuildingSystem`: preview, rotate, validation (slope, water, overlap, distance, bounds), confirm/cancel, consume on success only | U (validation), M |
| 5.10 | Campfire (light, warmth, fuel, refuel) and shelter (rain cover, warmth, regen, rest, respawn point) | U (effects), M |
| 5.11 | `AnimalSpecies` + `AnimalModels` (deer, rabbit, bird, wolf) with gait animation | M |
| 5.12 | `AnimalAI` FSMs (idle, wander via waypoints, forage, alert, flee, stalk/chase/attack/retreat) + threat detection (player stance, wolves, fire) | U (transitions) |
| 5.13 | `WildlifeManager`: pooling, habitat spawning, distance-tiered updates | D AI ≤ 1.5 ms |
| 5.14 | `DiscoverySystem`: named locations, discovery events | U |
| 5.15 | Gate: each stat changes and has a working restore path; deer/rabbits flee; wolves behave as predators; crafting and building rules hold | U M D |

## Phase 6 — UI, map, audio, save

| # | Task | Verify |
|---|---|---|
| 6.1 | `UIManager` screen stack + transitions + input capture | M |
| 6.2 | `Icons` SVG set + logo SVG | M |
| 6.3 | `MainMenu` (tap-to-begin, New Game, Continue visible only with a valid save, Settings, Credits) + cinematic background | M |
| 6.4 | `HUD`: stats, compass, prompt, toasts, discovery banner, time/weather chip, save indicator, build bar; 10 Hz throttled, diff-only writes | M D |
| 6.5 | `InventoryUI` (select, use, equip, place, drop, rearrange, quick slots) | M |
| 6.6 | `CraftingUI` (have/need, disabled reasons, craft) | M |
| 6.7 | `MapUI`: heightfield-rendered map, fog of war, POIs, structures, markers, zoom/pan, recentre | U (fog bitset), M |
| 6.8 | `PauseMenu` (Resume, Save, Settings, Quit to Menu with autosave) + `DialogUI` (save confirmation, damaged save, death, IDB unavailable) | M |
| 6.9 | `SettingsUI`: graphics preset, FPS cap, adaptive res, sensitivity, invert Y, zoom, button size, left-handed, volumes, day length, difficulty, reduce motion, UI scale, diagnostics toggle; all applied live and persisted | M |
| 6.10 | `AudioSystem` + `SoundSynth`: unlock on gesture, buses, volume, ambience/wind/birds/water/rain/footsteps/gathering/crafting/UI/fire/wolf, voice cap | M |
| 6.11 | `SaveSchema` validators + checksum + migration | U (valid, truncated, corrupted, wrong types, unknown item, future version) |
| 6.12 | `SaveSystem`: IndexedDB manual + autosave, atomic put, newest-valid Continue, memory fallback + banner | U (with fake storage), M |
| 6.13 | Persist: position, stats, inventory, crafted counts, structures, depleted resources, containers, discovered locations, fog of war, markers, time, weather, settings | U round-trip, M reload test |
| 6.14 | Gate: save → reload page → Continue restores the same world state; corrupted save is handled; private mode works without saving | U M |

## Phase 7 — Optimization and polish

| # | Task | Verify |
|---|---|---|
| 7.1 | Profile on this device per preset; tune LOD distances, view distance, shadow cadence, instance counts | D (record numbers in README) |
| 7.2 | Confirm no per-frame allocations in hot paths (heap stable in diagnostics) | D |
| 7.3 | Shader pre-compile during loading; no first-use stalls | D/M |
| 7.4 | Adaptive resolution tuning and thermal soak (15 min session) | D M |
| 7.5 | Game feel: head-bob (optional), landing dip, footstep dust, gather particles, campfire flicker, UI animation pass, reduce-motion compliance | M |
| 7.6 | Optional: hand-written service worker for offline reload (localhost/HTTPS only) | M |
| 7.7 | Gate: stable frame rate on Medium on this device (target 30 FPS) or documented actual numbers + default lowered | D |

## Phase 8 — Testing and final verification

| # | Task | Verify |
|---|---|---|
| 8.1 | `npm run typecheck`, `npm test`, `npm run build`: all pass, fix errors | T U B |
| 8.2 | Dead-control audit: every button has a handler or a disabled state with a reason | script + M |
| 8.3 | Check that no network requests happen after load (all procedural; `vite preview` with Wi-Fi off) | M |
| 8.4 | Manual checklist (below) on Android Chrome | M |
| 8.5 | README: description, features, stack, install, dev commands, build, deployment (static hosting), controls, performance numbers, known limitations (incl. R1, R2, R6, R7) | — |
| 8.6 | Final report: what is verified, what is untested, what is incomplete | — |

### Manual test checklist (run by the user; agent records results)

**Boot and menu**
- [ ] Main menu loads, "Tap to begin" unlocks audio, no errors in the error overlay
- [ ] Continue hidden with no save; visible after saving
- [ ] Settings and Credits open and close

**Controls**
- [ ] Joystick moves, right-side swipe rotates the camera, and Jump works — **all at the same time**
- [ ] Sprint and crouch toggles work; stamina drains/regens
- [ ] No pull-to-refresh, pinch-zoom of the page, or text selection during play
- [ ] Rotate phone: layout adapts in landscape and portrait

**World and camera**
- [ ] Walk into a hillside and around trees: camera never goes inside terrain/rocks/cabins
- [ ] Walk to the world edge: gently stopped with a hint
- [ ] Run for 2 minutes: no stutter when new areas load (check diagnostics)

**Environment**
- [ ] Day passes into night smoothly; weather changes smoothly; rain visible and audible

**Wildlife**
- [ ] Deer and rabbits flee when approached; crouching lets you get closer
- [ ] Wolves stalk/chase at night; they back off from campfire/torch

**Gathering, inventory, crafting**
- [ ] Each gather type shows animation + sound + toast + inventory change
- [ ] Craft every recipe; materials deducted correctly; craft blocked when short
- [ ] Fill inventory: gathering/crafting is refused without losing items

**Building and survival**
- [ ] Place campfire and shelter: rotate works, invalid spots are red and rejected, cancel refunds nothing because nothing was consumed
- [ ] Campfire warms; shelter blocks rain cold
- [ ] Eat, drink, rest restore stats; dying leads to the respawn screen, then you can play again

**Map and save**
- [ ] Map matches the world; zoom/pan/markers work; discoveries appear
- [ ] Save, reload the page, Continue: same position, inventory, structures, time
- [ ] Private/incognito tab: warning banner shown, game still playable

**Graphics**
- [ ] Switching presets Low/Medium/High/Ultra visibly changes quality and FPS

**Platforms**
- [ ] Desktop browser: same checklist with keyboard/mouse (if available)
- [ ] iOS Safari: same checklist (if available; otherwise documented as untested)

---

## Requirement traceability (PRD → tasks)

| PRD section | Tasks |
|---|---|
| §3 Stack | 2.1–2.3 |
| §5 Visual direction | 3.4, 3.5, 4.1–4.9, 7.5 |
| §6 Player controller | 3.7–3.9 |
| §7 Controls | 3.10, 3.11, 6.9 |
| §8 Open world | 3.1–3.6, 4.2–4.5 |
| §9 Wildlife | 5.11–5.13 |
| §10 Survival | 5.3, 5.4, 5.7, 5.10 |
| §11 Gathering | 5.5, 5.6 |
| §12 Inventory/crafting | 5.1, 5.2, 6.5, 6.6 |
| §13 Building | 5.9, 5.10 |
| §14 Day/night/weather | 4.6–4.9 |
| §15 Audio | 6.10 |
| §16 UI/UX | 6.1–6.9, DESIGN-SYSTEM.md |
| §17 Map | 5.14, 6.7 |
| §18 Save | 6.11–6.14 |
| §19 Performance | 2.10–2.12, 3.4, 4.3, 5.13, 7.1–7.4 |
| §20 Polish | 7.5 |
| §22 Phase 8 / §23 DoD | 8.1–8.6 |
