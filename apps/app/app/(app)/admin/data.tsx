import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Table } from '../../../src/ui/primitives/Table';
import { Button } from '../../../src/ui/primitives/Button';
import { Field } from '../../../src/ui/primitives/Field';
import { Select } from '../../../src/ui/primitives/Select';
import { Badge } from '../../../src/ui/primitives/Badge';
import { Banner } from '../../../src/ui/primitives/Banner';
import { Dialog } from '../../../src/ui/primitives/Dialog';
import { DateRange } from '../../../src/ui/primitives/DateRange';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { randomUUID } from 'expo-crypto';
import { logAction } from '../../../src/lib/activityLog';
import { userErrorMessage } from '../../../src/lib/userError';
import { addDaysToDateString, isValidDateString, localDateString } from '../../../src/lib/dates';
import {
  decryptReason,
  decryptRoomName,
  encryptRoomName,
  encryptReason,
  getActiveKeyVersion,
} from '../../../src/features/crypto-session/cryptoSession';
import { RANK_ORDER } from '@sms/core';

interface ClosureRow {
  id: string;
  from: string;
  to: string; // exclusive
  reason: string | null;
}

interface RoomRow {
  id: string;
  name: string;
  room_type: string;
  display_order: number;
  is_active: boolean;
  closures: ClosureRow[];
}

const ROOM_TYPE_LABEL: Record<string, string> = {
  NORMAL: 'Normal',
  SEMI_VIP: 'Semi VIP',
  VIP: 'VIP',
  SUITE: 'Suite',
};

function parsePeriod(period: string): { from: string; to: string } | null {
  const m = /^[[(]\s*([0-9-]+)\s*,\s*([0-9-]+)\s*[)\]]$/.exec(period);
  return m ? { from: m[1], to: m[2] } : null;
}

export default function AdminDataScreen() {
  const colors = useThemeStore((s) => s.colors);
  const { userRole, userPermissions } = useSessionStore();
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();
  const useCards = width < 960;
  const { roomId: roomIdParam } = useLocalSearchParams<{ roomId?: string }>();

  const isAdmin = userRole === 'admin';
  const canManageRooms = isAdmin || userPermissions.includes('manage_rooms');
  const today = localDateString();

  // Room modal
  const [showAddRoomDialog, setShowAddRoomDialog] = useState(false);
  const [roomNameInput, setRoomNameInput] = useState('');
  const [roomTypeInput, setRoomTypeInput] = useState<'VIP' | 'SEMI_VIP' | 'NORMAL' | 'SUITE'>(
    'NORMAL',
  );
  const [roomNameError, setRoomNameError] = useState<string | null>(null);
  const [savingRoom, setSavingRoom] = useState(false);

  // Out of service closure modal
  const [closureRoomId, setClosureRoomId] = useState<string | null>(null);
  const [closureFrom, setClosureFrom] = useState(today);
  const [closureTo, setClosureTo] = useState(addDaysToDateString(today, 7));
  const [closureReason, setClosureReason] = useState('');
  const [savingClosure, setSavingClosure] = useState(false);
  const [closureError, setClosureError] = useState<string | null>(null);

  const [pageError, setPageError] = useState<string | null>(null);
  const [endingClosure, setEndingClosure] = useState<{ room: RoomRow; closure: ClosureRow } | null>(
    null,
  );
  const [endingBusy, setEndingBusy] = useState(false);

  // Fetch rooms with their closures
  const { data: rooms, isLoading: roomsLoading } = useQuery<RoomRow[]>({
    queryKey: ['admin_all_rooms'],
    queryFn: async () => {
      const { data, error } = await supabase.from('rooms').select('*').order('display_order');
      if (error) throw error;
      const { data: closureRows, error: closureErr } = await supabase
        .from('room_closures')
        .select('*');
      if (closureErr) throw closureErr;

      return (data || []).map((r) => ({
        id: r.id as string,
        name: decryptRoomName(r.id, r.name_enc),
        room_type: r.room_type as string,
        display_order: r.display_order as number,
        is_active: r.is_active as boolean,
        closures: ((closureRows || []) as any[])
          .filter((c) => c.room_id === r.id)
          .map((c) => {
            const p = parsePeriod(c.period);
            return p
              ? {
                  id: c.id as string,
                  from: p.from,
                  to: p.to,
                  reason: decryptReason('room_closures', 'reason_enc', c.id, c.reason_enc),
                }
              : null;
          })
          .filter((c): c is ClosureRow => c !== null && c.to > today)
          .sort((a, b) => (a.from < b.from ? -1 : 1)),
      }));
    },
    enabled: canManageRooms,
  });

  // Deep link from a room page: /admin/data?roomId=<id> opens the closure dialog for that room.
  useEffect(() => {
    if (roomIdParam && rooms?.some((r) => r.id === roomIdParam)) {
      setClosureRoomId(roomIdParam);
      setClosureError(null);
    }
  }, [roomIdParam, rooms]);

  const openClosureDialog = (id: string) => {
    setClosureFrom(today);
    setClosureTo(addDaysToDateString(today, 7));
    setClosureReason('');
    setClosureError(null);
    setClosureRoomId(id);
  };

  const refreshRoomData = () => {
    queryClient.invalidateQueries({ queryKey: ['admin_all_rooms'] });
    queryClient.invalidateQueries({ queryKey: ['room_names'] });
    queryClient.invalidateQueries({ queryKey: ['available_rooms_list'] });
    queryClient.invalidateQueries({ queryKey: ['admin_suites_list'] });
    queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
  };

  const handleCreateRoom = async () => {
    const name = roomNameInput.trim();
    if (!name) {
      setRoomNameError('Enter a room code or name.');
      return;
    }
    if ((rooms || []).some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      setRoomNameError(`A room called "${name}" already exists.`);
      return;
    }
    setSavingRoom(true);
    setRoomNameError(null);
    try {
      const roomId = randomUUID();
      const encName = encryptRoomName(roomId, name);
      const nextOrder = Math.max(0, ...(rooms || []).map((r) => r.display_order)) + 1;

      const { error } = await supabase.from('rooms').insert({
        id: roomId,
        room_type: roomTypeInput,
        name_enc: encName,
        key_version: getActiveKeyVersion(),
        display_order: nextOrder,
        is_active: true,
      });

      if (error) throw error;
      logAction('rooms.create', {
        entity: 'rooms',
        entityId: roomId,
        meta: { room_type: roomTypeInput },
      });
      setShowAddRoomDialog(false);
      setRoomNameInput('');
      setPageError(null);
      refreshRoomData();
    } catch (err: unknown) {
      setRoomNameError(userErrorMessage(err, 'Failed to add the room.'));
    } finally {
      setSavingRoom(false);
    }
  };

  const closureDatesValid =
    isValidDateString(closureFrom) && isValidDateString(closureTo) && closureTo > closureFrom;

  const handleAddClosure = async () => {
    if (!closureRoomId || !closureReason.trim() || !closureDatesValid) return;
    setSavingClosure(true);
    setClosureError(null);
    try {
      const closureId = randomUUID();
      const reasonEnc = encryptReason(
        'room_closures',
        'reason_enc',
        closureId,
        closureReason.trim(),
      );

      const { error } = await supabase.from('room_closures').insert({
        id: closureId,
        room_id: closureRoomId,
        period: `[${closureFrom},${closureTo})`,
        reason_enc: reasonEnc,
      });

      if (error) throw error;
      logAction('rooms.closure_create', {
        entity: 'room_closures',
        entityId: closureId,
        meta: { room_id: closureRoomId, from: closureFrom, to: closureTo },
      });
      setClosureRoomId(null);
      setClosureReason('');
      setPageError(null);
      refreshRoomData();
    } catch (err: unknown) {
      setClosureError(userErrorMessage(err, 'Failed to mark the room out of service.'));
    } finally {
      setSavingClosure(false);
    }
  };

  const handleEndClosure = async () => {
    if (!endingClosure) return;
    setEndingBusy(true);
    try {
      const { error } = await supabase.rpc('end_room_closure', {
        p_closure_id: endingClosure.closure.id,
      });
      if (error) throw error;
      logAction('rooms.closure_end', {
        entity: 'room_closures',
        entityId: endingClosure.closure.id,
        meta: { room_id: endingClosure.room.id },
      });
      setEndingClosure(null);
      setPageError(null);
      refreshRoomData();
    } catch (err: unknown) {
      setEndingClosure(null);
      setPageError(userErrorMessage(err, 'Could not end the closure.'));
    } finally {
      setEndingBusy(false);
    }
  };

  const roomStatus = (r: RoomRow) => {
    const active = r.closures.find((c) => c.from <= today && today < c.to);
    if (!r.is_active) return { label: 'Offline', variant: 'default' as const };
    if (active) return { label: 'Out of service', variant: 'warning' as const };
    return { label: 'Active', variant: 'success' as const };
  };

  const renderClosures = (r: RoomRow) =>
    r.closures.length === 0 ? null : (
      <View style={{ gap: spacing.xs, marginTop: spacing.xs }}>
        {r.closures.map((c) => (
          <View key={c.id} style={styles.closureRow}>
            <Text style={[styles.closureText, { color: colors.text }]}>
              {c.from} → {c.to}
              {c.reason ? ` • ${c.reason}` : ''}
            </Text>
            <Button
              label={c.from > today ? 'Cancel' : 'End now'}
              variant="secondary"
              accessibilityLabel={`${c.from > today ? 'Cancel' : 'End'} closure of ${r.name} (${c.from} to ${c.to})`}
              onPress={() => setEndingClosure({ room: r, closure: c })}
            />
          </View>
        ))}
      </View>
    );

  if (!canManageRooms) {
    return (
      <Screen title="Rooms & Data" showBack={false}>
        <Card>
          <Text style={[styles.title, { color: colors.navy }]}>No Access</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Ask an admin to grant the "Manage Rooms" permission from the User Directory.
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title="Rooms & Data" showBack={false}>
      <View style={styles.container}>
        <Card>
          <View style={styles.topRow}>
            <View style={{ flex: 1, minWidth: 220 }}>
              <Text style={[styles.title, { color: colors.navy }]}>Room inventory</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                {(rooms || []).length} room{(rooms || []).length === 1 ? '' : 's'}. Names are
                encrypted on this device; the database only sees ciphertext.
              </Text>
            </View>
            <Button
              label="+ Add New Room"
              variant="primary"
              onPress={() => {
                setRoomNameError(null);
                setRoomNameInput('');
                setShowAddRoomDialog(true);
              }}
            />
          </View>
        </Card>

        {pageError && <Banner type="error" message={pageError} style={{ marginTop: spacing.md }} />}

        {useCards ? (
          <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
            {roomsLoading && (
              <Text style={[styles.subtitle, { color: colors.muted }]}>Loading rooms…</Text>
            )}
            {!roomsLoading && (rooms || []).length === 0 && (
              <Banner
                type="info"
                message="No rooms yet. Tap “Add New Room” to create the first one."
              />
            )}
            {(rooms || []).map((r) => {
              const status = roomStatus(r);
              return (
                <Card key={r.id}>
                  <View style={styles.topRow}>
                    <Text style={[styles.title, { color: colors.navy }]}>
                      {r.display_order}. {r.name}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: spacing.xs }}>
                      <Badge
                        label={ROOM_TYPE_LABEL[r.room_type] ?? r.room_type}
                        variant={r.room_type === 'SUITE' ? 'warning' : 'default'}
                      />
                      <Badge label={status.label} variant={status.variant} />
                    </View>
                  </View>
                  {renderClosures(r)}
                  <Button
                    label="Mark Out of Service"
                    variant="secondary"
                    onPress={() => openClosureDialog(r.id)}
                    style={{ marginTop: spacing.sm }}
                  />
                </Card>
              );
            })}
          </View>
        ) : (
          <Card style={{ marginTop: spacing.md }}>
            <Table
              loading={roomsLoading}
              columns={[
                { key: 'display_order', header: 'Order', width: 70 },
                { key: 'name', header: 'Room', width: 120 },
                {
                  key: 'room_type',
                  header: 'Type',
                  width: 120,
                  render: (r: RoomRow) => (
                    <Badge
                      label={ROOM_TYPE_LABEL[r.room_type] ?? r.room_type}
                      variant={r.room_type === 'SUITE' ? 'warning' : 'default'}
                    />
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  width: 140,
                  render: (r: RoomRow) => {
                    const st = roomStatus(r);
                    return <Badge label={st.label} variant={st.variant} />;
                  },
                },
                {
                  key: 'closures',
                  header: 'Out-of-service periods',
                  flex: 1,
                  render: (r: RoomRow) => renderClosures(r) ?? (
                    <Text style={[styles.closureText, { color: colors.muted }]}>None</Text>
                  ),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  width: 190,
                  render: (r: RoomRow) => (
                    <Button
                      label="Mark Out of Service"
                      variant="secondary"
                      onPress={() => openClosureDialog(r.id)}
                    />
                  ),
                },
              ]}
              data={rooms || []}
              keyExtractor={(r) => r.id}
              emptyText="No rooms yet. Use “Add New Room” to create the first one."
            />
          </Card>
        )}

        {/* Read-Only Reference Ranks */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.title, { color: colors.navy }]}>
            REFERENCE RANKS TABLE (READ-ONLY)
          </Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Indian Air Force standard rank hierarchy used to enforce database-level sharing rules.
          </Text>

          <Table
            columns={[
              { key: 'seniority', header: 'Seniority', width: 100 },
              { key: 'code', header: 'Code', width: 120 },
              { key: 'label', header: 'Official Designation', flex: 1 },
            ]}
            data={[...RANK_ORDER]}
            keyExtractor={(rk) => rk.code}
          />
        </Card>

        {/* Add Room Dialog */}
        <Dialog
          visible={showAddRoomDialog}
          title="Add New Room"
          message="Name the room and pick its type. The name is encrypted before upload."
          confirmLabel="Create Room"
          confirmVariant="primary"
          disabled={!roomNameInput.trim()}
          onConfirm={handleCreateRoom}
          onCancel={() => setShowAddRoomDialog(false)}
          loading={savingRoom}
        >
          <Field
            label="Room Code / Name (e.g. V-01, S-04, N-12)"
            value={roomNameInput}
            onChangeText={(t) => {
              setRoomNameInput(t);
              setRoomNameError(null);
            }}
            placeholder="Room code"
            returnKeyType="done"
            onSubmitEditing={handleCreateRoom}
            error={roomNameError ?? undefined}
          />

          <Select
            label="Room Classification"
            value={roomTypeInput}
            onChange={(val) => setRoomTypeInput(val as any)}
            options={[
              { label: 'Normal Room', value: 'NORMAL' },
              { label: 'Semi VIP Room', value: 'SEMI_VIP' },
              { label: 'VIP Room', value: 'VIP' },
              // Suites are admin-only (enforced by RLS in 0019).
              ...(isAdmin ? [{ label: 'Executive Suite (AM/VVIP)', value: 'SUITE' }] : []),
            ]}
          />
        </Dialog>

        {/* Closure Dialog */}
        <Dialog
          visible={!!closureRoomId}
          title={`Mark ${rooms?.find((r) => r.id === closureRoomId)?.name ?? 'Room'} Out of Service`}
          message="The room can't be booked on these dates. Existing bookings must be cancelled or moved first. The reason is encrypted."
          confirmLabel="Confirm Closure"
          confirmVariant="destructive"
          disabled={!closureReason.trim() || !closureDatesValid}
          onConfirm={handleAddClosure}
          onCancel={() => setClosureRoomId(null)}
          loading={savingClosure}
        >
          <DateRange
            label="Out of service"
            startLabel="From"
            endLabel="Back in service on"
            hideNights
            startDate={closureFrom}
            endDate={closureTo}
            onStartDateChange={setClosureFrom}
            onEndDateChange={setClosureTo}
          />

          <Field
            label="Maintenance Reason (Encrypted)"
            value={closureReason}
            onChangeText={setClosureReason}
            placeholder="e.g. Painting, HVAC overhaul..."
            multiline={true}
          />

          {closureError && <Banner type="error" message={closureError} />}
        </Dialog>

        {/* End closure confirmation */}
        <Dialog
          visible={!!endingClosure}
          title={endingClosure && endingClosure.closure.from > today ? 'Cancel this closure?' : 'End closure now?'}
          message={
            endingClosure
              ? `${endingClosure.room.name} will be bookable again${endingClosure.closure.from > today ? ' for the whole period' : ' from today'}.`
              : ''
          }
          confirmLabel={endingClosure && endingClosure.closure.from > today ? 'Cancel Closure' : 'End Closure'}
          confirmVariant="primary"
          onConfirm={handleEndClosure}
          onCancel={() => setEndingClosure(null)}
          loading={endingBusy}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  topRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  closureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  closureText: {
    fontSize: typography.sm,
    flex: 1,
  },
});
