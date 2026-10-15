import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
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
import { Dialog } from '../../../src/ui/primitives/Dialog';
import { DateRange } from '../../../src/ui/primitives/DateRange';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { decryptRoomName, encryptRoomName, encryptReason } from '../../../src/features/crypto-session/cryptoSession';
import { RANK_ORDER } from '@sms/core';

export default function AdminDataScreen() {
  const colors = useThemeStore((s) => s.colors);
  const { userRole } = useSessionStore();
  const queryClient = useQueryClient();

  const isAdmin = userRole === 'admin';

  // Room modal
  const [showAddRoomDialog, setShowAddRoomDialog] = useState(false);
  const [roomNameInput, setRoomNameInput] = useState('');
  const [roomTypeInput, setRoomTypeInput] = useState<'VIP' | 'SEMI_VIP' | 'NORMAL' | 'SUITE'>('NORMAL');
  const [savingRoom, setSavingRoom] = useState(false);

  // Out of service closure modal
  const [closureRoomId, setClosureRoomId] = useState<string | null>(null);
  const [closureFrom, setClosureFrom] = useState(new Date().toISOString().split('T')[0]);
  const defaultTo = new Date();
  defaultTo.setDate(defaultTo.getDate() + 7);
  const [closureTo, setClosureTo] = useState(defaultTo.toISOString().split('T')[0]);
  const [closureReason, setClosureReason] = useState('');
  const [savingClosure, setSavingClosure] = useState(false);

  // Fetch rooms
  const { data: rooms } = useQuery({
    queryKey: ['admin_all_rooms'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .order('display_order');
      if (error) throw error;
      return (data || []).map((r) => ({
        ...r,
        name: decryptRoomName(r.id, r.name_enc)
      }));
    },
    enabled: isAdmin
  });

  const handleCreateRoom = async () => {
    if (!roomNameInput.trim()) return;
    setSavingRoom(true);
    try {
      const roomId = crypto.randomUUID();
      const encName = encryptRoomName(roomId, roomNameInput.trim());
      const nextOrder = (rooms?.length || 0) + 1;

      const { error } = await supabase.from('rooms').insert({
        id: roomId,
        room_type: roomTypeInput,
        name_enc: encName,
        key_version: 1,
        display_order: nextOrder,
        is_active: true
      });

      if (error) throw error;
      setShowAddRoomDialog(false);
      setRoomNameInput('');
      queryClient.invalidateQueries({ queryKey: ['admin_all_rooms'] });
    } catch (err: any) {
      alert('Failed to add room: ' + err.message);
    } finally {
      setSavingRoom(false);
    }
  };

  const handleAddClosure = async () => {
    if (!closureRoomId || !closureReason.trim()) return;
    setSavingClosure(true);
    try {
      const closureId = crypto.randomUUID();
      const reasonEnc = encryptReason('room_closures', 'reason_enc', closureId, closureReason.trim());

      const { error } = await supabase.from('room_closures').insert({
        id: closureId,
        room_id: closureRoomId,
        period: `[${closureFrom},${closureTo})`,
        reason_enc: reasonEnc
      });

      if (error) throw error;
      setClosureRoomId(null);
      setClosureReason('');
      queryClient.invalidateQueries({ queryKey: ['admin_all_rooms'] });
    } catch (err: any) {
      alert('Failed to mark room out of service: ' + err.message);
    } finally {
      setSavingClosure(false);
    }
  };

  return (
    <Screen title="Data & Inventory Administration" showBack={false}>
      <ScrollView contentContainerStyle={styles.container}>
        <Card>
          <View style={styles.topRow}>
            <View>
              <Text style={[styles.title, { color: colors.navy }]}>ROOM INVENTORY</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                Room names are encrypted client-side. The database only sees ciphertext.
              </Text>
            </View>
            <Button
              label="+ Add New Room"
              variant="primary"
              onPress={() => setShowAddRoomDialog(true)}
            />
          </View>
        </Card>

        {/* Rooms Table */}
        <Card style={{ marginTop: spacing.md }}>
          <Table
            columns={[
              { key: 'display_order', header: 'Order', width: 70 },
              { key: 'name', header: 'Decrypted Room Name', width: 180 },
              {
                key: 'room_type',
                header: 'Type',
                width: 120,
                render: (r: any) => (
                  <Badge
                    label={r.room_type}
                    variant={r.room_type === 'SUITE' ? 'warning' : 'default'}
                  />
                )
              },
              {
                key: 'capacity',
                header: 'Beds',
                width: 80,
                render: () => <Text style={{ fontSize: typography.sm }}>2 Beds</Text>
              },
              {
                key: 'status',
                header: 'Status',
                width: 110,
                render: (r: any) => (
                  <Badge
                    label={r.is_active ? 'ACTIVE' : 'OFFLINE'}
                    variant={r.is_active ? 'success' : 'default'}
                  />
                )
              },
              {
                key: 'actions',
                header: 'Actions',
                width: 160,
                render: (r: any) => (
                  <Button
                    label="Mark Closure"
                    variant="secondary"
                    onPress={() => setClosureRoomId(r.id)}
                  />
                )
              }
            ]}
            data={rooms || []}
            keyExtractor={(r) => r.id}
          />
        </Card>

        {/* Read-Only Reference Ranks */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.title, { color: colors.navy }]}>REFERENCE RANKS TABLE (READ-ONLY)</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Indian Air Force standard rank hierarchy used to enforce database-level sharing rules.
          </Text>

          <Table
            columns={[
              { key: 'seniority', header: 'Seniority', width: 100 },
              { key: 'code', header: 'Code', width: 120 },
              { key: 'label', header: 'Official Designation', flex: 1 }
            ]}
            data={[...RANK_ORDER]}
            keyExtractor={(rk) => rk.code}
          />
        </Card>

        {/* Add Room Dialog */}
        <Dialog
          visible={showAddRoomDialog}
          title="Add New Room"
          message="Specify the room designation and type. Name will be encrypted before upload."
          confirmLabel="Create & Encrypt Room"
          confirmVariant="primary"
          onConfirm={handleCreateRoom}
          onCancel={() => setShowAddRoomDialog(false)}
          loading={savingRoom}
        >
          <Field
            label="Room Code / Name (e.g. V-01, S-04, N-12)"
            value={roomNameInput}
            onChangeText={setRoomNameInput}
            placeholder="Room code"
          />

          <Select
            label="Room Classification"
            value={roomTypeInput}
            onChange={(val) => setRoomTypeInput(val as any)}
            options={[
              { label: 'Normal Room', value: 'NORMAL' },
              { label: 'Semi VIP Room', value: 'SEMI_VIP' },
              { label: 'VIP Room', value: 'VIP' },
              { label: 'Executive Suite (AM/VVIP)', value: 'SUITE' }
            ]}
          />
        </Dialog>

        {/* Closure Dialog */}
        <Dialog
          visible={!!closureRoomId}
          title="Mark Out of Service"
          message="Set maintenance or out-of-service dates for this room. Reason will be encrypted."
          confirmLabel="Confirm Closure"
          confirmVariant="destructive"
          onConfirm={handleAddClosure}
          onCancel={() => setClosureRoomId(null)}
          loading={savingClosure}
        >
          <DateRange
            label="Closure Duration [from, to)"
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
        </Dialog>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2,
    marginBottom: spacing.sm
  }
});
