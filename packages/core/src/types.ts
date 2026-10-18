import type {
  AllocationStatus,
  AppRole,
  BookingStatus,
  DetailsStatus,
  Gender,
  GuestRelation,
  Permission,
  RankCode,
  RoomType,
  VisitorCategory
} from './constants.ts';

export interface Profile {
  id: string;
  role: AppRole;
  permissions: Permission[];
  displayNameEnc?: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface Room {
  id: string;
  roomType: RoomType;
  nameEnc: string;
  keyVersion: number;
  displayOrder: number;
  isActive: boolean;
  capacity: 2;
}

export interface RoomClosure {
  id: string;
  roomId: string;
  period: string; // daterange e.g. "[2026-10-01, 2026-10-05)"
  reasonEnc?: string | null;
  createdBy: string;
}

export interface Booking {
  id: string;
  category: VisitorCategory;
  status: BookingStatus;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  stay: string; // daterange
  partySize: number;
  isSuiteBooking: boolean;
  /**
   * Room sharing. TRUE: the booking accepts other bookings beside it (and may itself be placed
   * beside them). FALSE: the booking holds each room it uses for its own party only.
   */
  allowSharing: boolean;
  notesEnc?: string | null;
  keyVersion: number;
  createdBy: string;
  cancelledAt?: string | null;
  cancelReasonEnc?: string | null;
}

export interface BookingGuest {
  id: string;
  guestCode?: string;
  guest_code?: string;
  bookingId: string;
  seq: number;
  gender: Gender;
  /** Null for civilians. */
  rankCode: RankCode | null;
  relation: GuestRelation;
  details: DetailsStatus;
  createdBy: string;
}

export interface GuestPii {
  name: string;
  serviceNumber?: string | null;
  /** Required for ranked guests (GuestPiiSchema); optional for civilians (CivilianPiiSchema). */
  idNumber?: string | null;
  idType?: string | null;
  phone?: string | null;
  unit?: string | null;
  notes?: string | null;
}

export interface Allocation {
  id: string;
  bookingId: string;
  guestId: string;
  roomId: string;
  bedSlot: 1 | 2;
  stay: string; // daterange
  status: AllocationStatus;
  createdBy: string;
}

export interface Denial {
  id: string;
  category: VisitorCategory;
  checkIn: string;
  checkOut: string;
  partySize: number;
  reasonEnc: string;
  keyVersion: number;
  deniedBy: string;
  createdAt: string;
}

export interface Eviction {
  id: string;
  evictedAllocationId: string;
  displacedBookingId: string;
  incomingBookingId: string;
  reasonEnc: string;
  keyVersion: number;
  approvedBy: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  meta: Record<string, unknown>;
  prevHash?: string | null;
  hash: string;
}

// Engine & API types
export interface RoomDayOccupant {
  allocationId: string;
  bookingId: string;
  bedSlot: 1 | 2;
  gender: Gender;
  /** Null for civilians. */
  rankCode: RankCode | null;
  relation?: GuestRelation;
  category: VisitorCategory;
  bookingStatus: BookingStatus;
  checkIn: string;
  checkOut: string;
  /**
   * Whether this occupant's booking lets other bookings use the room's other bed. A booking that
   * does not allow it holds the whole room. Missing (a server that predates room sharing) counts
   * as true.
   */
  allowSharing?: boolean;
}

export interface RoomDayState {
  roomId: string;
  roomType: RoomType;
  displayOrder: number;
  date: string; // YYYY-MM-DD
  bedsTaken: number;
  isClosed: boolean;
  occupants: RoomDayOccupant[];
}

export interface GuestDemand {
  gender: Gender;
  /** Required for PRIMARY/SERVICE; null for civilians. */
  rankCode: RankCode | null;
  /** Defaults to PRIMARY for the first guest and SERVICE for later ranked guests. */
  relation?: GuestRelation;
}

export interface BookingPlanRequest {
  category: VisitorCategory;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: GuestDemand[];
  preferredRoomType?: RoomType;
  isSuiteBooking?: boolean;
  /**
   * "Allow room sharing" on the booking. false (the default): only fully unoccupied rooms are
   * offered, and the booking then holds each room it uses for its own party. true: fully empty
   * rooms plus rooms with a free bed beside an occupant it may share with (same gender for
   * ranked guests, any rank; civilians never share across bookings) whose own booking allows
   * sharing too.
   */
  allowSharing?: boolean;
  /**
   * Offer beds in already-shared rooms first: a lone guest is seated beside a compatible
   * occupant before any empty room is opened. Only meaningful with allowSharing. Applies across
   * room types; the preferred type then only orders the remaining choices.
   */
  preferSharing?: boolean;
}

export interface PlannedAssignment {
  guestIndex: number;
  roomId: string;
  roomType: RoomType;
  bedSlot: 1 | 2;
}

export interface AlternateWindow {
  checkIn: string;
  checkOut: string;
  roomsFree: number;
}

export type AllotmentResult =
  | {
      kind: 'ALLOT';
      assignments: PlannedAssignment[];
      usedFallbackType: boolean;
    }
  | {
      kind: 'ALTERNATES';
      windows: AlternateWindow[];
    }
  | {
      kind: 'NONE';
      canDeny: boolean;
      canEvict: boolean;
    };

export interface EvictionCandidate {
  allocationId: string;
  bookingId: string;
  roomId: string;
  roomCode: string;
  roomType: RoomType;
  bedSlot: 1 | 2;
  category: VisitorCategory;
  occupantGender: Gender;
  occupantRank: RankCode | null;
  daysStayed: number;
  daysRemaining: number;
  fitsIncoming: boolean;
}

export interface ReportDailyRow {
  day: string;
  category: VisitorCategory;
  roomType: RoomType;
  people: number;
}

export interface ReportInsights {
  totalPeopleDays: number;
  totalGuestDays: number;
  dailyAverage: number;
  peakDay: string;
  peakCount: number;
  mfaPiSharePercentage: number;
  bedsTotal: number;
  peakOccupancyPercentage: number;
  denialCount: number;
  writtenInsights: string[];
}
