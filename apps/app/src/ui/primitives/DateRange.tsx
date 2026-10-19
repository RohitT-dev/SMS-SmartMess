import React from 'react';
import { View, Text, TextInput, StyleSheet, Platform, Pressable } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';
import { isValidDateString } from '../../lib/dates';
import { Icon } from './Icon';
import { CalendarPickerModal } from './CalendarPickerModal';

export interface DateRangeProps {
  label?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  onStartDateChange?: (date: string) => void;
  onEndDateChange?: (date: string) => void;
  disabled?: boolean;
  error?: string;
  startLabel?: string;
  endLabel?: string;
  /** Both dates are included in the range (reports); default is a stay: check-out day excluded. */
  inclusive?: boolean;
  /** Hide the "N nights · check-out morning is free" note (it only makes sense for a stay). */
  hideNights?: boolean;
}

export interface DateInputProps {
  value: string;
  onChange?: (v: string) => void;
  accessibilityLabel: string;
  disabled: boolean;
  hasError: boolean;
}

/** Native date picker on web; plain YYYY-MM-DD text input on native. */
export const DateInput: React.FC<DateInputProps> = ({ value, onChange, accessibilityLabel, disabled, hasError }) => {
  const colors = useThemeStore((s) => s.colors);
  const isDark = useThemeStore((s) => s.isDark);
  const borderColor = hasError ? colors.red : colors.borderStrong;

  if (Platform.OS === 'web') {
    return React.createElement('input', {
      type: 'date',
      value,
      disabled: disabled || !onChange,
      'aria-label': accessibilityLabel,
      onChange: (e: { target: { value: string } }) => onChange?.(e.target.value),
      style: {
        height: layout.minTouchTarget,
        width: '100%',
        boxSizing: 'border-box',
        border: `${layout.borderWidth}px solid ${borderColor}`,
        borderRadius: layout.borderRadius,
        padding: `0 ${spacing.sm}px`,
        fontSize: typography.sm,
        fontFamily: 'inherit',
        color: colors.text,
        backgroundColor: disabled ? colors.greySoft : colors.surface,
        colorScheme: isDark ? 'dark' : 'light',
      },
    });
  }

  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder="YYYY-MM-DD"
      placeholderTextColor={colors.muted}
      editable={!disabled && !!onChange}
      accessibilityLabel={accessibilityLabel}
      keyboardType="numbers-and-punctuation"
      style={[
        styles.input,
        { backgroundColor: disabled ? colors.greySoft : colors.surface, borderColor, color: colors.text },
      ]}
    />
  );
};

export const DateRange: React.FC<DateRangeProps> = ({
  label,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  disabled = false,
  error,
  startLabel = 'Check-In (12:00 PM)',
  endLabel = 'Check-Out (12:00 PM)',
  inclusive = false,
  hideNights = false
}) => {
  const colors = useThemeStore((s) => s.colors);
  const [calendarOpen, setCalendarOpen] = React.useState(false);

  // Built-in validation so every screen shows the same message for bad ranges.
  const startOk = isValidDateString(startDate);
  const endOk = isValidDateString(endDate);
  let derivedError = error;
  let nights = 0;
  if (!derivedError) {
    if (!startOk || !endOk) derivedError = 'Enter both dates as YYYY-MM-DD.';
    else if (inclusive ? endDate < startDate : endDate <= startDate)
      derivedError = inclusive ? 'The end date can’t be before the start date.' : 'Check-out must be after check-in.';
    else nights = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000);
  }

  return (
    <View style={styles.container}>
      {label && <Text style={[styles.label, { color: colors.navy }]}>{label}</Text>}
      <View style={styles.inputsRow}>
        <View style={styles.inputWrapper}>
          <Text style={[styles.subLabel, { color: colors.muted }]}>{startLabel}</Text>
          <DateInput
            value={startDate}
            onChange={onStartDateChange}
            accessibilityLabel={`${startLabel} date`}
            disabled={disabled}
            hasError={!!derivedError}
          />
        </View>

        <Text style={[styles.toSeparator, { color: colors.muted }]}>to</Text>

        <View style={styles.inputWrapper}>
          <Text style={[styles.subLabel, { color: colors.muted }]}>{endLabel}</Text>
          <DateInput
            value={endDate}
            onChange={onEndDateChange}
            accessibilityLabel={`${endLabel} date`}
            disabled={disabled}
            hasError={!!derivedError}
          />
        </View>

        <Pressable
          onPress={() => setCalendarOpen(true)}
          disabled={disabled}
          style={({ pressed }) => [
            styles.calendarButton,
            {
              backgroundColor: pressed ? colors.greySoft : colors.surfaceAlt,
              borderColor: derivedError ? colors.red : colors.borderStrong,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Open visual calendar picker"
        >
          <Icon name="calendar" size={18} color={colors.navy} />
        </Pressable>
      </View>

      <CalendarPickerModal
        visible={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        startDate={startDate}
        endDate={endDate}
        onApply={(s, e) => {
          onStartDateChange?.(s);
          onEndDateChange?.(e);
        }}
        allowPastDates={inclusive}
      />

      {derivedError ? (
        <Text style={[styles.error, { color: colors.red }]} accessibilityRole="alert">
          {derivedError}
        </Text>
      ) : nights > 0 && !inclusive && !hideNights ? (
        <Text style={[styles.subLabel, { color: colors.muted, marginTop: spacing.xs }]}>
          {nights} night{nights === 1 ? '' : 's'} · 12:00 PM check-in → 12:00 PM check-out (same-day check-in available from 12:00 PM)
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.xs
  },
  inputsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  inputWrapper: {
    flex: 1
  },
  subLabel: {
    fontSize: typography.xs,
    marginBottom: 2
  },
  toSeparator: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium,
    marginTop: 14
  },
  input: {
    height: layout.minTouchTarget,
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    paddingHorizontal: spacing.sm,
    fontSize: typography.sm
  },
  error: {
    fontSize: typography.xs,
    marginTop: spacing.xs
  },
  calendarButton: {
    height: layout.minTouchTarget,
    width: layout.minTouchTarget,
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
  },
});
