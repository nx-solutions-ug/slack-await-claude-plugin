# Assets

| File                | Size            | What                                                      |
| ------------------- | --------------- | --------------------------------------------------------- |
| `logo.svg`          | 512×512 viewBox | The logo, flat vector (fills only, no strokes or effects) |
| `logo-512.png`      | 512×512         | Logo, transparent background                              |
| `logo-128.png`      | 128×128         | Logo, transparent background                              |
| `banner-social.png` | 1280×640        | GitHub social preview (Settings → Social preview)         |
| `banner-readme.png` | 1200×300        | Flat banner for the top of the README                     |

## Logo

Drawn as vector shapes in VectorCraft (via its MCP); source file `source/logo.vectorcraft` (three artboards: the chosen
alarm-clock bubble and two discarded variants, an hourglass bubble and a typing-dots bubble with a
clock badge). A speech bubble that is also an alarm clock: the question waits, and the session
rings awake when the answer comes. Checked for legibility at 16, 32 and 64 px on light and dark
backgrounds.

Colours: indigo `#4F46E5` (bubble), amber `#F59E0B` (bells), white `#FFFFFF` (clock hands).
No third-party marks are used or imitated.

## Banners

The backgrounds are AI-generated (imagerouter, model `black-forest-labs/FLUX-3-klein`), abstract
only: no text, no logos. Native generation sizes: 1280×640 (social) and 1536×384 (README, scaled
to 1200×300). The logo and the wordmark (Inter) are composited locally on top by
`source/compose-banners.py`, which reads the backgrounds from `source/banner-*-bg.jpg`:

```sh
python3 assets/source/compose-banners.py   # needs Pillow, rsvg-convert and the Inter font
```

Prompts (both ended with "No text, no letters, no words, no logos, no icons, no user interface."):

- Social: deep indigo to dark navy gradient (`#1E1B4B` → `#312E81`), thin concentric ripple arcs
  in `#6366F1` at the far left and right edges with a few tiny amber `#F59E0B` dots, empty middle.
- README: the same, wide format, arcs in `#4F46E5`.

Generated on 2026-11-13; cost of the generations used and discarded: USD 0.0039.
