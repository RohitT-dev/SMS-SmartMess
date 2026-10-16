import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';
import { Icon, IconName } from './Icon';

export interface AuthScreenProps {
  title: string;
  subtitle?: string;
  icon?: IconName;
  maxWidth?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/**
 * Shared shell for the (auth) screens: safe-area aware, scrolls when the
 * keyboard is open on phones, and centers a fixed-width card on larger screens.
 */
export const AuthScreen: React.FC<AuthScreenProps> = ({
  title,
  subtitle,
  icon,
  maxWidth = 440,
  children,
  footer,
}) => {
  const colors = useThemeStore((s) => s.colors);
  const { width } = useWindowDimensions();
  const isCompact = width < layout.phoneBreakpoint;

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: colors.bg }]}
      edges={['top', 'bottom']}
    >
      <View style={[styles.saffronAccent, { backgroundColor: colors.saffron }]} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { padding: isCompact ? spacing.md : spacing.lg },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.content, { maxWidth }]}>
            <View style={[styles.header, { marginBottom: isCompact ? spacing.lg : spacing.xl }]}>
              {icon ? (
                <View style={[styles.iconWrap, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <Icon name={icon} size={24} color={colors.navy} />
                </View>
              ) : null}
              <Text
                style={[
                  styles.title,
                  { color: colors.navy, fontSize: isCompact ? typography.lg + 2 : typography.xl },
                ]}
                accessibilityRole="header"
              >
                {title}
              </Text>
              {subtitle ? (
                <Text style={[styles.subtitle, { color: colors.muted }]}>{subtitle}</Text>
              ) : null}
            </View>
            {children}
            {footer}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  saffronAccent: {
    height: 4,
    width: '100%',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    width: '100%',
  },
  header: {
    alignItems: 'center',
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: layout.borderWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: {
    fontWeight: typography.weights.bold,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
});
