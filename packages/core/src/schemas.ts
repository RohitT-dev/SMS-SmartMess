import type { GuestDemand, GuestPii } from './types.ts';
import type { GuestRelation, RoomType, VisitorCategory } from './constants.ts';
import { CATEGORIES, RANKS, isCivilianRelation } from './constants.ts';

export interface ValidationSuccess<T> {
  success: true;
  data: T;
}

export interface ValidationError {
  success: false;
  error: {
    issues: Array<{ path: string[]; message: string }>;
    message: string;
  };
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationError;

export interface SchemaValidator<T> {
  parse(data: unknown): T;
  safeParse(data: unknown): ValidationResult<T>;
}

export const GuestPiiSchema: SchemaValidator<GuestPii> = {
  parse(input: unknown): GuestPii {
    const res = this.safeParse(input);
    if (!res.success) {
      throw new Error(res.error.message);
    }
    return res.data;
  },
  safeParse(input: unknown): ValidationResult<GuestPii> {
    const issues: Array<{ path: string[]; message: string }> = [];
    if (!input || typeof input !== 'object') {
      return {
        success: false,
        error: { issues: [{ path: [], message: 'Expected object' }], message: 'Expected object' }
      };
    }
    const val = input as Record<string, unknown>;

    if (!val.name || typeof val.name !== 'string' || val.name.trim().length === 0) {
      issues.push({ path: ['name'], message: 'Guest name is required' });
    }
    if (!val.idNumber || typeof val.idNumber !== 'string' || val.idNumber.trim().length === 0) {
      issues.push({ path: ['idNumber'], message: 'ID number is required' });
    }
    if (!val.phone || typeof val.phone !== 'string' || val.phone.trim().length === 0) {
      issues.push({ path: ['phone'], message: 'Phone number is required' });
    }

    if (issues.length > 0) {
      return {
        success: false,
        error: {
          issues,
          message: issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
        }
      };
    }

    return { success: true, data: normalizePii(val) };
  }
};

const optionalTrimmed = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

function normalizePii(val: Record<string, unknown>): GuestPii {
  return {
    name: (val.name as string).trim(),
    serviceNumber: optionalTrimmed(val.serviceNumber),
    idNumber: optionalTrimmed(val.idNumber),
    phone: optionalTrimmed(val.phone),
    unit: optionalTrimmed(val.unit),
    notes: optionalTrimmed(val.notes)
  };
}

/** Civilians (family and other guests without rank): only the name is required. */
export const CivilianPiiSchema: SchemaValidator<GuestPii> = {
  parse(input: unknown): GuestPii {
    const res = this.safeParse(input);
    if (!res.success) throw new Error(res.error.message);
    return res.data;
  },
  safeParse(input: unknown): ValidationResult<GuestPii> {
    if (!input || typeof input !== 'object') {
      return {
        success: false,
        error: { issues: [{ path: [], message: 'Expected object' }], message: 'Expected object' }
      };
    }
    const val = input as Record<string, unknown>;
    if (!val.name || typeof val.name !== 'string' || val.name.trim().length === 0) {
      const issues = [{ path: ['name'], message: 'Guest name is required' }];
      return { success: false, error: { issues, message: 'name: Guest name is required' } };
    }
    return { success: true, data: normalizePii(val) };
  }
};

export interface CreateBookingInput {
  category: VisitorCategory;
  checkIn: string;
  checkOut: string;
  partySize: number;
  guests: GuestDemand[];
  preferredRoomType?: RoomType;
  isSuiteBooking?: boolean;
}

export const CreateBookingRequestSchema: SchemaValidator<CreateBookingInput> = {
  parse(input: unknown): CreateBookingInput {
    const res = this.safeParse(input);
    if (!res.success) throw new Error(res.error.message);
    return res.data;
  },
  safeParse(input: unknown): ValidationResult<CreateBookingInput> {
    const issues: Array<{ path: string[]; message: string }> = [];
    if (!input || typeof input !== 'object') {
      return {
        success: false,
        error: { issues: [{ path: [], message: 'Expected object' }], message: 'Expected object' }
      };
    }
    const val = input as Record<string, unknown>;

    if (!val.category || !CATEGORIES[val.category as VisitorCategory]) {
      issues.push({ path: ['category'], message: 'Invalid category' });
    }

    const checkIn = val.checkIn as string;
    const checkOut = val.checkOut as string;
    if (!checkIn || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) {
      issues.push({ path: ['checkIn'], message: 'Invalid check-in date (expected YYYY-MM-DD)' });
    }
    if (!checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      issues.push({ path: ['checkOut'], message: 'Invalid check-out date (expected YYYY-MM-DD)' });
    }
    if (checkIn && checkOut && checkOut <= checkIn) {
      issues.push({ path: ['checkOut'], message: 'Check-out date must be strictly after check-in' });
    }

    const partySize = Number(val.partySize);
    if (isNaN(partySize) || partySize < 1 || partySize > 40) {
      issues.push({ path: ['partySize'], message: 'Party size must be between 1 and 40' });
    }

    if (!Array.isArray(val.guests) || val.guests.length !== partySize) {
      issues.push({ path: ['guests'], message: 'Guest count must match party size' });
    } else {
      let primaries = 0;
      val.guests.forEach((g: Record<string, unknown>, idx: number) => {
        const relation = (g.relation as GuestRelation | undefined) ?? (idx === 0 ? 'PRIMARY' : g.rankCode ? 'SERVICE' : 'OTHER');
        if (relation === 'PRIMARY') primaries++;
        if (!g.gender || (g.gender !== 'M' && g.gender !== 'F')) {
          issues.push({ path: ['guests', String(idx), 'gender'], message: 'Gender must be M or F' });
        }
        if (isCivilianRelation(relation)) {
          if (g.rankCode != null) {
            issues.push({ path: ['guests', String(idx), 'rankCode'], message: 'Civilians have no rank' });
          }
        } else if (!g.rankCode || !RANKS.some((r) => r.code === g.rankCode)) {
          issues.push({ path: ['guests', String(idx), 'rankCode'], message: 'Invalid rank code' });
        }
      });
      if (primaries !== 1) {
        issues.push({ path: ['guests'], message: 'A booking needs exactly one primary ranked person' });
      }
    }

    if (issues.length > 0) {
      return {
        success: false,
        error: { issues, message: issues.map((i) => i.message).join('; ') }
      };
    }

    return {
      success: true,
      data: {
        category: val.category as VisitorCategory,
        checkIn,
        checkOut,
        partySize,
        guests: val.guests as GuestDemand[],
        preferredRoomType: (val.preferredRoomType as RoomType) || undefined,
        isSuiteBooking: Boolean(val.isSuiteBooking)
      }
    };
  }
};

export interface DenyRequestInput {
  category: VisitorCategory;
  checkIn: string;
  checkOut: string;
  partySize: number;
  reason: string;
}

export const DenyRequestSchema: SchemaValidator<DenyRequestInput> = {
  parse(input: unknown): DenyRequestInput {
    const res = this.safeParse(input);
    if (!res.success) throw new Error(res.error.message);
    return res.data;
  },
  safeParse(input: unknown): ValidationResult<DenyRequestInput> {
    const issues: Array<{ path: string[]; message: string }> = [];
    const val = input as Record<string, unknown>;

    if (!val.category || (val.category !== 'LEAVE' && val.category !== 'TD')) {
      issues.push({ path: ['category'], message: 'Only LEAVE and TD categories can be denied' });
    }
    if (!val.reason || typeof val.reason !== 'string' || val.reason.trim().length === 0) {
      issues.push({ path: ['reason'], message: 'Denial reason is required' });
    }

    if (issues.length > 0) {
      return {
        success: false,
        error: { issues, message: issues.map((i) => i.message).join('; ') }
      };
    }

    return {
      success: true,
      data: {
        category: val.category as VisitorCategory,
        checkIn: val.checkIn as string,
        checkOut: val.checkOut as string,
        partySize: Number(val.partySize),
        reason: (val.reason as string).trim()
      }
    };
  }
};

export interface ApproveEvictionInput {
  incomingBooking: CreateBookingInput;
  evictAllocationIds: string[];
  reason: string; // Minimum 10 chars
}

export const ApproveEvictionSchema: SchemaValidator<ApproveEvictionInput> = {
  parse(input: unknown): ApproveEvictionInput {
    const res = this.safeParse(input);
    if (!res.success) throw new Error(res.error.message);
    return res.data;
  },
  safeParse(input: unknown): ValidationResult<ApproveEvictionInput> {
    const issues: Array<{ path: string[]; message: string }> = [];
    const val = input as Record<string, unknown>;

    if (!Array.isArray(val.evictAllocationIds) || val.evictAllocationIds.length === 0) {
      issues.push({ path: ['evictAllocationIds'], message: 'At least one allocation must be selected for eviction' });
    }

    const reason = typeof val.reason === 'string' ? val.reason.trim() : '';
    if (reason.length < 10) {
      issues.push({ path: ['reason'], message: 'Written eviction reason must be at least 10 characters' });
    }

    const bookingRes = CreateBookingRequestSchema.safeParse(val.incomingBooking);
    if (!bookingRes.success) {
      issues.push(...bookingRes.error.issues);
    }

    if (issues.length > 0 || !bookingRes.success) {
      return {
        success: false,
        error: { issues, message: issues.map((i) => i.message).join('; ') }
      };
    }

    return {
      success: true,
      data: {
        incomingBooking: bookingRes.data,
        evictAllocationIds: val.evictAllocationIds as string[],
        reason
      }
    };
  }
};
