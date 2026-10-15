import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Rect, Line, Text as SvgText, G } from 'react-native-svg';
import { useThemeStore } from '../../state/themeStore';
import type { ReportDailyRow } from '@sms/core';

export interface ChartSvgProps {
  data: ReportDailyRow[];
  width?: number;
  height?: number;
}

export const ChartSvg: React.FC<ChartSvgProps> = ({
  data,
  width = 600,
  height = 260
}) => {
  const colors = useThemeStore((s) => s.colors);

  // Group data by day and category
  const daysMap = new Map<
    string,
    { msa: number; pi: number; leave: number; td: number; suite: number; total: number }
  >();

  for (const row of data) {
    let dayEntry = daysMap.get(row.day);
    if (!dayEntry) {
      dayEntry = { msa: 0, pi: 0, leave: 0, td: 0, suite: 0, total: 0 };
      daysMap.set(row.day, dayEntry);
    }
    if (row.roomType === 'SUITE') {
      dayEntry.suite += row.people;
    } else {
      if (row.category === 'MSA') dayEntry.msa += row.people;
      if (row.category === 'PI') dayEntry.pi += row.people;
      if (row.category === 'LEAVE') dayEntry.leave += row.people;
      if (row.category === 'TD') dayEntry.td += row.people;
      dayEntry.total += row.people;
    }
  }

  const days = Array.from(daysMap.keys()).sort();
  const maxTotal = Math.max(10, ...Array.from(daysMap.values()).map((d) => d.total));

  const paddingLeft = 40;
  const paddingBottom = 40;
  const paddingTop = 20;
  const paddingRight = 20;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;
  const barWidth = Math.max(12, Math.min(32, (chartWidth / (days.length || 1)) * 0.7));

  // Category palette
  const catColors = {
    msa: colors.navy,
    pi: colors.blue,
    leave: colors.green,
    td: colors.orange,
    suite: colors.saffron
  };

  return (
    <View style={styles.container}>
      <Svg width={width} height={height}>
        {/* Y-axis grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
          const y = paddingTop + chartHeight * (1 - pct);
          const val = Math.round(maxTotal * pct);
          return (
            <G key={idx}>
              <Line
                x1={paddingLeft}
                y1={y}
                x2={width - paddingRight}
                y2={y}
                stroke={colors.border}
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              <SvgText
                x={paddingLeft - 8}
                y={y + 4}
                fontSize="10"
                fill={colors.muted}
                textAnchor="end"
              >
                {val}
              </SvgText>
            </G>
          );
        })}

        {/* Stacked bars for each day */}
        {days.map((day, idx) => {
          const entry = daysMap.get(day)!;
          const x = paddingLeft + (idx + 0.5) * (chartWidth / days.length) - barWidth / 2;

          let currentY = paddingTop + chartHeight;

          const segments = [
            { count: entry.msa, color: catColors.msa },
            { count: entry.pi, color: catColors.pi },
            { count: entry.leave, color: catColors.leave },
            { count: entry.td, color: catColors.td }
          ];

          return (
            <G key={day}>
              {segments.map((seg, sIdx) => {
                if (seg.count <= 0) return null;
                const segHeight = (seg.count / maxTotal) * chartHeight;
                currentY -= segHeight;

                return (
                  <Rect
                    key={sIdx}
                    x={x}
                    y={currentY}
                    width={barWidth}
                    height={segHeight}
                    fill={seg.color}
                  />
                );
              })}

              {/* Day Label on X-axis */}
              <SvgText
                x={x + barWidth / 2}
                y={height - paddingBottom + 16}
                fontSize="9"
                fill={colors.muted}
                textAnchor="middle"
              >
                {day.substring(5)}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12
  }
});
