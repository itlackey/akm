# Theming

Every colour, font, type size, radius, shadow, focus ring, spacing step and page dimension the UI draws is a CSS custom
property on `:root`, defined once in [`src/lib/ui/tokens.css`](../src/lib/ui/tokens.css) inside `@layer tokens`.
Styles, components, charts and maps read these properties; charts and the library maps read the computed value when
they draw, so a changed token reaches them too. `tests/style-tokens.test.mjs` fails on a colour written anywhere else.

A colour is a `light-dark(light, dark)` pair: the system scheme picks one, and the Theme control (System / Light / Dark)
forces either. Other tokens are the same in both schemes.

## Match your app

An app that shows the UI in a frame cannot reach into the frame's styles, and a frame does not inherit its parent's
custom properties. The app writes its own style sheet instead, a CSS file that sets the tokens it wants on `:root`:

```css
/* https://app.example/akm-theme.css */
:root {
  --accent: light-dark(#0a7f5a, #5fd3a6);
  --accent-hover: light-dark(#086848, #86e0bd);
  --link: light-dark(#086848, #86e0bd);
  --font: "Inter", system-ui, sans-serif;
  --radius: 4px;
  --radius-small: 4px;
}
```

It serves the file from its own origin, names that origin in `frameParents` (in `experimental.web` of the akm config,
which also lets it frame the UI), and puts the file's absolute address in the frame's `theme` parameter (URL-encoded
if it has a query of its own):

```html
<iframe src="https://akm.example/?theme=https://app.example/akm-theme.css"></iframe>
```

The UI links the sheet once, at startup, after its own styles. The sheet is outside every cascade layer, so it wins over
`@layer tokens` at every width (a token that changes below a width, such as `--control-height`, takes the given value
at all widths). Give a colour as a `light-dark()` pair to keep both schemes; a single colour is used in both. The frame
keeps the sheet for its session, across navigation and reloads; a later `theme` replaces it. A `theme` that is not an
absolute `http` or `https` address is ignored.

The browser decides what loads. With `frameParents` set, the page's Content Security Policy allows style sheets from
the UI's own origin and exactly those origins (`style-src 'self' 'unsafe-inline' https://app.example`), so a sheet from
any other origin is refused. Without `frameParents` the policy is unchanged, and only a sheet from the UI's own origin
loads: one behind a reverse proxy that serves the app and the UI on one origin, for example. The login form is a
separate page with its own minimal style and does not use the tokens. AKM Desktop is never framed, so none of this
applies to it.

A sheet is still a style sheet: one that points `--bg` at an unreadable colour gets an unreadable page. Check contrast
for text tokens (`--text`, `--muted`, `--faint`, `--link`) against `--bg` and `--surface`, and keep the map and replay
colours apart (see `tests/map-palette.test.mjs` for what the defaults meet).

A page or extension that controls the UI's own document, rather than framing it, can set the same custom properties on
`:root` directly.

## What stays literal

A value is a token when an app would change it to match its own look. These stay literal on purpose:

- Spacing off the `--space-*` scale (2, 3, 5, 6, 10, 20, 40px and the like): nudges that align one element to another.
- Per-view column and panel widths (a 236px file tree, a 760px reading column): each view's own composition. The page
  as a whole follows `--content-max` and the window or frame it is in.
- Corner radii of 2, 3, 5 and 9px on bars, swatches and the Home signal tile, and `50%` on dots: drawn to the
  element's size.
- Three single heading sizes (25px, 26px and `clamp(26px, 2.5vw, 34px)`) and the `em` sizes of inline code, which scale
  with the text around them.
- `z-index`: the order of the UI's own layers.
- Chart geometry and the chart tooltip's 12px text: ECharts draws in pixels; its colours and font come from the tokens.
- The 3D map's point sprites are white alpha masks that take each point's token colour.

## Tokens

The defaults, from `tokens.css`. "same" means the token has one value for both schemes.

| Token | Styles | Light | Dark |
| --- | --- | --- | --- |
| `--bg` | Page background | `#f7f7fa` | `#15151a` |
| `--surface` | Cards, panels, inputs, menus | `#ffffff` | `#1c1c23` |
| `--surface-2` | Raised rows, table heads, hover fills | `#f0f0f5` | `#25252e` |
| `--surface-sunk` | Sunken wells, disabled buttons | `#e9e9f0` | `#191920` |
| `--border` | Ordinary borders and dividers | `#e2e2ea` | `#363640` |
| `--border-strong` | Input and control borders | `#81818f` | `#858594` |
| `--rule` | Section rules | `var(--border)` | same |
| `--text` | Body text | `#23232e` | `#ececf2` |
| `--muted` | Secondary text, icons | `#5c5c6d` | `#b8b8c7` |
| `--faint` | Placeholders, least important text | `#696979` | `#aaaaba` |
| `--accent` | Primary buttons, selection, the active tab | `#6741c4` | `#b59aee` |
| `--accent-hover` | Primary button hover | `#5432a5` | `#ccb8fa` |
| `--accent-bg` | Selected and highlighted row fill | `#eeebf8` | `#332b47` |
| `--on-accent` | Text on an accent or status fill | `#ffffff` | `#20182d` |
| `--ok` | Success text and marks | `#17753a` | `#34d399` |
| `--ok-bg` | Success fill | `#e3f4e9` | `#0f2a20` |
| `--warn` | Warning text and marks | `#8a5a00` | `#fbbf24` |
| `--warn-bg` | Warning fill | `#fcf0d3` | `#2b2210` |
| `--fail` | Error text, danger buttons | `#c4202c` | `#f87171` |
| `--fail-hover` | Danger button hover | `color-mix(in srgb, var(--fail) 85%, black)` | same |
| `--fail-bg` | Error fill | `#fde6e8` | `#2d1416` |
| `--add-strong` | Diff: added word | `#a8e0bb` | `#1d6b49` |
| `--del-strong` | Diff: removed word | `#f5b3b9` | `#7f2a2f` |
| `--hunk-bg` | Diff: hunk header | `#f3efff` | `#16162b` |
| `--link` | Links, focus ring | `#5936ad` | `#c9b4f6` |
| `--age-1` | Review queue by age, newest | `#8f7bd1` | `#6a58b0` |
| `--age-2` | Review queue by age, middle | `#6d4fc0` | `#8f7bdc` |
| `--age-3` | Review queue by age, oldest | `#4a2a9c` | `#c4b5fd` |
| `--age-unknown` | Review queue, age not known | `#767684` | `#8a8a96` |
| `--s1` | Chart series 1 | `#2f64d0` | `#c4b5fd` |
| `--s2` | Chart series 2 | `#b45309` | `#fbbf24` |
| `--s3` | Chart series 3 | `#0f766e` | `#34d399` |
| `--s4` | Chart series 4 | `#be185d` | `#f472b6` |
| `--s5` | Chart series 5 | `#7c3aed` | `#60a5fa` |
| `--s6` | Chart series 6 | `#6b7280` | `#9a9aa6` |
| `--map-1` | Map: category 1 | `#cc7b01` | `#d55f00` |
| `--map-2` | Map: category 2 | `#8a7cff` | `#0174b2` |
| `--map-3` | Map: category 3 | `#059783` | `#0ddd60` |
| `--map-4` | Map: category 4 | `#8d9258` | `#f1ea3d` |
| `--map-5` | Map: category 5 | `#0245a0` | `#8b55f6` |
| `--map-6` | Map: category 6 | `#a13500` | `#b16d56` |
| `--map-7` | Map: category 7 | `#bc74c5` | `#755564` |
| `--map-8` | Map: category 8, "Other" | `#383838` | `#a6a6a6` |
| `--map-highlight` | Map: highlighted assets | `#8c00ff` | `#cdffcd` |
| `--pulse-read` | Replay: a read | `#00000f` | `#00a5c3` |
| `--pulse-hit` | Replay: a search hit | `#e100e1` | `#f05aff` |
| `--pulse-up` | Replay: positive feedback | `#00782d` | `#e1ff69` |
| `--pulse-down` | Replay: negative feedback | `#f01e3c` | `#c3001e` |
| `--use-0` | Use colouring: never shown | `#cbcfd6` | `#3b404b` |
| `--use-1` | Use colouring, step 1 (least) | `#4588e4` | `#1c60c1` |
| `--use-2` | Use colouring, step 2 | `#1d65c9` | `#3d82e3` |
| `--use-3` | Use colouring, step 3 | `#154a93` | `#76a7eb` |
| `--use-4` | Use colouring, step 4 (most) | `#0e3161` | `#afccf4` |
| `--marker` | A reference marker on a chart, and its key | `#a16207` | `#fbbf24` |
| `--backdrop` | Behind a modal dialog | `rgb(0 0 0 / 0.55)` | same |
| `--scrim` | Behind the leave-editor and secret dialogs | `rgb(0 0 0 / 0.4)` | same |
| `--target-min` | Smallest click target | `24px` | same |
| `--topbar-h` | Top bar height | `4rem`; `3.5rem` below 72rem | same |
| `--top-inset` | Space the top bar covers (scroll offsets) | `4rem`; `3.5rem` below 48rem | same |
| `--bottom-inset` | Space a bottom bar covers | `0px` | same |
| `--content-max` | Widest the page content grows | `100rem` | same |
| `--workspace-height` | Height of a master-detail workspace | `calc(100dvh - 158px)`; `calc(100dvh - 190px)` below 48rem | same |
| `--control-height` | Buttons, inputs, selects | `2.5rem`; `2.75rem` below 48rem | same |
| `--space-1` | Spacing scale | `4px` | same |
| `--space-2` | Spacing scale | `8px` | same |
| `--space-3` | Spacing scale | `12px` | same |
| `--space-4` | Spacing scale | `16px` | same |
| `--space-5` | Spacing scale | `24px` | same |
| `--space-6` | Spacing scale | `32px` | same |
| `--space-7` | Spacing scale | `48px` | same |
| `--radius-xs` | Badges, menu and tree rows | `4px` | same |
| `--radius-small` | Buttons | `6px` | same |
| `--radius` | Inputs, cards, panels, menus | `8px` | same |
| `--radius-large` | Home's attention card | `12px` | same |
| `--radius-pill` | Pills and counts | `999px` | same |
| `--text-3xs` | Counts in tabs, tiny labels | `0.6875rem` | same |
| `--text-2xs` | Badges, metadata | `0.75rem` | same |
| `--text-xs` | Labels, table heads, small text | `0.8125rem` | same |
| `--text-s` | Secondary text, field labels | `0.875rem` | same |
| `--text-m` | Body text, buttons | `0.9375rem` | same |
| `--text-base` | Emphasised body text | `1rem` | same |
| `--text-subtitle` | Small section headings | `1.0625rem` | same |
| `--text-l` | Section headings (h2) | `1.125rem` | same |
| `--text-lead` | Panel headings | `1.25rem` | same |
| `--text-result` | Search result titles | `1.3125rem` | same |
| `--text-xl` | Large headings | `1.375rem` | same |
| `--text-heading` | View headings | `1.5rem` | same |
| `--text-title` | Page titles | `1.75rem` | same |
| `--text-2xl` | Page heading (h1) | `clamp(2rem, 1.3rem + 2.6vw, 3.25rem)` | same |
| `--text-stat` | Big numbers | `clamp(2rem, 1.5rem + 1.6vw, 2.75rem)` | same |
| `--leading` | Body line height | `1.55` | same |
| `--leading-tight` | Heading line height | `1.05` | same |
| `--leading-snug` | Compact line height | `1.5` | same |
| `--tracking-tight` | Heading letter spacing | `-0.045em` | same |
| `--tracking-snug` | Section heading letter spacing | `-0.02em` | same |
| `--tracking-caps` | Upper-case label letter spacing | `0.06em` | same |
| `--weight-strong` | Bold weight | `600` | same |
| `--shadow-panel` | Search filter panel | `0 8px 24px rgb(0 0 0 / 0.1)` | same |
| `--shadow-popover` | Asset menu popover | `0 8px 24px rgb(0 0 0 / 0.12)` | same |
| `--shadow-menu` | File context menu | `0 8px 24px rgb(0 0 0 / 0.25)` | same |
| `--shadow-float` | Floating unsaved-draft bar | `0 8px 28px rgb(24 24 40 / 0.12)` | same |
| `--shadow-sticky` | Edge of a sticky form footer | `0 -8px 8px -8px rgb(0 0 0 / 0.15)` | same |
| `--edge-accent` | Accent bar on a row's leading edge | `inset 3px 0 0 var(--accent)` | same |
| `--edge-underline` | Current-tab underline (inside) | `inset 0 -3px 0 var(--accent)` | same |
| `--edge-tab` | Current-tab underline (Settings, Activity) | `0 2px 0 var(--accent)` | same |
| `--edge-ok` | Success bar on a row's leading edge | `inset 3px 0 0 var(--ok)` | same |
| `--edge-warn` | Warning bar on a row's leading edge | `inset 3px 0 0 var(--warn)` | same |
| `--edge-fail` | Error bar on a row's leading edge | `inset 3px 0 0 var(--fail)` | same |
| `--focus-ring` | Keyboard focus outline | `2px solid var(--link)` | same |
| `--focus-ring-accent` | Keyboard focus on list rows and cards | `2px solid var(--accent)` | same |
| `--focus-offset` | Gap between a control and its focus outline | `2px` | same |
| `--focus-halo` | Keyboard focus on text fields | `0 0 0 3px color-mix(in srgb, var(--link) 30%, transparent)` | same |
| `--font` | Interface font | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif` | same |
| `--mono` | Code, paths and IDs | `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace` | same |
