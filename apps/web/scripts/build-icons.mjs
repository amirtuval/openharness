// Generate the raster icons from `public/favicon.svg`: `favicon.ico` (16 + 32 px, the light
// variant) and `apple-touch-icon.png` (180 px, opaque, on the light page colour).
//
// Run by hand, from `apps/web`, with `yarn icons`. The three files it writes are committed, so
// the build and CI never run this and never need the rasterizer — the dependency is a
// devDependency for that reason alone. Re-run it when the mark's geometry or colour changes.
//
// The mark itself has one source: `public/favicon.svg`. This script reads it and strips the
// dark-scheme `<style>`, which leaves the light variant — the media query is the only
// difference between the two, so the raster files cannot go stale against the SVG.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const source = readFileSync(path.join(publicDir, 'favicon.svg'), 'utf8')

/** The sizes the `.ico` carries — a favicon at the tab's two usual steps. */
const ICO_SIZES = [16, 32]
const APPLE_SIZE = 180
/** The share of the apple-touch icon the mark takes; the rest is the page colour around it. */
const APPLE_MARK_SHARE = 0.7
/**
 * `--background` in Light, the sRGB of `oklch(0.975 0.0134 295.3)` (src/index.css). iOS wants
 * an opaque square, and the page's own faint violet is what the mark sits on everywhere else.
 */
const APPLE_BACKGROUND = '#F7F5FF'

/** The mark's markup alone: the `<svg>` children, without the dark-scheme `<style>`. */
const mark = source
  .slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'))
  .replace(/<style>[\s\S]*?<\/style>/g, '')
  .trim()

/** The mark's own square, read off the favicon so a change there is not a second copy here. */
const [, , MARK_WIDTH] = /viewBox="([^"]+)"/.exec(source)[1].split(/\s+/u).map(Number)

/** The mark as a standalone SVG at `size`, in the coordinate space the favicon declares. */
function sizedMark(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${MARK_WIDTH} ${MARK_WIDTH}">${mark}</svg>`
}

/** The mark centred on an opaque square, at `APPLE_MARK_SHARE` of it. */
function appleTouchIcon() {
  const drawn = APPLE_SIZE * APPLE_MARK_SHARE
  const offset = (APPLE_SIZE - drawn) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${APPLE_SIZE}" height="${APPLE_SIZE}" viewBox="0 0 ${APPLE_SIZE} ${APPLE_SIZE}"><rect width="${APPLE_SIZE}" height="${APPLE_SIZE}" fill="${APPLE_BACKGROUND}"/><g transform="translate(${offset} ${offset}) scale(${drawn / MARK_WIDTH})">${mark}</g></svg>`
}

/** Rasterize an SVG string to a PNG buffer at its declared `width`/`height`. */
function png(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/**
 * An `.ico` holding PNGs: a 6-byte header, one 16-byte directory entry per image, then the
 * images. Every browser that has read PNG-in-ICO since Vista does — which is all of them — so
 * there is no BMP encoding here. 16 and 32 both fit a byte; 256, which would be written as 0,
 * is not a size this file carries.
 */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length
  images.forEach(({ size, data }, index) => {
    const entry = 16 * index
    directory.writeUInt8(size, entry)
    directory.writeUInt8(size, entry + 1)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })

  return Buffer.concat([header, directory, ...images.map(({ data }) => data)])
}

const images = await Promise.all(
  ICO_SIZES.map(async (size) => ({ size, data: await png(sizedMark(size)) })),
)
writeFileSync(path.join(publicDir, 'favicon.ico'), ico(images))
// Flattened, not just filled: the background rect already covers the square, and dropping the
// alpha channel is what makes the PNG opaque rather than merely looking it.
writeFileSync(
  path.join(publicDir, 'apple-touch-icon.png'),
  await sharp(Buffer.from(appleTouchIcon()))
    .flatten({ background: APPLE_BACKGROUND })
    .png()
    .toBuffer(),
)
console.log(`wrote favicon.ico (${ICO_SIZES.join(' + ')} px) and apple-touch-icon.png`)
