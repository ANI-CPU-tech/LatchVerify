import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ICON_GRID, ICON_ICO_SIZES, ICON_PALETTE, ICON_PNG_SIZES, iconIco, iconPixels, iconPng, iconSvg } from "../../scripts/package/icon.js";
import { PNG_SIGNATURE, crc32, encodePng } from "../../scripts/package/png.js";

/** Splits a PNG into chunks, checking every CRC. */
function chunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  const out: Array<{ type: string; data: Buffer }> = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    expect(png.readUInt32BE(at + 8 + length), `${type} CRC`).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    out.push({ type, data });
    at += 12 + length;
  }
  return out;
}

describe("PNG encoder", () => {
  it("matches the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("writes IHDR, IDAT and IEND with valid CRCs and the pixels it was given", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]);
    const parts = chunks(encodePng(2, 1, rgba));
    expect(parts.map((p) => p.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(parts[0]!.data.readUInt32BE(0)).toBe(2);
    expect(parts[0]!.data.readUInt32BE(4)).toBe(1);
    expect([...inflateSync(parts[1]!.data)]).toEqual([0, ...rgba]);
  });

  it("rejects a buffer of the wrong size", () => {
    expect(() => encodePng(2, 2, new Uint8Array(4))).toThrow(RangeError);
  });
});

describe("app icon", () => {
  it("is a 16x16 grid using only palette colors", () => {
    expect(ICON_GRID).toHaveLength(16);
    for (const row of ICON_GRID) {
      expect(row).toHaveLength(16);
      for (const cell of row) expect(cell === "." || cell in ICON_PALETTE, cell).toBe(true);
    }
  });

  it("renders every PNG size with crisp, whole-pixel scaling", () => {
    for (const size of ICON_PNG_SIZES) {
      const ihdr = chunks(iconPng(size))[0]!.data;
      expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)]).toEqual([size, size]);
    }
    const small = iconPixels(16);
    const big = iconPixels(64);
    // Each 16px pixel becomes a 4x4 block of the same color.
    for (const [x, y] of [[5, 1], [8, 9], [0, 0]] as const) {
      const at16 = (y * 16 + x) * 4;
      const at64 = ((y * 4 + 3) * 64 + x * 4 + 3) * 4;
      expect([...big.subarray(at64, at64 + 4)]).toEqual([...small.subarray(at16, at16 + 4)]);
    }
    expect(() => iconPixels(20)).toThrow(RangeError);
  });

  it("packs PNGs into a Windows .ico", () => {
    const ico = iconIco();
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(ICON_ICO_SIZES.length);
    ICON_ICO_SIZES.forEach((size, i) => {
      const entry = 6 + 16 * i;
      expect(ico[entry] === 0 ? 256 : ico[entry]).toBe(size);
      const offset = ico.readUInt32LE(entry + 12);
      expect(ico.subarray(offset, offset + 8)).toEqual(PNG_SIGNATURE);
    });
  });

  it("is the web UI's favicon", () => {
    expect(readFileSync(new URL("../../web/public/favicon.svg", import.meta.url), "utf8")).toBe(iconSvg());
  });
});
