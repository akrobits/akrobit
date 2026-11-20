export type CurrencyCode = 'NIO' | 'USD';

export type UserRole = 'admin' | 'employee';

export type PaymentMethod = 'cash' | 'bank';

export type ProfitType = 'amount' | 'percent';

export type ProductCategory = 'recharge' | 'general';

export type RechargeCarrier = 'claro' | 'tigo' | 'none';

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

export type PortfolioStatus = 'active' | 'castigada';

export interface Client {
  id: string;
  name: string;
  phone: string;
  notes?: string;
  portalCode?: string;
  portalKey?: string;
  moduleId?: string;
  portfolioStatus?: PortfolioStatus;
  sourceModule?: string;
  castigadaAt?: unknown;
  castigadaBy?: string;
  castigadaByName?: string;
  orgId: 'akrobit';
  createdBy: string;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type CreditInterestMode = 'prorated_daily' | 'pre_added' | 'closed';

export interface Credit {
  id: string;
  clientId: string;
  clientName: string;
  moduleId?: string;
  currency: CurrencyCode;
  principal: number;
  interestRate: number;
  initialTotal: number;
  currentBalance: number;
  status: 'active' | 'settled';
  interestMode?: CreditInterestMode;
  lastPaymentAt?: unknown;
  frozenDays?: number;
  frozenAccruedInterest?: number;
  frozenAt?: unknown;
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
  moduleId?: string;
  type: 'credit' | 'sale' | 'payment' | 'adjustment';
  currency: CurrencyCode;
  amount: number;
  interestRate: number;
  previousBalance: number;
  newBalance: number;
  paymentMethod?: PaymentMethod;
  productId?: string;
  productName?: string;
  quantitySold?: number;
  costAmount?: number;
  profitType?: ProfitType;
  profitValue?: number;
  profitAmount?: number;
  commissionAmount?: number;
  netProfitAmount?: number;
  note?: string;
  orgId: 'akrobit';
  createdBy: string;
  createdByName: string;
  createdAt?: unknown;
  hasPendingWrites?: boolean;
}

export interface Product {
  id: string;
  name: string;
  barcode?: string;
  category: ProductCategory;
  carrier?: RechargeCarrier;
  currency: CurrencyCode;
  quantity: number;
  costPrice: number;
  salesCommission: number;
  profitType: ProfitType;
  profitValue: number;
  orgId: 'akrobit';
  createdBy: string;
  createdByName?: string;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ModificationRequest {
  id: string;
  targetType: 'credit' | 'transaction';
  creditId: string;
  transactionId?: string;
  clientId: string;
  clientName: string;
  moduleId?: string;
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
  isFrozen?: boolean;
  frozenDays?: number;
  frozenAccruedInterest?: number;
}

export interface PortalTransactionItem {
  type: 'credit' | 'sale' | 'payment' | 'adjustment';
  currency: CurrencyCode;
  amount: number;
  interestRate: number;
  previousBalance: number;
  newBalance: number;
  paymentMethod?: PaymentMethod;
  productName?: string;
  note?: string;
  dateLabel: string;
}

export interface ClientPortalSnapshot {
  id: string;
  clientId: string;
  clientName: string;
  moduleId?: string;
  moduleLabel?: string;
  orgId: 'akrobit';
  totalNio: number;
  totalUsd: number;
  activeCredits: PortalCreditItem[];
  recentTransactions: PortalTransactionItem[];
  portfolioStatus?: PortfolioStatus;
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
  interestMode?: CreditInterestMode;
}

export interface InvoicePayload {
  kind: 'credit' | 'sale' | 'payment' | 'consolidated';
  moduleLabel?: string;
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
  productName?: string;
  quantitySold?: number;
  paymentMethod?: PaymentMethod;
  consolidatedItems?: ConsolidatedCreditItem[];
  totalNio?: number;
  totalUsd?: number;
  portalUrl?: string;
  portalCode?: string;
  attendedBy: string;
  dateLabel: string;
  referenceId: string;
}
