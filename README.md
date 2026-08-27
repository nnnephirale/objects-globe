# Objects — masonry ⇄ photo globe

A flat masonry grid of your own images that wraps inward into a rotating photo globe,
with a word curving across its surface. Tap **Wrap** to fold it up, **Unwrap** to lay it
back down. Mobile first; the settings panel is a bottom sheet on phones and a right rail
on desktop.

## Run it

**Just double-click `index.html`.** It opens with the demo set already on screen — no
server, no network, no build. The scripts are deliberately classic (not ES modules) and
three.js is vendored as a plain global, because module scripts are CORS-blocked on
`file://` and would leave you with a blank page.

For development, a static server gives you no-cache headers so edits show up immediately:

```bash
node serve.js
```

Then open <http://localhost:4321>. Any static server works.

Opened from `file://`, browsers usually block IndexedDB and sometimes localStorage. The
app detects that and carries on — everything works, it just can't remember uploads or
settings between visits. Serve it over http if you want them to stick.

## Using it

- **+** (top right) or drag-and-drop anywhere — add images. They're downscaled to 760px
  and kept in IndexedDB, so they survive a reload.
- **Wrap / Unwrap** — the morph. Space bar does the same.
- **Drag** the canvas to spin the globe; it carries momentum.
- **Gear** (or `S`) — settings. `Esc` closes.

Images are dealt out like a shuffled deck to fill the grid, so five uploads still make a
full globe. Dealing beats plain cycling here: cycling repeats with period `images.length`,
so any row holding a multiple of that starts on the same image every time and the grid
grows vertical stripes of identical tiles. A reshuffled bag keeps usage even — every image
appears within one of every other — while breaking the period. It's seeded, so the layout
is the same on every rebuild.

## The controls

| Tab | What matters |
| --- | --- |
| **Images** | Add, remove, demo set, clear |
| **Grid** | Columns (how many read across the viewport), Rows, Gap, Offset (running-bond row stagger), Width (how far the grid bleeds past the edges), Crop (pulls mixed aspect ratios toward square), Radius |
| **Globe** | Size, Tiles, Taper (shrink toward the poles), Spin, Tilt, Morph, Stagger (edges wrap before the middle), Bulge, Auto loop |
| **Text** | The word, colour, size, tracking, height on the sphere, lift off the surface |

Columns and Rows follow the viewport until you type into them; **Reset all** hands them
back to automatic.

## How the morph works

Each image is a plane with two poses:

- **flat** — position from a justified masonry layout (every row is padded to exactly the
  grid width so the sheet wraps seamlessly), no rotation.
- **sphere** — the grid's x maps to longitude and y to latitude, so the sheet genuinely
  wraps rather than being projected. Each plane lies flat on the surface facing outward;
  nothing is randomly rotated.

Alternate rows are shifted sideways by half a tile (running bond), so tile edges never
line up into vertical columns. Because every row spans the full wrap, that shift is a
cyclic rotation — tiles that run off one edge come back on the other, and no gap opens up.
The offset carries into the sphere for free, since longitude is just x.

A single `p` (0 = grid, 1 = globe) drives it: positions lerp, orientations slerp from
identity, and tiles nearer the grid edges start first, which is what makes it look like
it's wrapping inward. `p` is computed from the wall clock rather than accumulated frame
deltas, so a dropped frame never stalls the animation.

Tile size on the sphere is derived, not guessed: the equator can't be overrun
(`2πR / gridWidth`), and when the sheet is too tall for the sphere the scale splits the
difference so tiles overlap slightly instead of leaving the globe bare.

Rows thin out toward the poles, in two steps. A row at latitude `lat` is only `cos(lat)`
as long as the equator, so carrying a full row's worth of tiles up there piles them into a
spiky crown at the pole. Each row therefore keeps `round(n · cos(lat))` of its tiles,
evenly decimated — the top row of a nine-row grid drops from 18 tiles to about 4. The
culled tiles still belong to the flat grid; they fade out as it wraps and fade back in as
it unwraps.

Thinning alone isn't enough, though, and getting this wrong tears holes in the globe:
leaving the survivors at the longitudes they had in the grid gives them uneven slots,
because tiles differ in width and the decimation skips uneven numbers of them (keeping
indices 0, 4, 9, 13 means 80° and 100° slots for tiles cut to the 90° average). So each
ring is re-justified — every surviving tile gets an angular share proportional to its own
width, and the shares sum to exactly 360°. The fill ratio then works out to
`tileScale × tile/(tile + gap)` at *every* latitude, independent of `cos(lat)`: spacing is
uniform from equator to pole, and `Tiles` and `Gap` control it directly. That's also why
`Taper` now defaults to zero — it was only ever compensating for the crowding.

The word is separate — one plane per letter, placed along a latitude, facing outward,
front-faces only. It fades in over the second half of the morph and is occluded by tiles
in front of it, so it slides in and out of legibility as the globe turns.

## Files

- `index.html` — chrome, panel, styles
- `app.js` — layout, sphere mapping, morph, WebGL, UI
- `vendor/three.global.js` — three.js r160, vendored (no CDN) and converted from the ESM
  build to a classic script so the page runs from `file://`; only the final `export` was
  rewritten, into `window.THREE`
- `serve.js` — dev server
