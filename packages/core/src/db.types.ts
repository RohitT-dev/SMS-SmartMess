import type {
  AllocationStatus,
  AppRole,
  BookingStatus,
  DetailsStatus,
  Gender,
  GuestRelation,
  RankCode,
  RoomType,
  VisitorCategory
} from './constants.ts';

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: AppRole;
          permissions: string[];
          display_name_enc: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id: string;
          role?: AppRole;
          permissions?: string[];
          display_name_enc?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          role?: AppRole;
          permissions?: string[];
          display_name_enc?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
      };
      ranks: {
        Row: {
          code: RankCode;
          seniority: number;
          label: string;
        };
      };
      user_keys: {
        Row: {
          user_id: string;
          public_key: string;
          enc_private_key: string;
          kdf_salt: string;
          kdf_params: Json;
          key_version: number;
        };
      };
      team_key_versions: {
        Row: {
          version: number;
          recovery_wrap: string;
          recovery_kdf_salt: string;
          recovery_kdf_params: Json;
          is_active: boolean;
          created_at: string;
        };
      };
      user_key_wraps: {
        Row: {
          user_id: string;
          key_version: number;
          sealed_team_key: string;
        };
      };
      devices: {
        Row: {
          id: string;
          user_id: string;
          label: string;
          last_seen_at: string;
          revoked_at: string | null;
        };
      };
      rooms: {
        Row: {
          id: string;
          room_type: RoomType;
          name_enc: string;
          key_version: number;
          display_order: number;
          is_active: boolean;
          capacity: number;
        };
      };
      room_closures: {
        Row: {
          id: string;
          room_id: string;
          period: string;
          reason_enc: string | null;
          created_by: string;
        };
      };
      bookings: {
        Row: {
          id: string;
          category: VisitorCategory;
          status: BookingStatus;
          check_in: string;
          check_out: string;
          stay: string;
          party_size: number;
          is_suite_booking: boolean;
          notes_enc: string | null;
          key_version: number;
          created_by: string;
          cancelled_at: string | null;
          cancel_reason_enc: string | null;
        };
      };
      booking_guests: {
        Row: {
          id: string;
          guest_code: string;
          booking_id: string;
          seq: number;
          gender: Gender;
          rank_code: RankCode | null;
          relation: GuestRelation;
          details: DetailsStatus;
          created_by: string;
        };
      };
      guest_pii: {
        Row: {
          guest_id: string;
          pii_enc: string;
          id_blind_index: string | null;
          key_version: number;
          updated_by: string;
          updated_at: string;
        };
      };
      allocations: {
        Row: {
          id: string;
          booking_id: string;
          guest_id: string;
          room_id: string;
          bed_slot: number;
          stay: string;
          status: AllocationStatus;
          created_by: string;
        };
      };
      denials: {
        Row: {
          id: string;
          category: VisitorCategory;
          check_in: string;
          check_out: string;
          party_size: number;
          reason_enc: string;
          key_version: number;
          denied_by: string;
          created_at: string;
        };
      };
      evictions: {
        Row: {
          id: string;
          evicted_allocation_id: string;
          displaced_booking_id: string;
          incoming_booking_id: string;
          reason_enc: string;
          key_version: number;
          approved_by: string;
          created_at: string;
        };
      };
      audit_log: {
        Row: {
          id: number;
          at: string;
          actor: string;
          action: string;
          entity: string;
          entityId: string;
          meta: Json;
          prev_hash: string | null;
          hash: string;
        };
      };
    };
  };
}
