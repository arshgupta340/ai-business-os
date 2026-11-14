'use client';

import {useMemo} from 'react';
import QRCode from 'qrcode';

/** The QR modules as one SVG path, with a 4 module quiet zone. Exported for tests. */
export function qrPath(text: string): {size: number; path: string} {
  const {modules} = QRCode.create(text, {errorCorrectionLevel: 'M'});
  const quiet = 4;
  let path = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.data[row * modules.size + col]) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return {size: modules.size + quiet * 2, path};
}

/**
 * A scannable QR code. Dark modules on a light ground in both themes
 * (--color-on-light and --color-on-dark do not change with the mode), because
 * some phone scanners do not read an inverted code.
 */
export function QrCode({text, label, size = 280}: {text: string; label: string; size?: number}) {
  const qr = useMemo(() => qrPath(text), [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="var(--color-on-dark)" />
      <path d={qr.path} fill="var(--color-on-light)" />
    </svg>
  );
}
