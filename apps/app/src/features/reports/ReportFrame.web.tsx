import React, { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { pageGeometry, type ReportDocument } from './reportDocument';

/**
 * Web preview: the actual report document in an isolated iframe. It is script-less (sandboxed,
 * with its own CSP), so it shows exactly what will be printed and nothing from the app.
 */
export function ReportFrame({ doc }: { doc: ReportDocument }) {
  const { height: windowHeight } = useWindowDimensions();
  const [width, setWidth] = useState(0);

  const sheetWidth = pageGeometry(doc.orientation).width + 32;
  const viewportHeight = Math.max(420, windowHeight - 300);
  // Shrink (never enlarge) the sheet to the space available; the frame scrolls vertically.
  const scale = width > 0 ? Math.min(1, width / sheetWidth) : 1;

  return (
    <View
      style={{ width: '100%', height: viewportHeight, overflow: 'hidden', backgroundColor: '#DDE2E8' }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      <iframe
        title={doc.title}
        srcDoc={doc.html}
        sandbox="allow-same-origin"
        style={{
          border: 0,
          width: sheetWidth,
          height: viewportHeight / scale,
          transform: `scale(${scale})`,
          transformOrigin: '0 0',
          marginLeft: Math.max(0, (width - sheetWidth * scale) / 2),
          display: 'block',
        }}
      />
    </View>
  );
}
