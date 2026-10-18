import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Button } from '../../../src/ui/primitives/Button';
import { Badge } from '../../../src/ui/primitives/Badge';
import { DateRange } from '../../../src/ui/primitives/DateRange';
import { Banner } from '../../../src/ui/primitives/Banner';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { useRoomNames } from '../../../src/features/rooms/useRoomNames';
import {
  addDaysToDateString,
  isValidDateString,
  localDateString,
} from '../../../src/lib/dates';
import {
  exportGridPdf,
  type GridPdfDayState,
  type GridPdfOccupant,
  type GridPdfRoom,
} from '../../../src/features/reports/gridPdfGenerator';
import { isRoomHeldExclusive, occupantLines } from '../../../src/features/reports/gridHtml';
import { enrichDayStates, idsKey, occupantBookingIds } from '../../../src/features/reports/gridGuests';
import { fetchGridGuests } from '../../../src/features/reports/reportData';

interface CellModalData {
  roomId: string;
  roomName: string;
  roomType: string;
  date: string;
  isClosed: boolean;
  /** One occupant whose booking does not allow sharing: the room has no free second bed. */
  isHeld: boolean;
  occupants: GridPdfOccupant[];
}

const STAY_COLORS = {
  MFA: { bg: '#FFEBEE', border: '#EF9A9A', text: '#C62828', darkText: '#B71C1C' },
  LEAVE: { bg: '#FFF3E0', border: '#FFCC80', text: '#E65100', darkText: '#BF360C' },
  TD: { bg: '#FFFDE7', border: '#FFF59D', text: '#F57F17', darkText: '#E65100' },
  PI: { bg: '#E3F2FD', border: '#90CAF9', text: '#1565C0', darkText: '#0D47A1' },
  VACANT: { bg: '#E8F5E9', border: '#A5D6A7', text: '#2E7D32', darkText: '#1B5E20' },
  CLOSED: { bg: '#EEEEEE', border: '#BDBDBD', text: '#616161', darkText: '#424242' },
};

export default function RoomOccupancyGridScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const { data: roomNames } = useRoomNames();

  const todayStr = localDateString();
  const [fromDate, setFromDate] = useState(todayStr);
  const [toDateInclusive, setToDateInclusive] = useState(addDaysToDateString(todayStr, 6)); // Default 7 days
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [modalData, setModalData] = useState<CellModalData | null>(null);

  // Validate range
  const rangeValid =
    isValidDateString(fromDate) &&
    isValidDateString(toDateInclusive) &&
    toDateInclusive >= fromDate;

  // daily_room_state RPC takes an exclusive upper date bound
  const toDateRpc = rangeValid ? addDaysToDateString(toDateInclusive, 1) : toDateInclusive;

  // Presets
  const setPreset = (days: number) => {
    const start = localDateString();
    setFromDate(start);
    setToDateInclusive(addDaysToDateString(start, days - 1));
  };

  const setMonthPreset = () => {
    const now = new Date();
    const firstDay = localDateString(new Date(now.getFullYear(), now.getMonth(), 1));
    const lastDay = localDateString(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    setFromDate(firstDay);
    setToDateInclusive(lastDay);
  };

  // 1. Fetch rooms list
  const {
    data: roomsData,
    isLoading: roomsLoading,
    refetch: refetchRooms,
  } = useQuery({
    queryKey: ['active_rooms_grid'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rooms')
        .select('id, room_type, display_order, is_active')
        .eq('is_active', true)
        .order('display_order', { ascending: true });
      if (error) throw error;
      return (data || []) as Array<{ id: string; room_type: string; display_order: number }>;
    },
  });

  // 2. Fetch daily room states for range
  const {
    data: dayStates,
    isLoading: statesLoading,
    refetch: refetchDayStates,
  } = useQuery({
    queryKey: ['daily_room_state_grid', fromDate, toDateRpc],
    enabled: rangeValid,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('daily_room_state', {
        p_from: fromDate,
        p_to: toDateRpc,
      });
      if (error) throw error;
      return (data || []) as GridPdfDayState[];
    },
  });

  const queryClient = useQueryClient();

  // daily_room_state returns guest codes only; attach names, full ranks, units and service numbers.
  const bookingIds = useMemo(() => occupantBookingIds(dayStates), [dayStates]);
  const { data: guestData } = useQuery({
    queryKey: ['grid_guests', idsKey(bookingIds)],
    enabled: bookingIds.length > 0,
    queryFn: () => fetchGridGuests(bookingIds),
  });
  const richDayStates = useMemo(
    () => enrichDayStates(dayStates || [], guestData?.guests ?? [], guestData?.pii),
    [dayStates, guestData],
  );

  // Auto-refresh when grid screen is focused
  useFocusEffect(
    useCallback(() => {
      refetchRooms();
      refetchDayStates();
    }, [refetchRooms, refetchDayStates])
  );

  // Realtime subscription for allocations, bookings, and rooms
  const channelNameRef = useRef(`grid-realtime-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const channel = supabase
      .channel(channelNameRef.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'allocations' }, () => {
        refetchDayStates();
        queryClient.invalidateQueries({ queryKey: ['daily_room_state_grid'] });
        queryClient.invalidateQueries({ queryKey: ['active_rooms_grid'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => {
        refetchDayStates();
        queryClient.invalidateQueries({ queryKey: ['daily_room_state_grid'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_guests' }, () => {
        queryClient.invalidateQueries({ queryKey: ['grid_guests'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, () => {
        refetchRooms();
        refetchDayStates();
        queryClient.invalidateQueries({ queryKey: ['active_rooms_grid'] });
        queryClient.invalidateQueries({ queryKey: ['daily_room_state_grid'] });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, refetchRooms, refetchDayStates]);

  // Calculate unique ordered dates list
  const datesList = useMemo(() => {
    if (!rangeValid) return [];
    const list: string[] = [];
    let cur = new Date(fromDate + 'T00:00:00Z');
    const end = new Date(toDateInclusive + 'T00:00:00Z');
    while (cur <= end) {
      list.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return list;
  }, [fromDate, toDateInclusive, rangeValid]);

  // Map state by `${date}_${room_id}`
  const stateLookup = useMemo(() => {
    const map = new Map<string, GridPdfDayState>();
    richDayStates.forEach((st) => {
      map.set(`${st.date}_${st.room_id}`, st);
    });
    return map;
  }, [richDayStates]);

  // Prepared rooms with decrypted names
  const preparedRooms: GridPdfRoom[] = useMemo(() => {
    return (roomsData || []).map((r) => ({
      id: r.id,
      name: roomNames?.[r.id] ?? `Room ${r.display_order}`,
      roomType: r.room_type,
      displayOrder: r.display_order,
    }));
  }, [roomsData, roomNames]);

  // Handle PDF Export
  const handleDownloadPdf = async () => {
    if (!preparedRooms.length || !dayStates) return;
    setIsExporting(true);
    setExportError(null);
    try {
      await exportGridPdf({
        fromDate,
        toDate: toDateInclusive,
        rooms: preparedRooms,
        dayStates: richDayStates,
      });
    } catch (err: any) {
      setExportError(err?.message ?? 'Failed to export PDF');
    } finally {
      setIsExporting(false);
    }
  };

  const isLoading = roomsLoading || statesLoading;

  return (
    <Screen title="Room Occupancy Grid Matrix" showBack={true}>
      {/* 1. Date Range Controls & PDF Action */}
      <Card style={{ marginBottom: spacing.md }}>
        <View style={styles.presetsRow}>
          <Text style={[styles.controlLabel, { color: colors.muted }]}>Quick Range:</Text>
          <Button label="7 Days" variant="secondary" onPress={() => setPreset(7)} />
          <Button label="14 Days" variant="secondary" onPress={() => setPreset(14)} />
          <Button label="30 Days" variant="secondary" onPress={() => setPreset(30)} />
          <Button label="This Month" variant="secondary" onPress={setMonthPreset} />
        </View>

        <View style={styles.datePickerRow}>
          <View style={{ flex: 1 }}>
            <DateRange
              label="Custom Date Range (Y-Axis: Dates)"
              startDate={fromDate}
              endDate={toDateInclusive}
              onStartDateChange={setFromDate}
              onEndDateChange={setToDateInclusive}
              inclusive={true}
              hideNights={true}
            />
          </View>
          <View style={styles.pdfButtonContainer}>
            <Button
              label={isExporting ? 'Preparing…' : 'Preview / PDF'}
              variant="primary"
              disabled={isExporting || isLoading || !rangeValid}
              onPress={handleDownloadPdf}
            />
          </View>
        </View>

        {exportError && <Banner type="error" message={exportError} />}
        {!rangeValid && (
          <Banner type="warning" message="Please enter a valid start and end date." />
        )}
      </Card>

      {/* 2. Color Code Legend */}
      <Card style={styles.legendCard}>
        <Text style={[styles.legendTitle, { color: colors.navy }]}>
          Stay Type Color Legend:
        </Text>
        <View style={styles.legendItemsWrap}>
          <View style={styles.legendItem}>
            <View style={[styles.colorBox, { backgroundColor: STAY_COLORS.MFA.bg, borderColor: STAY_COLORS.MFA.border }]} />
            <Text style={[styles.legendText, { color: colors.text }]}>MFA (BA MFA) - Red</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.colorBox, { backgroundColor: STAY_COLORS.LEAVE.bg, borderColor: STAY_COLORS.LEAVE.border }]} />
            <Text style={[styles.legendText, { color: colors.text }]}>LEAVE (On Leave) - Orange</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.colorBox, { backgroundColor: STAY_COLORS.TD.bg, borderColor: STAY_COLORS.TD.border }]} />
            <Text style={[styles.legendText, { color: colors.text }]}>TD (Displacement) - Yellow</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.colorBox, { backgroundColor: STAY_COLORS.PI.bg, borderColor: STAY_COLORS.PI.border }]} />
            <Text style={[styles.legendText, { color: colors.text }]}>PI (Posted In) - Blue</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.colorBox, { backgroundColor: STAY_COLORS.VACANT.bg, borderColor: STAY_COLORS.VACANT.border }]} />
            <Text style={[styles.legendText, { color: colors.text }]}>Vacant - Green</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.colorBox, { backgroundColor: STAY_COLORS.CLOSED.bg, borderColor: STAY_COLORS.CLOSED.border }]} />
            <Text style={[styles.legendText, { color: colors.text }]}>Closed - Grey</Text>
          </View>
        </View>
      </Card>

      {/* 3. Grid Matrix: Rooms (X-axis) vs Dates (Y-axis) */}
      <Card style={styles.gridContainerCard}>
        <View style={styles.gridHeaderNotice}>
          <Text style={[styles.gridNoticeText, { color: colors.muted }]}>
            Grid View: <Text style={{ fontWeight: 'bold' }}>Rooms on X-Axis</Text> • <Text style={{ fontWeight: 'bold' }}>Dates on Y-Axis</Text> (12:00 PM check-in / check-out turnover). Tap any cell to view occupants or book room directly.
          </Text>
        </View>

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.navy} />
            <Text style={[styles.loadingText, { color: colors.muted }]}>
              Loading room occupancy matrix…
            </Text>
          </View>
        ) : (
          <ScrollView horizontal style={styles.horizontalScroll}>
            <View>
              {/* Header Row (Rooms along X-Axis) */}
              <View style={styles.gridRow}>
                {/* Fixed Top-Left Cell */}
                <View style={[styles.dateHeaderCell, { backgroundColor: colors.blueSoft, borderColor: colors.border }]}>
                  <Text style={[styles.dateHeaderText, { color: colors.navy }]}>Date \ Room</Text>
                </View>

                {/* Room Headers */}
                {preparedRooms.map((room) => (
                  <View
                    key={room.id}
                    style={[styles.roomHeaderCell, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  >
                    <Text style={[styles.roomNameText, { color: colors.navy }]} numberOfLines={1}>
                      {room.name}
                    </Text>
                    <Text style={[styles.roomTypeText, { color: colors.muted }]}>
                      {room.roomType}
                    </Text>
                  </View>
                ))}
              </View>

              {/* Data Rows (Dates along Y-Axis) */}
              <ScrollView style={styles.verticalScroll}>
                {datesList.map((dateStr) => {
                  const d = new Date(dateStr + 'T00:00:00Z');
                  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
                  const isToday = dateStr === todayStr;

                  return (
                    <View key={dateStr} style={styles.gridRow}>
                      {/* Date Row Header (Y-Axis) */}
                      <View
                        style={[
                          styles.dateCell,
                          {
                            backgroundColor: isToday ? colors.saffronSoft : colors.surface,
                            borderColor: colors.border,
                          },
                        ]}
                      >
                        <Text style={[styles.dateText, { color: isToday ? colors.saffronInk : colors.text }]}>
                          {dateStr}
                        </Text>
                        <Text style={[styles.dayText, { color: isToday ? colors.saffronInk : colors.muted }]}>
                          {dayName} {isToday ? '• Today' : ''}
                        </Text>
                      </View>

                      {/* Room Cells for this Date */}
                      {preparedRooms.map((room) => {
                        const st = stateLookup.get(`${dateStr}_${room.id}`);
                        const isClosed = st?.is_closed ?? false;
                        const occupants = st?.occupants ?? [];
                        const isHeld = st ? isRoomHeldExclusive(st) : false;

                        let cellBg = STAY_COLORS.VACANT.bg;
                        let cellBorder = STAY_COLORS.VACANT.border;

                        if (isClosed) {
                          cellBg = STAY_COLORS.CLOSED.bg;
                          cellBorder = STAY_COLORS.CLOSED.border;
                        } else if (occupants.length > 0) {
                          const primaryCat = (occupants[0].category || 'MFA').toUpperCase();
                          if (primaryCat === 'MFA') {
                            cellBg = STAY_COLORS.MFA.bg;
                            cellBorder = STAY_COLORS.MFA.border;
                          } else if (primaryCat === 'LEAVE') {
                            cellBg = STAY_COLORS.LEAVE.bg;
                            cellBorder = STAY_COLORS.LEAVE.border;
                          } else if (primaryCat === 'TD') {
                            cellBg = STAY_COLORS.TD.bg;
                            cellBorder = STAY_COLORS.TD.border;
                          } else if (primaryCat === 'PI') {
                            cellBg = STAY_COLORS.PI.bg;
                            cellBorder = STAY_COLORS.PI.border;
                          }
                        }

                        return (
                          <Pressable
                            key={room.id}
                            style={[
                              styles.gridCell,
                              { backgroundColor: cellBg, borderColor: cellBorder },
                            ]}
                            onPress={() => {
                              setModalData({
                                roomId: room.id,
                                roomName: room.name,
                                roomType: room.roomType,
                                date: dateStr,
                                isClosed,
                                isHeld,
                                occupants,
                              });
                            }}
                          >
                            {isClosed ? (
                              <Text style={[styles.closedText, { color: STAY_COLORS.CLOSED.text }]}>
                                Closed
                              </Text>
                            ) : occupants.length === 0 ? (
                              <Text style={[styles.vacantText, { color: STAY_COLORS.VACANT.text }]}>
                                Vacant
                              </Text>
                            ) : (
                              <View style={styles.occupantsCol}>
                                {occupants.map((occ, i) => {
                                  const cat = (occ.category || 'MFA').toUpperCase();
                                  const colorDef =
                                    cat === 'LEAVE'
                                      ? STAY_COLORS.LEAVE
                                      : cat === 'TD'
                                        ? STAY_COLORS.TD
                                        : cat === 'PI'
                                          ? STAY_COLORS.PI
                                          : STAY_COLORS.MFA;

                                  const lines = occupantLines(occ);
                                  return (
                                    <View
                                      key={occ.allocationId || i}
                                      // @ts-expect-error `title` is a react-native-web hover tooltip, not a native prop
                                      title={[lines.name, lines.detail, lines.service].filter(Boolean).join(' | ')}
                                      style={[
                                        styles.cellBadge,
                                        { backgroundColor: colorDef.bg, borderColor: colorDef.border },
                                      ]}
                                    >
                                      <Text style={[styles.cellBadgeText, { color: colorDef.text }]}>
                                        {lines.name}
                                      </Text>
                                      {lines.detail ? (
                                        <Text style={[styles.cellSubRank, { color: colorDef.darkText }]}>
                                          {lines.detail}
                                        </Text>
                                      ) : null}
                                    </View>
                                  );
                                })}
                                {isHeld && (
                                  <View style={[styles.cellBadge, styles.heldBadge, { borderColor: STAY_COLORS.CLOSED.border }]}>
                                    <Text style={[styles.cellSubRank, { color: STAY_COLORS.CLOSED.text }]}>
                                      No sharing - room held
                                    </Text>
                                  </View>
                                )}
                              </View>
                            )}
                          </Pressable>
                        );
                      })}
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          </ScrollView>
        )}
      </Card>

      {/* 4. Cell Detail Modal */}
      {modalData && (
        <Modal
          visible={true}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setModalData(null)}
        >
          <View style={styles.modalOverlay}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.modalHeader}>
                <View>
                  <Text style={[styles.modalTitle, { color: colors.navy }]}>
                    {modalData.roomName} ({modalData.roomType})
                  </Text>
                  <Text style={[styles.modalDate, { color: colors.muted }]}>
                    Date: {modalData.date}
                  </Text>
                </View>
                <Badge
                  label={
                    modalData.isClosed
                      ? 'Closed'
                      : modalData.occupants.length === 0
                        ? 'Vacant'
                        : `${modalData.occupants.length} Occupant(s)`
                  }
                  variant={
                    modalData.isClosed
                      ? 'error'
                      : modalData.occupants.length === 0
                        ? 'success'
                        : 'warning'
                  }
                />
              </View>

              <View style={styles.modalContent}>
                {modalData.isClosed ? (
                  <Banner
                    type="warning"
                    message="This room is out of service / closed for maintenance on this date."
                  />
                ) : modalData.occupants.length === 0 ? (
                  <Banner
                    type="info"
                    message="This room is completely free and available for allocation on this date."
                  />
                ) : (
                  <View style={{ gap: spacing.sm }}>
                    {modalData.isHeld && (
                      <Banner
                        type="warning"
                        message="This booking does not allow room sharing. The room is held for its party, so there is no free second bed."
                      />
                    )}
                    {modalData.occupants.map((occ, idx) => {
                      const lines = occupantLines(occ);
                      return (
                      <View
                        key={occ.allocationId || idx}
                        style={[styles.occupantCard, { borderColor: colors.border, backgroundColor: colors.bg }]}
                      >
                        <View style={styles.occupantHeader}>
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.occName, { color: colors.navy }]}>{lines.name}</Text>
                            <Text style={[styles.occRank, { color: colors.navy }]}>
                              {[lines.rank, occ.unit]
                                .filter(Boolean)
                                .join(' • ') || 'Rank not recorded'}
                            </Text>
                            {lines.service ? (
                              <Text style={[styles.occDates, { color: colors.muted }]}>{lines.service}</Text>
                            ) : null}
                            <Text style={[styles.occGuestCode, { color: colors.blue }]}>
                              Guest ID {occ.guestCode || 'not assigned'} • Bed {occ.bedSlot ?? 1}
                            </Text>
                          </View>
                          <Badge
                            label={occ.category || 'MFA'}
                            variant={
                              occ.category === 'MFA'
                                ? 'error'
                                : occ.category === 'LEAVE'
                                  ? 'warning'
                                  : 'default'
                            }
                          />
                        </View>
                        <Text style={[styles.occDates, { color: colors.muted }]}>
                          Stay: {occ.checkIn} (12 PM) → {occ.checkOut} (12 PM)
                        </Text>
                        {occ.bookingId && (
                          <Button
                            label="View Booking Details"
                            variant="secondary"
                            style={{ marginTop: spacing.xs }}
                            onPress={() => {
                              const bId = occ.bookingId;
                              setModalData(null);
                              router.push(`/(app)/bookings/${bId}` as any);
                            }}
                          />
                        )}
                      </View>
                      );
                    })}
                  </View>
                )}
              </View>

              <View style={styles.modalActions}>
                {!modalData.isClosed && !modalData.isHeld && modalData.occupants.length < 2 && (
                  <Button
                    label={
                      modalData.occupants.length === 0
                        ? `Book ${modalData.roomName} (12 PM)`
                        : `Book Bed ${modalData.occupants[0].bedSlot === 1 ? 2 : 1} (${modalData.roomName})`
                    }
                    variant="primary"
                    onPress={() => {
                      const slot =
                        modalData.occupants.length === 1
                          ? modalData.occupants[0].bedSlot === 1
                            ? 2
                            : 1
                          : 1;
                      const rId = modalData.roomId;
                      const rName = modalData.roomName;
                      const rType = modalData.roomType;
                      const cIn = modalData.date;
                      const cOut = addDaysToDateString(cIn, 1);
                      setModalData(null);
                      router.push({
                        pathname: '/(app)/bookings/new' as any,
                        params: {
                          roomId: rId,
                          roomName: rName,
                          roomType: rType,
                          bedSlot: String(slot),
                          checkIn: cIn,
                          checkOut: cOut,
                        },
                      });
                    }}
                  />
                )}
                <Button label="Close" variant="secondary" onPress={() => setModalData(null)} />
              </View>
            </View>
          </View>
        </Modal>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  presetsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
    marginBottom: spacing.sm,
  },
  controlLabel: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
  },
  datePickerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  pdfButtonContainer: {
    marginBottom: spacing.xs,
  },
  legendCard: {
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  legendTitle: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.xs,
  },
  legendItemsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    alignItems: 'center',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  colorBox: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
  },
  legendText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
  },
  gridContainerCard: {
    padding: 0,
    overflow: 'hidden',
  },
  gridHeaderNotice: {
    padding: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  gridNoticeText: {
    fontSize: typography.xs,
  },
  loadingContainer: {
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    fontSize: typography.sm,
  },
  horizontalScroll: {
    flexDirection: 'row',
  },
  verticalScroll: {
    maxHeight: 520,
  },
  gridRow: {
    flexDirection: 'row',
  },
  dateHeaderCell: {
    width: 110,
    height: 48,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 4,
  },
  dateHeaderText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
  },
  roomHeaderCell: {
    width: 150,
    height: 48,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 4,
  },
  roomNameText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
    textAlign: 'center',
  },
  roomTypeText: {
    fontSize: 10,
    textTransform: 'uppercase',
  },
  dateCell: {
    width: 110,
    minHeight: 56,
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  dateText: {
    fontSize: typography.xs,
    fontFamily: 'monospace',
    fontWeight: typography.weights.bold,
  },
  dayText: {
    fontSize: 10,
  },
  gridCell: {
    width: 150,
    minHeight: 56,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 2,
  },
  closedText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
  },
  vacantText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
  },
  occupantsCol: {
    width: '100%',
    gap: 2,
  },
  cellBadge: {
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    alignItems: 'center',
  },
  cellBadgeText: {
    fontSize: 9,
    fontWeight: typography.weights.bold,
  },
  cellSubRank: {
    fontSize: 8,
    fontWeight: typography.weights.bold,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md,
  },
  modalCard: {
    width: '100%',
    maxWidth: 500,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.md,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    paddingBottom: spacing.sm,
  },
  modalTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  modalDate: {
    fontSize: typography.xs,
    marginTop: 2,
  },
  modalContent: {
    gap: spacing.sm,
  },
  occupantCard: {
    borderWidth: 1,
    borderRadius: 6,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  occupantHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  occName: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
  },
  heldBadge: {
    borderStyle: 'dashed',
    backgroundColor: '#F7FAFC',
  },
  occGuestCode: {
    fontSize: typography.xs,
    fontFamily: 'monospace',
    fontWeight: typography.weights.bold,
  },
  occRank: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
  },
  occDates: {
    fontSize: typography.xs,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
});
