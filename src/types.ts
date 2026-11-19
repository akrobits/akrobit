export type CurrencyCode = 'NIO' | 'USD';

export type UserRole = 'admin' | 'employee';

export interface UserProfile {
  uid: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  isOnline?: boolean;
  lastSeenAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Client {
  id: string;
  name: string;
  phone: string;
  notes?: string;
  portalCode?: string;
  portalKey?: string;
  orgId: 'akrobit';
  createdBy: string;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type CreditInterestMode = 'prorated_daily' | 'pre_added';

export interface Credit {
  id: string;
  clientId: string;
  clientName: string;
  currency: CurrencyCode;
  principal: number;
  interestRate: number;
  initialTotal: number;
  currentBalance: number;
  status: 'active' | 'settled';
  interestMode?: CreditInterestMode;
  lastPaymentAt?: unknown;
  orgId: 'akrobit';
  createdBy: string;
  createdByName: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  hasPendingWrites?: boolean;
}

export interface CreditTransaction {
  id: string;
  creditId: string;
  clientId: string;
  type: 'credit' | 'payment' | 'adjustment';
  currency: CurrencyCode;
  amount: number;
  interestRate: number;
  previousBalance: number;
  newBalance: number;
  note?: string;
  orgId: 'akrobit';
  createdBy: string;
  createdByName: string;
  createdAt?: unknown;
  hasPendingWrites?: boolean;
}

export interface ModificationRequest {
  id: string;
  targetType: 'credit' | 'transaction';
  creditId: string;
  transactionId?: string;
  clientId: string;
  clientName: string;
  currency: CurrencyCode;
  oldValue: number;
  newValue: number;
  oldInterestRate: number;
  newInterestRate: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'corrected';
  orgId: 'akrobit';
  requestedBy: string;
  requestedByName: string;
  reviewedBy?: string;
  reviewedByName?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PortalCreditItem {
  label: string;
  currency: CurrencyCode;
  principal: number;
  interestRate: number;
  currentBalance: number;
  dateLabel: string;
  lastActivityMs?: number;
  interestMode?: CreditInterestMode;
  projected30DayInterest?: number;
  projected30DayTotal?: number;
}

export interface PortalTransactionItem {
  type: 'credit' | 'payment' | 'adjustment';
  currency: CurrencyCode;
  amount: number;
  interestRate: number;
  previousBalance: number;
  newBalance: number;
  note?: string;
  dateLabel: string;
}

export interface ClientPortalSnapshot {
  id: string;
  clientId: string;
  clientName: string;
  orgId: 'akrobit';
  totalNio: number;
  totalUsd: number;
  activeCredits: PortalCreditItem[];
  recentTransactions: PortalTransactionItem[];
  updatedAt?: unknown;
}

export interface ConsolidatedCreditItem {
  label: string;
  currency: CurrencyCode;
  principal: number;
  interestRate: number;
  currentBalance: number;
  dateLabel: string;
  daysElapsed?: number;
  accruedInterest?: number;
}

export interface InvoicePayload {
  kind: 'credit' | 'payment' | 'consolidated';
  clientName: string;
  clientPhone: string;
  currency: CurrencyCode;
  amount: number;
  interestRate: number;
  previousBalance: number;
  remainingBeforeInterest?: number;
  interestAdded?: number;
  newBalance: number;
  daysElapsed?: number;
  accruedInterest?: number;
  totalDueToday?: number;
  projected30DayInterest?: number;
  projected30DayTotal?: number;
  interestMode?: CreditInterestMode;
  creditLabel?: string;
  consolidatedItems?: ConsolidatedCreditItem[];
  totalNio?: number;
  totalUsd?: number;
  portalUrl?: string;
  portalCode?: string;
  attendedBy: string;
  dateLabel: string;
  referenceId: string;
}
