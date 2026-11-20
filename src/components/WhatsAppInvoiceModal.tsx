import React, { useMemo, useState } from 'react';
import { Check, Copy, MessageCircle, Share2, X } from 'lucide-react';
import {
  buildWhatsAppBusinessLink,
  buildWhatsAppInvoiceText,
  formatCurrency,
  isAndroidDevice,
  round2,
} from '../lib/finance';
import { useBackHandler } from '../lib/backNavigation';
import type { InvoicePayload } from '../types';

interface WhatsAppInvoiceModalProps {
  invoice: InvoicePayload | null;
  onClose: () => void;
}

export const WhatsAppInvoiceModal: React.FC<WhatsAppInvoiceModalProps> = ({
  invoice,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);

  const messageText = useMemo(
    () => (invoice ? buildWhatsAppInvoiceText(invoice) : ''),
    [invoice]
  );

  useBackHandler(Boolean(invoice), onClose);

  const waLink = useMemo(
    () => (invoice ? buildWhatsAppBusinessLink(invoice.clientPhone, messageText) : '#'),
    [invoice, messageText]
  );

  if (!invoice) return null;

  const isAndroid = isAndroidDevice();
  const inIframe = typeof window !== 'undefined' && window.top !== window.self;
  const openInBlankTab = !isAndroid || inIframe;

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback ignored if clipboard permission unavailable
    }
  };

  const handleNativeShare = async () => {
    if (!canNativeShare) return;
    try {
      await navigator.share({
        title: `Factura Akrobit - ${invoice.clientName}`,
        text: messageText,
      });
    } catch {
      // User cancelled share sheet
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/65 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        {/* Top corporate header */}
        <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white">
          <div className="flex items-center gap-2.5">
            <img src="/akrobit-icon.png" alt="Akrobit" className="w-8 h-8 rounded-lg" />
            <div>
              <h3 className="text-sm font-bold leading-tight">Enviar Factura por WhatsApp</h3>
              <p className="text-[11px] text-white/80">
                {invoice.kind === 'consolidated'
                  ? 'Estado de Cuenta Consolidado'
                  : invoice.kind === 'sale'
                    ? `Comprobante de Compra${invoice.moduleLabel ? ` · ${invoice.moduleLabel}` : ''}`
                    : invoice.kind === 'credit'
                      ? 'Comprobante de Crédito'
                      : `Comprobante de Abono${invoice.moduleLabel ? ` · ${invoice.moduleLabel}` : ''}`}
                {invoice.creditLabel && invoice.kind !== 'sale' ? ` · ${invoice.creditLabel}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar factura"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Receipt preview */}
        <div className="p-5 space-y-4 max-h-[78dvh] overflow-y-auto">
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-2.5 text-sm">
            <div className="space-y-1.5">
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Hola!</span>
                <span className="font-bold text-slate-900 text-right">{invoice.clientName}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Teléfono:</span>
                <span className="font-mono text-slate-700">{invoice.clientPhone}</span>
              </div>
              {invoice.creditLabel && invoice.kind !== 'consolidated' && invoice.kind !== 'sale' && (
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Cuenta:</span>
                  <span className="font-bold text-[#145f96]">{invoice.creditLabel}</span>
                </div>
              )}
              {invoice.kind === 'payment' && invoice.paymentMethod && (
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Método interno:</span>
                  <span className="font-bold text-[#145f96] uppercase text-xs">
                    {invoice.paymentMethod === 'cash' ? 'Cash (Efectivo)' : 'Bank (Banco)'}
                  </span>
                </div>
              )}

              {invoice.kind === 'consolidated' ? (
                <div className="pt-2 space-y-2">
                  <div className="rounded-xl border border-slate-200 divide-y divide-slate-200/70 overflow-hidden akrobit-zebra-rows">
                    {(invoice.consolidatedItems || []).map((item, idx) => (
                      <div key={idx} className="px-3 py-2 flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <p className="font-bold text-[#145f96]">
                            {item.label}
                            {typeof item.daysElapsed === 'number' && item.daysElapsed > 0
                              ? ` · ${item.daysElapsed}d`
                              : ''}
                          </p>
                          {item.interestMode !== 'closed' && (
                            <p className="text-[11px] text-slate-500">
                              Cap: {formatCurrency(item.principal, item.currency)} ({item.interestRate}%)
                              {(item.accruedInterest ?? 0) > 0 &&
                                ` · Int: +${formatCurrency(item.accruedInterest ?? 0, item.currency)}`}
                            </p>
                          )}
                        </div>
                        <span className="font-mono font-bold text-slate-900 tabular-nums shrink-0">
                          {formatCurrency(item.currentBalance, item.currency)}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="border-t border-slate-200 pt-2 space-y-1">
                    {(invoice.totalNio ?? 0) > 0 && (
                      <div className="flex justify-between gap-2 text-sm font-bold text-[#145f96]">
                        <span>Total Córdobas:</span>
                        <span className="font-mono tabular-nums">
                          {formatCurrency(invoice.totalNio ?? 0, 'NIO')}
                        </span>
                      </div>
                    )}
                    {(invoice.totalUsd ?? 0) > 0 && (
                      <div className="flex justify-between gap-2 text-sm font-bold text-[#df7729]">
                        <span>Total Dólares:</span>
                        <span className="font-mono tabular-nums">
                          {formatCurrency(invoice.totalUsd ?? 0, 'USD')}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ) : invoice.kind === 'sale' ? (
                <>
                  {invoice.productName && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Detalle:</span>
                      <span className="font-bold text-slate-900 text-right">
                        {invoice.productName}
                        {invoice.quantitySold && invoice.quantitySold > 1
                          ? ` (x${invoice.quantitySold})`
                          : ''}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Total:</span>
                    <span className="font-mono font-bold text-[#145f96] tabular-nums">
                      {formatCurrency(invoice.amount, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Saldo anterior:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(invoice.previousBalance, invoice.currency)}
                    </span>
                  </div>
                  <div className="border-t border-slate-200 pt-2 flex justify-between gap-2 text-base font-bold text-[#145f96]">
                    <span>Saldo actual:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(invoice.newBalance, invoice.currency)}
                    </span>
                  </div>
                </>
              ) : invoice.kind === 'credit' ? (
                invoice.interestMode === 'prorated_daily' ? (
                  <>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Capital otorgado:</span>
                      <span className="font-mono font-bold text-[#145f96] tabular-nums">
                        {formatCurrency(invoice.amount, invoice.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">
                        Tasa mensual ({invoice.interestRate}%):
                      </span>
                      <span className="font-semibold text-slate-700 text-right">
                        Proporcional al día de pago
                      </span>
                    </div>
                    <div className="border-t border-slate-200 pt-2 flex justify-between gap-2 text-sm font-bold text-[#145f96]">
                      <span>Referencia a 30 días:</span>
                      <span className="font-mono tabular-nums">
                        {formatCurrency(
                          invoice.projected30DayTotal ??
                            round2(invoice.amount + (invoice.projected30DayInterest ?? 0)),
                          invoice.currency
                        )}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Capital otorgado:</span>
                      <span className="font-mono font-semibold tabular-nums">
                        {formatCurrency(invoice.amount, invoice.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Porcentaje ({invoice.interestRate}%):</span>
                      <span className="font-mono font-semibold tabular-nums">
                        {formatCurrency(round2(invoice.newBalance - invoice.amount), invoice.currency)}
                      </span>
                    </div>
                    <div className="border-t border-slate-200 pt-2 flex justify-between gap-2 text-base font-bold text-[#145f96]">
                      <span>Total crédito:</span>
                      <span className="font-mono tabular-nums">
                        {formatCurrency(invoice.newBalance, invoice.currency)}
                      </span>
                    </div>
                  </>
                )
              ) : invoice.interestMode === 'closed' ? (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Saldo anterior:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(invoice.previousBalance, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Abono realizado:</span>
                    <span className="font-mono font-bold text-[#4d7c0f] tabular-nums">
                      - {formatCurrency(invoice.amount, invoice.currency)}
                    </span>
                  </div>
                  <div className="border-t border-slate-200 pt-2 flex justify-between gap-2 text-base font-bold text-[#145f96]">
                    <span>Nuevo saldo:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(invoice.newBalance, invoice.currency)}
                    </span>
                  </div>
                </>
              ) : invoice.interestMode === 'prorated_daily' ? (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Capital anterior:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(invoice.previousBalance, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">
                      Interés ({invoice.daysElapsed ?? 0} día{(invoice.daysElapsed ?? 0) === 1 ? '' : 's'} · {invoice.interestRate}%):
                    </span>
                    <span className="font-mono font-semibold text-[#df7729] tabular-nums">
                      + {formatCurrency(invoice.accruedInterest ?? 0, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Total exigible al día:</span>
                    <span className="font-mono font-semibold tabular-nums">
                      {formatCurrency(
                        invoice.totalDueToday ??
                          round2(invoice.previousBalance + (invoice.accruedInterest ?? 0)),
                        invoice.currency
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Abono realizado:</span>
                    <span className="font-mono font-bold text-[#4d7c0f] tabular-nums">
                      - {formatCurrency(invoice.amount, invoice.currency)}
                    </span>
                  </div>
                  <div className="border-t border-slate-200 pt-2 flex justify-between gap-2 text-base font-bold text-[#145f96]">
                    <span>Nuevo saldo capital:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(invoice.newBalance, invoice.currency)}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Saldo anterior:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(invoice.previousBalance, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Abono realizado:</span>
                    <span className="font-mono font-bold text-[#4d7c0f] tabular-nums">
                      - {formatCurrency(invoice.amount, invoice.currency)}
                    </span>
                  </div>
                  {(invoice.remainingBeforeInterest ?? 0) > 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">
                        Interés s/saldo ({invoice.interestRate}%):
                      </span>
                      <span className="font-mono tabular-nums">
                        + {formatCurrency(invoice.interestAdded ?? 0, invoice.currency)}
                      </span>
                    </div>
                  )}
                  <div className="border-t border-slate-200 pt-2 flex justify-between gap-2 text-base font-bold text-[#145f96]">
                    <span>Nuevo saldo:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(invoice.newBalance, invoice.currency)}
                    </span>
                  </div>
                </>
              )}

              {invoice.portalCode && (
                <div className="border-t border-slate-200 pt-2 flex justify-between gap-2 text-xs">
                  <span className="text-slate-500">Código portal cliente:</span>
                  <span className="font-mono font-bold text-[#145f96] tracking-wider">
                    {invoice.portalCode}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Primary WhatsApp Action */}
          <a
            href={waLink}
            target={openInBlankTab ? '_blank' : undefined}
            rel={openInBlankTab ? 'noopener noreferrer' : undefined}
            className="w-full min-h-[48px] rounded-xl bg-[#25D366] hover:bg-[#1fb857] text-slate-950 font-bold text-sm shadow-md flex items-center justify-center gap-2.5 transition-colors"
          >
            <MessageCircle className="w-5 h-5" />
            <span>Enviar Factura por WhatsApp</span>
          </a>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="flex-1 min-h-[44px] rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {copied ? <Check className="w-4 h-4 text-[#4d7c0f]" /> : <Copy className="w-4 h-4" />}
              <span>{copied ? 'Copiado' : 'Copiar texto'}</span>
            </button>

            {canNativeShare && (
              <button
                type="button"
                onClick={handleNativeShare}
                className="flex-1 min-h-[44px] rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Share2 className="w-4 h-4" />
                <span>Compartir</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-xs cursor-pointer"
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
