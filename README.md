# Retrace

Retrace turns raster logos (PNG, JPG) into clean vector artwork (SVG, PDF, EPS) entirely in the browser. Images are never uploaded anywhere.

It is built for logo work. Curves come out smooth instead of stair-stepped, corners stay sharp, straight edges stay straight, and colors snap to the logo's real palette instead of picking up in-between shades from anti-aliasing.

## Features

- **Automatic palette.** Colors are detected from solid areas. Edge pixels are judged as blends of the colors around them, so they don't add extra colors. You can also set the number of colors yourself.
- **Clean shapes.** Neighboring shapes share their boundaries exactly, so there are no gaps or overlaps between colors.
- **Thorough mode.** Every edge is fitted several ways, and the best-scoring version is kept.
- **Hard-edged art.** Pixel art and other un-smoothed images are rebuilt with a Potrace-style method, so their straight edges and corners come out clean.
- **Fix an area.** Drag a box over a problem spot and re-fit just those edges: smoother, sharper corners, closer to the pixels, or straighter.
- **Palette editing.** Recolor or hide any color. Remove background only removes the background color where it touches the image edge, so the same color inside the logo stays.
- **Layering.** Choose stacked shapes or exact cutouts, clean stroked outlines for even-width rings, and flat or true linear gradients.
- **Batch mode.** Open several logos at once, step through them, and download them all as one zip.
- **Real-world sizing.** Exports are scaled to fit a 10 × 8 in artboard (width × height).

## Running it

Retrace is a static site with no build step and no dependencies.

- **Locally:** open `index.html` in a browser, or serve the folder with any static server, for example `npx serve .`.
- **Netlify or GitHub Pages:** deploy the folder as-is. On Netlify you can drag the folder onto the deploy page.

The only external resource is the Schibsted Grotesk font from Google Fonts. Without it, the page falls back to the system font.

## Project structure

```
index.html              Page markup and script loading order
css/styles.css          UI styles (light and dark themes via CSS variables)
js/vtrace-engine.js     The vectorization engine (VTrace). No DOM access; also runs in Node.
js/image-prep.js        Pre-trace helpers: anti-aliasing detection and premultiplied upscaling
js/export-formats.js    PDF, EPS and ZIP writers
js/app.js               User interface: settings, preview, area fixes, batch mode, downloads
```

The scripts are plain classic scripts, not ES modules, so the page also works when opened straight from disk. Load order matters: the engine first, then the helpers, then `app.js`.

## How the engine works

`VTrace.trace()` runs these stages in order. The engine source is split into commented sections that follow the same order.

1. **Colors.** Pixels are converted to CIE Lab. Solid ("flat") pixels are clustered into the palette, then refined with k-means. Thin dark keylines that have no solid pixels can add a line color.
2. **Labels.** Each pixel gets a palette color. Ambiguous edge pixels are scored as a blend of nearby colors, and colors that are present nearby are preferred.
3. **Cleanup.** Anti-aliasing slivers, stray specks, stranded fragments of a foreign color and broken-off hairlines are folded into the right neighbors. Thin diagonal lines are kept connected.
4. **Boundaries.** Each edge between two regions is traced once and shared by both sides. Its sub-pixel position comes from the anti-aliasing coverage.
5. **Fitting.** Corners are found and refined to where their edges meet. Straight runs become lines, and the rest is fitted with cubic Beziers. Fully hard-edged outlines use a Potrace-style polygon fit instead. In Thorough mode each edge gets several candidate fits, graded on how closely they follow the pixels, how few nodes they use, and how smooth they are.
6. **Finishing.** Near-horizontal and near-vertical edges are squared up, nodes are merged, three-way junctions are smoothed, and gradients and even-width outlines are detected.

## Using the engine in Node

The engine has no dependencies and exports itself for CommonJS:

```js
const VTrace = require('./js/vtrace-engine.js');

// imageData: { width, height, data } where data is RGBA bytes (Uint8ClampedArray)
const result = await VTrace.trace(imageData, { passes: 6 });
const shapes = VTrace.shapes(result, 'stacked', new Set(), 1);
const svg = VTrace.toSVG(result, shapes, imageData.width, imageData.height);
```

Decode the PNG or JPG with any library you like, such as `pngjs` or `sharp`.

Useful `trace()` options:

| Option | Default | Meaning |
|---|---|---|
| `colors` | `0` (auto) | Fixed number of palette colors |
| `minArea` | `6` | Specks smaller than this many pixels are removed |
| `smoothness` | `1` | Curve smoothness multiplier |
| `cornerAngle` | `32` | Turn angle in degrees above which a bend becomes a corner |
| `straighten` | `0` | Square up edges within this many degrees of horizontal or vertical |
| `reduce` | `0` | Node reduction tolerance |
| `passes` | `1` | `6` enables Thorough mode |
| `unit` | `1` | Upscale factor already applied to the image, so tolerances scale with it |

## Limitations

- Linear gradients are detected, but radial gradients are not.
- Very small hard-edged text, under about 20 px tall, can come out slightly irregular.
- Images larger than 2800 px are scaled down before tracing, which takes several seconds on a very large logo.

## License

<!-- Choose a license (MIT is common for tools like this) and add a LICENSE file. -->
