import { spawnSync } from "node:child_process";

export const IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp"
]);
export const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".pdf"]);
export const MEDIA_TYPES_BY_EXTENSION = {
  ".gif": new Set(["image/gif"]),
  ".jpeg": new Set(["image/jpeg"]),
  ".jpg": new Set(["image/jpeg"]),
  ".pdf": new Set(["application/pdf"]),
  ".png": new Set(["image/png"]),
  ".svg": new Set(["image/svg+xml"]),
  ".webp": new Set(["image/webp"])
};

function parsePng(buffer) {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    unit: "pixels",
    source: "png-header"
  };
}

function parseGif(buffer) {
  if (buffer.length < 10) return null;
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
    unit: "pixels",
    source: "gif-header"
  };
}

function parseJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  const sizeMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (sizeMarkers.has(marker) && segmentLength >= 7) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
        unit: "pixels",
        source: "jpeg-header"
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readUint24LE(buffer, offset) {
  return (
    buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
  );
}

function parseWebp(buffer) {
  if (
    buffer.length < 30 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return null;
  }
  const format = buffer.subarray(12, 16).toString("ascii");
  if (format === "VP8X") {
    return {
      width: readUint24LE(buffer, 24) + 1,
      height: readUint24LE(buffer, 27) + 1,
      unit: "pixels",
      source: "webp-vp8x-header"
    };
  }
  if (format === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b1 = buffer[21];
    const b2 = buffer[22];
    const b3 = buffer[23];
    const b4 = buffer[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + ((b4 & 0x0f) << 10) + (b3 << 2) + ((b2 & 0xc0) >> 6),
      unit: "pixels",
      source: "webp-vp8l-header"
    };
  }
  if (format === "VP8 ") {
    const start = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (start >= 0 && start + 7 <= buffer.length) {
      return {
        width: buffer.readUInt16LE(start + 3) & 0x3fff,
        height: buffer.readUInt16LE(start + 5) & 0x3fff,
        unit: "pixels",
        source: "webp-vp8-header"
      };
    }
  }
  return null;
}

function parseSvg(buffer) {
  const text = buffer.subarray(0, 262_144).toString("utf8").trimStart();
  if (!/^<\?xml\b|^<svg\b/iu.test(text) || !/<svg\b/iu.test(text)) return null;
  const svgTag = text.match(/<svg\b[^>]*>/iu)?.[0] ?? "";
  const parseLength = (name) => {
    const match = svgTag.match(
      new RegExp(`\\b${name}=["']([0-9.]+)(?:px)?["']`, "iu")
    );
    return match ? Number.parseFloat(match[1]) : null;
  };
  let width = parseLength("width");
  let height = parseLength("height");
  if (!width || !height) {
    const viewBox = svgTag.match(
      /\bviewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/iu
    );
    if (viewBox) {
      width ||= Number.parseFloat(viewBox[1]);
      height ||= Number.parseFloat(viewBox[2]);
    }
  }
  if (!width || !height) return null;
  return { width, height, unit: "pixels", source: "svg-metadata" };
}

function parsePdf(buffer) {
  if (
    buffer.length < 5 ||
    buffer.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    return null;
  }
  const text = buffer.subarray(0, 1_048_576).toString("latin1");
  const mediaBox = text.match(
    /\/MediaBox\s*\[\s*(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s*\]/u
  );
  const pageMatches = text.match(/\/Type\s*\/Page\b/gu);
  if (!mediaBox) {
    return pageMatches
      ? { pages: pageMatches.length, unit: "points", source: "pdf-objects" }
      : null;
  }
  return {
    width: Math.abs(Number(mediaBox[3]) - Number(mediaBox[1])),
    height: Math.abs(Number(mediaBox[4]) - Number(mediaBox[2])),
    pages: pageMatches?.length,
    unit: "points",
    source: "pdf-mediabox"
  };
}

export function inspectBufferDimensions(buffer, extension = "") {
  const ext = extension.toLowerCase();
  if (ext === ".png") return parsePng(buffer);
  if (ext === ".gif") return parseGif(buffer);
  if (ext === ".jpg" || ext === ".jpeg") return parseJpeg(buffer);
  if (ext === ".webp") return parseWebp(buffer);
  if (ext === ".svg") return parseSvg(buffer);
  if (ext === ".pdf") return parsePdf(buffer);
  return null;
}

export function inspectWithAvailableTool(
  filePath,
  extension,
  runner = spawnSync
) {
  if (extension === ".pdf") {
    const result = runner("pdfinfo", [filePath], {
      encoding: "utf8",
      timeout: 10_000
    });
    if (result.status === 0) {
      const size = result.stdout.match(
        /Page size:\s*([0-9.]+)\s+x\s+([0-9.]+)\s+pts/iu
      );
      const pages = result.stdout.match(/Pages:\s*([0-9]+)/iu);
      if (size || pages) {
        return {
          width: size ? Number(size[1]) : undefined,
          height: size ? Number(size[2]) : undefined,
          pages: pages ? Number(pages[1]) : undefined,
          unit: "points",
          source: "pdfinfo"
        };
      }
    }
    return null;
  }

  const sips = runner(
    "sips",
    ["-g", "pixelWidth", "-g", "pixelHeight", filePath],
    { encoding: "utf8", timeout: 10_000 }
  );
  if (sips.status === 0) {
    const width = sips.stdout.match(/pixelWidth:\s*([0-9.]+)/iu);
    const height = sips.stdout.match(/pixelHeight:\s*([0-9.]+)/iu);
    if (width && height) {
      return {
        width: Number(width[1]),
        height: Number(height[1]),
        unit: "pixels",
        source: "sips"
      };
    }
  }

  const identify = runner("identify", ["-format", "%w %h", filePath], {
    encoding: "utf8",
    timeout: 10_000
  });
  if (identify.status === 0) {
    const match = identify.stdout.trim().match(/^([0-9.]+)\s+([0-9.]+)/u);
    if (match) {
      return {
        width: Number(match[1]),
        height: Number(match[2]),
        unit: "pixels",
        source: "imagemagick-identify"
      };
    }
  }
  return null;
}

export function detectMediaType(buffer) {
  if (parsePng(buffer)) return "image/png";
  if (parseGif(buffer)) return "image/gif";
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (parseSvg(buffer)) return "image/svg+xml";
  if (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    return "application/pdf";
  }
  return null;
}
