import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
} from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';
import { Icon } from './Icon';
import { Button } from './Button';
import {
  addDaysToDateString,
  isValidDateString,
  localDateString,
} from '../../lib/dates';

export interface CalendarPickerModalProps {
  visible: boolean;
  onClose: () => void;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  onApply: (start: string, end: string) => void;
  title?: string;
  allowPastDates?: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function formatDateString(year: number, monthIndex: number, day: number): string {
  const m = String(monthIndex + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

function parseYearMonth(dateStr: string): { year: number; month: number } {
  if (isValidDateString(dateStr)) {
    const parts = dateStr.split('-');
    return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) - 1 };
  }
  const today = new Date();
  return { year: today.getFullYear(), month: today.getMonth() };
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function calcNights(start: string, end: string): number {
  if (!isValidDateString(start) || !isValidDateString(end) || end <= start) return 0;
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  return Math.round((e - s) / 86400000);
}

export const CalendarPickerModal: React.FC<CalendarPickerModalProps> = ({
  visible,
  onClose,
  startDate,
  endDate,
  onApply,
  title = 'Select Stay Dates',
  allowPastDates = false,
}) => {
  const colors = useThemeStore((s) => s.colors);
  const todayStr = localDateString();

  const [selectedStart, setSelectedStart] = useState<string>(startDate || todayStr);
  const [selectedEnd, setSelectedEnd] = useState<string>(endDate || addDaysToDateString(todayStr, 2));

  // Current calendar view (year & month)
  const [viewYearMonth, setViewYearMonth] = useState(() =>
    parseYearMonth(startDate || todayStr)
  );

  // Synchronize when opening
  React.useEffect(() => {
    if (visible) {
      setSelectedStart(startDate || todayStr);
      setSelectedEnd(endDate || addDaysToDateString(todayStr, 2));
      setViewYearMonth(parseYearMonth(startDate || todayStr));
    }
  }, [visible, startDate, endDate, todayStr]);

  const handlePrevMonth = () => {
    setViewYearMonth((prev) => {
      if (prev.month === 0) return { year: prev.year - 1, month: 11 };
      return { year: prev.year, month: prev.month - 1 };
    });
  };

  const handleNextMonth = () => {
    setViewYearMonth((prev) => {
      if (prev.month === 11) return { year: prev.year + 1, month: 0 };
      return { year: prev.year, month: prev.month + 1 };
    });
  };

  const handleDatePress = (dateStr: string) => {
    if (!allowPastDates && dateStr < todayStr) return;

    if (!selectedStart || (selectedStart && selectedEnd)) {
      // First click: select check-in
      setSelectedStart(dateStr);
      setSelectedEnd('');
    } else {
      // Second click: select check-out
      if (dateStr > selectedStart) {
        setSelectedEnd(dateStr);
      } else if (dateStr === selectedStart) {
        // Same day click defaults to 1 night stay
        setSelectedEnd(addDaysToDateString(dateStr, 1));
      } else {
        // Clicked date is earlier than start: set as new start
        setSelectedStart(dateStr);
        setSelectedEnd('');
      }
    }
  };

  const handlePreset = (nights: number) => {
    const base = selectedStart || todayStr;
    const start = (!allowPastDates && base < todayStr) ? todayStr : base;
    setSelectedStart(start);
    setSelectedEnd(addDaysToDateString(start, nights));
  };

  const handleApply = () => {
    if (isValidDateString(selectedStart) && isValidDateString(selectedEnd) && selectedEnd > selectedStart) {
      onApply(selectedStart, selectedEnd);
      onClose();
    } else if (isValidDateString(selectedStart)) {
      const defaultEnd = addDaysToDateString(selectedStart, 1);
      onApply(selectedStart, defaultEnd);
      onClose();
    }
  };

  const daysInMonth = getDaysInMonth(viewYearMonth.year, viewYearMonth.month);
  const firstDay = getFirstDayOfWeek(viewYearMonth.year, viewYearMonth.month);
  const nights = calcNights(selectedStart, selectedEnd);

  // Build grid items
  const calendarCells = useMemo(() => {
    const cells: Array<{ type: 'empty'; key: string } | { type: 'day'; dateStr: string; dayNum: number; key: string }> = [];
    for (let i = 0; i < firstDay; i++) {
      cells.push({ type: 'empty', key: `empty-${i}` });
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = formatDateString(viewYearMonth.year, viewYearMonth.month, day);
      cells.push({ type: 'day', dateStr, dayNum: day, key: dateStr });
    }
    return cells;
  }, [viewYearMonth.year, viewYearMonth.month, daysInMonth, firstDay]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View>
              <Text style={[styles.title, { color: colors.navy }]}>{title}</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                {selectedStart && selectedEnd ? (
                  `${selectedStart} to ${selectedEnd} (${nights} night${nights === 1 ? '' : 's'})`
                ) : selectedStart ? (
                  `Check-In: ${selectedStart} · Select Check-Out date`
                ) : (
                  'Select Check-In Date'
                )}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={12}
              style={[styles.closeButton, { backgroundColor: colors.greySoft }]}
              accessibilityLabel="Close calendar"
            >
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>✕</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            {/* Quick Presets */}
            <View style={styles.presetsRow}>
              <Pressable
                onPress={() => handlePreset(1)}
                style={[styles.presetChip, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
              >
                <Text style={[styles.presetText, { color: colors.text }]}>1 Night</Text>
              </Pressable>
              <Pressable
                onPress={() => handlePreset(2)}
                style={[styles.presetChip, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
              >
                <Text style={[styles.presetText, { color: colors.text }]}>2 Nights</Text>
              </Pressable>
              <Pressable
                onPress={() => handlePreset(3)}
                style={[styles.presetChip, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
              >
                <Text style={[styles.presetText, { color: colors.text }]}>3 Nights</Text>
              </Pressable>
              <Pressable
                onPress={() => handlePreset(7)}
                style={[styles.presetChip, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
              >
                <Text style={[styles.presetText, { color: colors.text }]}>1 Week</Text>
              </Pressable>
            </View>

            {/* Month Navigation */}
            <View style={styles.navRow}>
              <Pressable
                onPress={handlePrevMonth}
                style={[styles.navButton, { backgroundColor: colors.greySoft }]}
                accessibilityLabel="Previous month"
              >
                <Icon name="back" size={16} color={colors.text} />
              </Pressable>
              <Text style={[styles.monthLabel, { color: colors.navy }]}>
                {MONTH_NAMES[viewYearMonth.month]} {viewYearMonth.year}
              </Text>
              <Pressable
                onPress={handleNextMonth}
                style={[styles.navButton, { backgroundColor: colors.greySoft }]}
                accessibilityLabel="Next month"
              >
                <Icon name="chevron" size={16} color={colors.text} />
              </Pressable>
            </View>

            {/* Day of Week Row */}
            <View style={styles.weekRow}>
              {DAY_LABELS.map((d) => (
                <View key={d} style={styles.weekCol}>
                  <Text style={[styles.weekLabel, { color: colors.muted }]}>{d}</Text>
                </View>
              ))}
            </View>

            {/* Calendar Days Grid */}
            <View style={styles.grid}>
              {calendarCells.map((cell) => {
                if (cell.type === 'empty') {
                  return <View key={cell.key} style={styles.dayCol} />;
                }

                const { dateStr, dayNum } = cell;
                const isStart = dateStr === selectedStart;
                const isEnd = dateStr === selectedEnd;
                const isInRange =
                  Boolean(selectedStart && selectedEnd && dateStr > selectedStart && dateStr < selectedEnd);
                const isPast = !allowPastDates && dateStr < todayStr;
                const isToday = dateStr === todayStr;

                return (
                  <Pressable
                    key={cell.key}
                    onPress={() => handleDatePress(dateStr)}
                    disabled={isPast}
                    style={[
                      styles.dayCol,
                      isInRange && { backgroundColor: `${colors.navy}18` },
                      isStart && selectedEnd && { borderTopLeftRadius: 18, borderBottomLeftRadius: 18, backgroundColor: `${colors.navy}25` },
                      isEnd && selectedStart && { borderTopRightRadius: 18, borderBottomRightRadius: 18, backgroundColor: `${colors.navy}25` },
                    ]}
                  >
                    <View
                      style={[
                        styles.dayCircle,
                        (isStart || isEnd) && { backgroundColor: colors.navy },
                        isToday && !isStart && !isEnd && { borderWidth: 1.5, borderColor: colors.saffron },
                      ]}
                    >
                      <Text
                        style={[
                          styles.dayText,
                          { color: colors.text },
                          (isStart || isEnd) && { color: '#FFFFFF', fontWeight: '700' },
                          isPast && { color: colors.borderStrong, opacity: 0.5 },
                        ]}
                      >
                        {dayNum}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          {/* Footer Actions */}
          <View style={[styles.footer, { borderTopColor: colors.border }]}>
            <Button
              label="Cancel"
              variant="secondary"
              onPress={onClose}
              style={{ flex: 1 }}
            />
            <Button
              label={nights > 0 ? `Apply (${nights} nights)` : 'Apply Dates'}
              variant="primary"
              onPress={handleApply}
              disabled={!selectedStart || (!selectedEnd && !selectedStart)}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    borderRadius: layout.borderRadius * 1.5,
    borderWidth: layout.borderWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
    maxHeight: '90%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: spacing.md,
    borderBottomWidth: layout.borderWidth,
  },
  title: {
    fontSize: typography.md,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: typography.xs,
    marginTop: 2,
  },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: spacing.md,
  },
  presetsRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.md,
    justifyContent: 'space-between',
  },
  presetChip: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: layout.borderRadius,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetText: {
    fontSize: 11,
    fontWeight: '600',
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  navButton: {
    width: 32,
    height: 32,
    borderRadius: layout.borderRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthLabel: {
    fontSize: typography.sm,
    fontWeight: '700',
  },
  weekRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  weekCol: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
  },
  weekLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCol: {
    width: `${100 / 7}%`,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: {
    fontSize: typography.sm,
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: layout.borderWidth,
  },
});
