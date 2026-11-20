import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  MoreVertical,
  Package,
  PackagePlus,
  Pencil,
  ScanBarcode,
  Search,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { ORG_ID, db } from '../lib/firebase';
import {
  calculateProductPricing,
  formatCurrency,
  generateDocId,
  round2,
} from '../lib/finance';
import { useBackHandler } from '../lib/backNavigation';
import type {
  CurrencyCode,
  Product,
  ProductCategory,
  ProfitType,
  RechargeCarrier,
} from '../types';

interface InventoryModuleProps {
  products: Product[];
  currentUserId: string;
  currentUserName: string;
  isAdmin: boolean;
  onBackToDashboard: () => void;
}

type ModalMode =
  | 'none'
  | 'add_choice'
  | 'scan'
  | 'add_form'
  | 'edit_pick'
  | 'edit_form'
  | 'delete_pick'
  | 'delete_confirm';

type ProductPreset = 'general' | 'claro' | 'tigo';

interface BarcodeDetectorLike {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
}

async function commitWithOfflineGrace(promise: Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => setTimeout(resolve, 1200)),
    ]);
    return;
  }
  await promise;
}

export const InventoryModule: React.FC<InventoryModuleProps> = ({
  products,
  currentUserId,
  currentUserName,
  isAdmin,
  onBackToDashboard,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>('none');
  const [targetProduct, setTargetProduct] = useState<Product | null>(null);

  // Product form fields
  const [preset, setPreset] = useState<ProductPreset>('general');
  const [formName, setFormName] = useState('');
  const [formBarcode, setFormBarcode] = useState('');
  const [formCurrency, setFormCurrency] = useState<CurrencyCode>('NIO');
  const [formQuantity, setFormQuantity] = useState('');
  const [formCostPrice, setFormCostPrice] = useState('');
  const [formCommission, setFormCommission] = useState('');
  const [formProfitType, setFormProfitType] = useState<ProfitType>('amount');
  const [formProfitValue, setFormProfitValue] = useState('');

  // Scanner state
  const [scanError, setScanError] = useState('');
  const [manualScanCode, setManualScanCode] = useState('');
  const [scannedExisting, setScannedExisting] = useState<Product | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);

  const [formError, setFormError] = useState('');
  const [toastMsg, setToastMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const stopCamera = () => {
    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const closeAllModals = () => {
    stopCamera();
    setFormError('');
    setScanError('');
    setScannedExisting(null);
    setModalMode('none');
    setTargetProduct(null);
  };

  useBackHandler(menuOpen, () => setMenuOpen(false));
  useBackHandler(modalMode !== 'none', closeAllModals);

  useEffect(() => {
    return () => stopCamera();
  }, []);

  const activeProducts = useMemo(() => {
    return [...products]
      .filter((p) => p.active !== false)
      .sort((a, b) => {
        const aRank = a.carrier === 'claro' ? 0 : a.carrier === 'tigo' ? 1 : 2;
        const bRank = b.carrier === 'claro' ? 0 : b.carrier === 'tigo' ? 1 : 2;
        if (aRank !== bRank) return aRank - bRank;
        return a.name.localeCompare(b.name, 'es');
      });
  }, [products]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return activeProducts;
    return activeProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.barcode || '').toLowerCase().includes(q) ||
        (p.carrier || '').toLowerCase().includes(q)
    );
  }, [activeProducts, searchQuery]);

  const resetForm = (nextPreset: ProductPreset = 'general', initialBarcode = '') => {
    setPreset(nextPreset);
    setFormError('');
    setFormBarcode(initialBarcode);
    if (nextPreset === 'claro') {
      setFormName('Recarga Claro');
      setFormCurrency('NIO');
      setFormQuantity('');
      setFormCostPrice('1');
      setFormCommission('0');
      setFormProfitType('percent');
      setFormProfitValue('10');
    } else if (nextPreset === 'tigo') {
      setFormName('Recarga Tigo');
      setFormCurrency('NIO');
      setFormQuantity('');
      setFormCostPrice('1');
      setFormCommission('0');
      setFormProfitType('percent');
      setFormProfitValue('10');
    } else {
      setFormName('');
      setFormCurrency('NIO');
      setFormQuantity('');
      setFormCostPrice('');
      setFormCommission('0');
      setFormProfitType('amount');
      setFormProfitValue('');
    }
  };

  const populateFormForEdit = (product: Product) => {
    const nextPreset: ProductPreset =
      product.category === 'recharge' && product.carrier === 'claro'
        ? 'claro'
        : product.category === 'recharge' && product.carrier === 'tigo'
          ? 'tigo'
          : 'general';
    setTargetProduct(product);
    setPreset(nextPreset);
    setFormName(product.name);
    setFormBarcode(product.barcode || '');
    setFormCurrency(product.currency || 'NIO');
    setFormQuantity(String(product.quantity));
    setFormCostPrice(String(product.costPrice));
    setFormCommission(String(product.salesCommission ?? 0));
    setFormProfitType(product.profitType || 'amount');
    setFormProfitValue(String(product.profitValue ?? 0));
    setFormError('');
    setModalMode('edit_form');
  };

  const handleBarcodeDetected = (rawCode: string) => {
    const cleanCode = rawCode.trim().slice(0, 80);
    if (!cleanCode) return;
    stopCamera();

    const existing = activeProducts.find(
      (p) => (p.barcode || '').trim().toLowerCase() === cleanCode.toLowerCase()
    );
    if (existing) {
      setScannedExisting(existing);
      setManualScanCode(cleanCode);
      return;
    }

    resetForm('general', cleanCode);
    setModalMode('add_form');
  };

  // Start camera when modalMode === 'scan'
  useEffect(() => {
    if (modalMode !== 'scan') {
      stopCamera();
      return;
    }

    let cancelled = false;
    setScanError('');
    setScannedExisting(null);
    setManualScanCode('');

    const startCamera = async () => {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        setScanError(
          'Este navegador no permite abrir la cámara directamente. Escribe el código de barras manualmente abajo.'
        );
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {
            // Autoplay fallback
          });
        }

        const win = window as unknown as {
          BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
        };

        if (typeof win.BarcodeDetector === 'function') {
          const detector = new win.BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
          });

          scanTimerRef.current = window.setInterval(async () => {
            if (!videoRef.current || videoRef.current.readyState < 2) return;
            try {
              const codes = await detector.detect(videoRef.current);
              const first = codes.find((c) => c.rawValue && c.rawValue.trim().length > 0);
              if (first?.rawValue) {
                handleBarcodeDetected(first.rawValue);
              }
            } catch {
              // Ignore single-frame detection errors
            }
          }, 350);
        } else {
          setScanError(
            'Tu cámara está activa. Si tu dispositivo no detecta el código automáticamente, ingrésalo abajo y presiona Continuar.'
          );
        }
      } catch {
        if (!cancelled) {
          setScanError(
            'No se pudo acceder a la cámara (revisa los permisos). Puedes escribir el código de barras abajo.'
          );
        }
      }
    };

    void startCamera();

    return () => {
      cancelled = true;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalMode]);

  const isRechargePreset = preset === 'claro' || preset === 'tigo';
  const parsedQty = Number(formQuantity);
  const parsedCost = Number(formCostPrice);
  const parsedCommission = Number(formCommission) || 0;
  const parsedProfitVal = Number(formProfitValue) || 0;

  const previewPricing = useMemo(() => {
    const sampleCost = isRechargePreset ? 100 : Math.max(0, Number.isFinite(parsedCost) ? parsedCost : 0);
    return calculateProductPricing({
      costAmount: sampleCost,
      profitType: isRechargePreset ? 'percent' : formProfitType,
      profitValue: isRechargePreset ? 10 : parsedProfitVal,
      commissionAmount: Math.max(0, parsedCommission),
    });
  }, [isRechargePreset, parsedCost, formProfitType, parsedProfitVal, parsedCommission]);

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const cleanName = formName.trim();
    if (!cleanName) {
      setFormError('Escribe el nombre del producto.');
      return;
    }
    if (!Number.isFinite(parsedQty) || parsedQty < 0) {
      setFormError('Ingresa una cantidad válida (0 o mayor).');
      return;
    }

    const effectiveCost = isRechargePreset
      ? 1
      : Number.isFinite(parsedCost) && parsedCost >= 0
        ? round2(parsedCost)
        : -1;

    if (effectiveCost < 0) {
      setFormError('Ingresa un precio de costo válido.');
      return;
    }
    if (!Number.isFinite(parsedCommission) || parsedCommission < 0) {
      setFormError('La comisión por venta no puede ser negativa.');
      return;
    }
    if (!Number.isFinite(parsedProfitVal) || parsedProfitVal < 0) {
      setFormError('La ganancia debe ser un número válido (0 o mayor).');
      return;
    }

    const category: ProductCategory = isRechargePreset ? 'recharge' : 'general';
    const carrier: RechargeCarrier =
      preset === 'claro' ? 'claro' : preset === 'tigo' ? 'tigo' : 'none';
    const finalProfitType: ProfitType = isRechargePreset ? 'percent' : formProfitType;
    const finalProfitValue = isRechargePreset ? 10 : round2(parsedProfitVal);

    setSaving(true);
    try {
      if (modalMode === 'edit_form' && targetProduct) {
        await commitWithOfflineGrace(
          updateDoc(doc(db, 'products', targetProduct.id), {
            name: cleanName.slice(0, 120),
            barcode: formBarcode.trim().slice(0, 80),
            category,
            carrier,
            currency: isRechargePreset ? 'NIO' : formCurrency,
            quantity: round2(parsedQty),
            costPrice: effectiveCost,
            salesCommission: round2(parsedCommission),
            profitType: finalProfitType,
            profitValue: finalProfitValue,
            updatedAt: serverTimestamp(),
          })
        );
        setToastMsg(`Producto actualizado: ${cleanName}`);
      } else {
        const id = generateDocId('prd');
        const newProduct: Product = {
          id,
          name: cleanName.slice(0, 120),
          barcode: formBarcode.trim().slice(0, 80),
          category,
          carrier,
          currency: isRechargePreset ? 'NIO' : formCurrency,
          quantity: round2(parsedQty),
          costPrice: effectiveCost,
          salesCommission: round2(parsedCommission),
          profitType: finalProfitType,
          profitValue: finalProfitValue,
          orgId: ORG_ID,
          createdBy: currentUserId,
          createdByName: currentUserName,
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        await commitWithOfflineGrace(setDoc(doc(db, 'products', id), newProduct));
        setToastMsg(`Producto agregado al inventario: ${cleanName}`);
      }

      setTimeout(() => setToastMsg(''), 4000);
      closeAllModals();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFormError(`No se pudo guardar el producto: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProduct = async () => {
    if (!targetProduct) return;
    if (!isAdmin) {
      setFormError('Solo el Administrador puede eliminar productos de raíz.');
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      await commitWithOfflineGrace(deleteDoc(doc(db, 'products', targetProduct.id)));
      setToastMsg(`Producto eliminado de raíz: ${targetProduct.name}`);
      setTimeout(() => setToastMsg(''), 4000);
      closeAllModals();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFormError(`No se pudo eliminar el producto: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-3 sm:px-6 py-4 space-y-4">
      {/* Module Compact Banner */}
      <div className="rounded-2xl bg-[#145f96] text-white px-4 py-3 flex items-center justify-between gap-3 border-b-2 border-[#a1d63e] shadow-sm">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-[#a1d63e] flex items-center justify-center shrink-0">
            <Package className="w-5 h-5 text-slate-950" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold truncate">Inventario</h2>
            <p className="text-[11px] text-white/80 truncate">
              {activeProducts.length} producto(s) registrado(s) · Recargas y catálogo general
            </p>
          </div>
        </div>
      </div>

      {/* Top Internal Bar: Back + Search + 3-dot Menu */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBackToDashboard}
          aria-label="Volver al panel principal"
          className="min-h-[46px] min-w-[46px] flex items-center justify-center rounded-xl bg-white border border-slate-200 text-[#145f96] hover:bg-slate-50 shadow-sm cursor-pointer shrink-0"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="relative flex-1">
          <Search className="w-4 h-4 text-[#145f96] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar producto o código..."
            className="w-full min-h-[46px] rounded-xl bg-white border-2 border-[#145f96]/20 pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#69b8e9] focus:outline-none shadow-sm"
          />
        </div>

        {/* 3-dot Menu: Agregar Producto | Editar Producto | Eliminar Producto */}
        <div className="relative shrink-0">
          <button
            type="button"
            aria-label="Opciones de inventario"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="min-h-[46px] min-w-[46px] flex items-center justify-center rounded-xl bg-[#145f96] text-white hover:bg-[#0e4670] shadow-sm cursor-pointer"
          >
            <MoreVertical className="w-5 h-5" />
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
                aria-hidden="true"
              />
              <div className="absolute right-0 mt-1.5 w-56 rounded-xl bg-white border border-slate-200 shadow-xl py-1.5 z-20">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setModalMode('add_choice');
                  }}
                  className="w-full px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:bg-[#a1d63e]/15 flex items-center gap-2.5 cursor-pointer"
                >
                  <PackagePlus className="w-4 h-4 text-[#4d7c0f]" />
                  <span>Agregar Producto</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setModalMode('edit_pick');
                  }}
                  className="w-full px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:bg-[#69b8e9]/15 flex items-center gap-2.5 cursor-pointer"
                >
                  <Pencil className="w-4 h-4 text-[#145f96]" />
                  <span>Editar Producto</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setModalMode('delete_pick');
                  }}
                  className="w-full px-4 py-3 text-left text-sm font-semibold text-[#d12925] hover:bg-[#d12925]/10 flex items-center gap-2.5 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Eliminar Producto</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {toastMsg && (
        <div className="rounded-xl bg-[#a1d63e]/20 border border-[#a1d63e]/60 px-4 py-2.5 text-xs font-bold text-slate-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-[#4d7c0f] shrink-0" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Zebra-striped Products List */}
      {activeProducts.length === 0 ? (
        <div className="py-12 text-center space-y-2">
          <p className="text-xs text-slate-400">
            Sin productos registrados en el inventario. Usa el menú (⋮) para agregar recargas Claro,
            Tigo o productos generales.
          </p>
        </div>
      ) : filteredProducts.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-500">
          No se encontraron productos que coincidan con "{searchQuery}".
        </div>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-200/70 shadow-sm overflow-hidden akrobit-zebra-rows">
          {filteredProducts.map((product) => {
            const isRecharge = product.category === 'recharge';
            const pricing = calculateProductPricing({
              costAmount: isRecharge ? 100 : product.costPrice,
              profitType: product.profitType,
              profitValue: product.profitValue,
              commissionAmount: product.salesCommission,
            });
            const lowStock = isRecharge ? product.quantity < 100 : product.quantity <= 2;

            return (
              <button
                key={product.id}
                type="button"
                onClick={() => populateFormForEdit(product)}
                className="w-full min-h-[68px] px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[#69b8e9]/20 transition-colors cursor-pointer"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    {product.carrier === 'claro' && (
                      <span className="text-sm shrink-0" aria-hidden="true">
                        🔴
                      </span>
                    )}
                    {product.carrier === 'tigo' && (
                      <span className="text-sm shrink-0" aria-hidden="true">
                        🔵
                      </span>
                    )}
                    <p className="text-sm font-bold text-slate-900 truncate">{product.name}</p>
                  </div>
                  <p className="text-xs text-slate-500 truncate">
                    {isRecharge ? (
                      <>
                        Recarga · Ganancia fija: <strong className="text-[#145f96]">10%</strong>
                        {product.salesCommission > 0 &&
                          ` · Com: ${formatCurrency(product.salesCommission, product.currency)}`}
                      </>
                    ) : (
                      <>
                        Costo: {formatCurrency(product.costPrice, product.currency)} · Gan:{' '}
                        <strong className="text-[#4d7c0f]">
                          {product.profitType === 'percent'
                            ? `${product.profitValue}%`
                            : `+${formatCurrency(product.profitValue, product.currency)}`}
                        </strong>
                        {product.salesCommission > 0 &&
                          ` · Com: ${formatCurrency(product.salesCommission, product.currency)}`}
                      </>
                    )}
                  </p>
                  {product.barcode && (
                    <p className="text-[11px] font-mono text-slate-400 truncate">
                      Cód: {product.barcode}
                    </p>
                  )}
                </div>

                <div className="text-right shrink-0 font-mono text-xs tabular-nums">
                  <p
                    className={`font-bold ${
                      lowStock ? 'text-[#d12925]' : 'text-[#145f96]'
                    }`}
                  >
                    {isRecharge
                      ? formatCurrency(product.quantity, product.currency)
                      : `${product.quantity} ud${product.quantity === 1 ? '' : 's'}`}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {isRecharge
                      ? 'Saldo disp.'
                      : `Venta: ${formatCurrency(pricing.saleTotal, product.currency)}`}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* MODAL: CHOICE (Escanear Producto vs Registrar Producto) */}
      {modalMode === 'add_choice' && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-sm p-0 sm:p-4">
          <div className="w-full sm:max-w-sm rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white">
              <h3 className="text-base font-bold">Agregar Producto</h3>
              <button
                type="button"
                onClick={closeAllModals}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <button
                type="button"
                onClick={() => setModalMode('scan')}
                className="w-full min-h-[58px] rounded-xl bg-[#145f96] hover:bg-[#0e4670] text-white px-4 py-3 flex items-center gap-3 text-left shadow-sm transition-colors cursor-pointer"
              >
                <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
                  <ScanBarcode className="w-5 h-5 text-[#a1d63e]" />
                </div>
                <div>
                  <p className="text-sm font-bold">Escanear Producto</p>
                  <p className="text-[11px] text-white/80">
                    Escanea código de barras o QR con la cámara
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  resetForm('general');
                  setModalMode('add_form');
                }}
                className="w-full min-h-[58px] rounded-xl bg-white hover:bg-slate-50 border-2 border-[#145f96]/25 text-slate-900 px-4 py-3 flex items-center gap-3 text-left shadow-sm transition-colors cursor-pointer"
              >
                <div className="w-10 h-10 rounded-xl bg-[#a1d63e]/25 flex items-center justify-center shrink-0">
                  <PackagePlus className="w-5 h-5 text-[#4d7c0f]" />
                </div>
                <div>
                  <p className="text-sm font-bold text-[#145f96]">Registrar Producto</p>
                  <p className="text-[11px] text-slate-500">
                    Registro manual (Recargas Claro/Tigo o general)
                  </p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: ESCANEAR PRODUCTO */}
      {modalMode === 'scan' && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 backdrop-blur-sm p-0 sm:p-4">
          <div className="w-full sm:max-w-md max-h-[92dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white shrink-0">
              <div className="flex items-center gap-2">
                <Camera className="w-5 h-5 text-[#a1d63e]" />
                <h3 className="text-base font-bold">Escanear Producto</h3>
              </div>
              <button
                type="button"
                onClick={closeAllModals}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              <div className="relative rounded-2xl overflow-hidden bg-slate-900 aspect-[4/3] border-2 border-[#145f96]/30 flex items-center justify-center">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <div className="pointer-events-none absolute inset-x-8 top-1/2 -translate-y-1/2 h-0.5 bg-[#a1d63e] shadow-[0_0_8px_#a1d63e]" />
              </div>

              {scanError && (
                <p className="text-xs text-slate-600 bg-slate-100 border border-slate-200 rounded-xl px-3 py-2">
                  {scanError}
                </p>
              )}

              {scannedExisting && (
                <div className="rounded-xl bg-[#a1d63e]/15 border border-[#a1d63e]/50 p-3.5 space-y-2.5">
                  <p className="text-xs font-bold text-[#145f96]">
                    Producto ya registrado: {scannedExisting.name}
                  </p>
                  <p className="text-xs text-slate-600">
                    Stock actual: <strong>{scannedExisting.quantity}</strong> · Código:{' '}
                    <span className="font-mono">{scannedExisting.barcode}</span>
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => populateFormForEdit(scannedExisting)}
                      className="flex-1 min-h-[40px] rounded-xl bg-[#145f96] text-white text-xs font-bold cursor-pointer"
                    >
                      Editar / Reabastecer
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        resetForm('general', manualScanCode);
                        setModalMode('add_form');
                      }}
                      className="px-3 min-h-[40px] rounded-xl bg-white border border-slate-300 text-slate-700 text-xs font-semibold cursor-pointer"
                    >
                      Crear nuevo
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  Código de barras (escaneado o manual)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={manualScanCode}
                    onChange={(e) => setManualScanCode(e.target.value)}
                    placeholder="Ej. 7501055300075"
                    className="flex-1 min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => handleBarcodeDetected(manualScanCode)}
                    disabled={!manualScanCode.trim()}
                    className="min-h-[44px] px-4 rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] disabled:opacity-50 text-slate-950 font-bold text-xs cursor-pointer"
                  >
                    Continuar
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: REGISTRAR O EDITAR PRODUCTO */}
      {(modalMode === 'add_form' || modalMode === 'edit_form') && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-sm p-0 sm:p-4">
          <div className="w-full sm:max-w-md max-h-[92dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white shrink-0">
              <h3 className="text-base font-bold">
                {modalMode === 'edit_form' ? 'Editar Producto' : 'Registrar Producto'}
              </h3>
              <button
                type="button"
                onClick={closeAllModals}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="p-5 space-y-3.5 overflow-y-auto">
              {formError && (
                <p className="text-xs font-semibold text-[#d12925] bg-[#d12925]/10 border border-[#d12925]/25 rounded-xl px-3 py-2">
                  {formError}
                </p>
              )}

              {/* Quick Category Selector */}
              <div>
                <span className="block text-xs font-bold text-slate-700 mb-1.5">
                  Categoría del producto
                </span>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setPreset('general');
                      if (formName === 'Recarga Claro' || formName === 'Recarga Tigo') {
                        setFormName('');
                      }
                    }}
                    className={`min-h-[42px] rounded-xl border-2 px-2 text-xs font-bold flex items-center justify-center gap-1 cursor-pointer ${
                      preset === 'general'
                        ? 'bg-[#145f96] border-[#145f96] text-white'
                        : 'bg-white border-slate-200 text-slate-700'
                    }`}
                  >
                    <Package className="w-3.5 h-3.5 shrink-0" />
                    <span>General</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPreset('claro');
                      if (!formName || formName === 'Recarga Tigo') setFormName('Recarga Claro');
                      setFormCurrency('NIO');
                      setFormCostPrice('1');
                      setFormProfitType('percent');
                      setFormProfitValue('10');
                    }}
                    className={`min-h-[42px] rounded-xl border-2 px-2 text-xs font-bold flex items-center justify-center gap-1 cursor-pointer ${
                      preset === 'claro'
                        ? 'bg-[#d12925] border-[#d12925] text-white'
                        : 'bg-white border-slate-200 text-slate-700'
                    }`}
                  >
                    <span>🔴</span>
                    <span>Claro</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPreset('tigo');
                      if (!formName || formName === 'Recarga Claro') setFormName('Recarga Tigo');
                      setFormCurrency('NIO');
                      setFormCostPrice('1');
                      setFormProfitType('percent');
                      setFormProfitValue('10');
                    }}
                    className={`min-h-[42px] rounded-xl border-2 px-2 text-xs font-bold flex items-center justify-center gap-1 cursor-pointer ${
                      preset === 'tigo'
                        ? 'bg-[#0284c7] border-[#0284c7] text-white'
                        : 'bg-white border-slate-200 text-slate-700'
                    }`}
                  >
                    <span>🔵</span>
                    <span>Tigo</span>
                  </button>
                </div>
              </div>

              {isRechargePreset && (
                <div className="rounded-xl bg-[#69b8e9]/15 border border-[#69b8e9]/40 px-3 py-2 text-[11px] text-[#145f96] flex items-start gap-2">
                  <Smartphone className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    Recarga telefónica con <strong>10% fijo</strong>. En <strong>Cantidad</strong>{' '}
                    ingresa el saldo disponible en C$ (se descontará automáticamente el costo de cada
                    recarga vendida).
                  </span>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Nombre del producto
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={isRechargePreset ? 'Ej. Recarga Claro' : 'Ej. Cuaderno Universitario'}
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {isRechargePreset ? 'Saldo disponible (C$)' : 'Cantidad (Stock)'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    value={formQuantity}
                    onChange={(e) => setFormQuantity(e.target.value)}
                    placeholder={isRechargePreset ? '5000' : '10'}
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-mono font-bold tabular-nums"
                  />
                </div>

                {!isRechargePreset ? (
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Moneda</label>
                    <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 min-h-[44px]">
                      <button
                        type="button"
                        onClick={() => setFormCurrency('NIO')}
                        className={`rounded-lg text-xs font-bold cursor-pointer ${
                          formCurrency === 'NIO' ? 'bg-[#145f96] text-white' : 'text-slate-600'
                        }`}
                      >
                        C$
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormCurrency('USD')}
                        className={`rounded-lg text-xs font-bold cursor-pointer ${
                          formCurrency === 'USD' ? 'bg-[#145f96] text-white' : 'text-slate-600'
                        }`}
                      >
                        USD
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Porcentaje fijo
                    </label>
                    <div className="min-h-[44px] rounded-xl bg-slate-100 border border-slate-200 px-3 flex items-center justify-center font-mono text-sm font-bold text-[#145f96]">
                      10%
                    </div>
                  </div>
                )}
              </div>

              {!isRechargePreset && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Precio de Costo ({formCurrency === 'NIO' ? 'C$' : 'USD'})
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      value={formCostPrice}
                      onChange={(e) => setFormCostPrice(e.target.value)}
                      placeholder="0.00"
                      className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-mono font-bold tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Comisión venta (si aplica)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      value={formCommission}
                      onChange={(e) => setFormCommission(e.target.value)}
                      placeholder="0.00"
                      className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-mono tabular-nums"
                    />
                  </div>
                </div>
              )}

              {isRechargePreset && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Comisión por venta (opcional, si aplica)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    value={formCommission}
                    onChange={(e) => setFormCommission(e.target.value)}
                    placeholder="0.00"
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-mono tabular-nums"
                  />
                </div>
              )}

              {/* Ganancia: Pestaña Cantidad vs % */}
              {!isRechargePreset && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-bold text-slate-700">Ganancia</label>
                    <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100">
                      <button
                        type="button"
                        onClick={() => setFormProfitType('amount')}
                        className={`px-3 py-1 rounded-md text-xs font-bold cursor-pointer ${
                          formProfitType === 'amount'
                            ? 'bg-[#145f96] text-white shadow-sm'
                            : 'text-slate-600'
                        }`}
                      >
                        Cantidad
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormProfitType('percent')}
                        className={`px-3 py-1 rounded-md text-xs font-bold cursor-pointer ${
                          formProfitType === 'percent'
                            ? 'bg-[#145f96] text-white shadow-sm'
                            : 'text-slate-600'
                        }`}
                      >
                        %
                      </button>
                    </div>
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    value={formProfitValue}
                    onChange={(e) => setFormProfitValue(e.target.value)}
                    placeholder={
                      formProfitType === 'percent'
                        ? 'Ej. 15 (%)'
                        : `Ej. 50.00 (${formCurrency === 'NIO' ? 'C$' : 'USD'})`
                    }
                    className="w-full min-h-[44px] rounded-xl border-2 border-[#a1d63e]/60 px-3 text-sm font-mono font-bold tabular-nums focus:border-[#4d7c0f] focus:outline-none"
                  />
                </div>
              )}

              {/* Barcode optional */}
              {!isRechargePreset && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Código de barras (opcional)
                  </label>
                  <input
                    type="text"
                    value={formBarcode}
                    onChange={(e) => setFormBarcode(e.target.value)}
                    placeholder="Escaneado o manual"
                    className="w-full min-h-[42px] rounded-xl border border-slate-300 px-3 text-sm font-mono"
                  />
                </div>
              )}

              {/* Live Pricing Summary */}
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
                <p className="font-bold text-[#145f96]">
                  {isRechargePreset
                    ? 'Ejemplo en recarga de C$ 100.00:'
                    : 'Vista previa por unidad:'}
                </p>
                <div className="flex justify-between">
                  <span className="text-slate-500">Costo:</span>
                  <span className="font-mono font-semibold tabular-nums">
                    {formatCurrency(previewPricing.costAmount, isRechargePreset ? 'NIO' : formCurrency)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Ganancia bruta:</span>
                  <span className="font-mono font-bold text-[#4d7c0f] tabular-nums">
                    + {formatCurrency(previewPricing.grossProfit, isRechargePreset ? 'NIO' : formCurrency)}
                  </span>
                </div>
                {previewPricing.commissionAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Comisión venta:</span>
                    <span className="font-mono text-[#df7729] tabular-nums">
                      - {formatCurrency(previewPricing.commissionAmount, isRechargePreset ? 'NIO' : formCurrency)}
                    </span>
                  </div>
                )}
                <div className="border-t border-slate-200 pt-1 flex justify-between font-bold text-sm text-[#145f96]">
                  <span>Total al cliente:</span>
                  <span className="font-mono tabular-nums">
                    {formatCurrency(previewPricing.saleTotal, isRechargePreset ? 'NIO' : formCurrency)}
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="w-full min-h-[48px] rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] disabled:opacity-60 text-slate-950 font-bold text-sm cursor-pointer"
              >
                {saving
                  ? 'Guardando...'
                  : modalMode === 'edit_form'
                    ? 'Guardar Cambios'
                    : 'Guardar Producto'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: PICK PRODUCT TO EDIT OR DELETE */}
      {(modalMode === 'edit_pick' || modalMode === 'delete_pick') && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-sm p-0 sm:p-4">
          <div className="w-full sm:max-w-md max-h-[82dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white shrink-0">
              <h3 className="text-base font-bold">
                {modalMode === 'edit_pick' ? 'Editar Producto' : 'Eliminar Producto'}
              </h3>
              <button
                type="button"
                onClick={closeAllModals}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalMode === 'delete_pick' && !isAdmin ? (
              <div className="p-5 text-sm text-slate-600 text-center space-y-3">
                <p>
                  Solo el <strong>Administrador</strong> puede eliminar productos de raíz del
                  inventario.
                </p>
                <button
                  type="button"
                  onClick={closeAllModals}
                  className="min-h-[42px] px-5 rounded-xl bg-[#145f96] text-white text-xs font-bold cursor-pointer"
                >
                  Entendido
                </button>
              </div>
            ) : (
              <div className="overflow-y-auto divide-y divide-slate-200/70 akrobit-zebra-rows">
                {activeProducts.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-8">
                    No hay productos registrados todavía.
                  </p>
                ) : (
                  activeProducts.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => {
                        if (modalMode === 'edit_pick') {
                          populateFormForEdit(product);
                        } else {
                          setTargetProduct(product);
                          setFormError('');
                          setModalMode('delete_confirm');
                        }
                      }}
                      className="w-full py-3.5 px-4 flex items-center justify-between text-left hover:bg-[#69b8e9]/20 transition-colors cursor-pointer"
                    >
                      <div className="min-w-0 pr-2">
                        <p className="text-sm font-bold text-slate-900 truncate">
                          {product.carrier === 'claro' ? '🔴 ' : product.carrier === 'tigo' ? '🔵 ' : ''}
                          {product.name}
                        </p>
                        <p className="text-xs text-slate-500 font-mono">
                          Stock:{' '}
                          {product.category === 'recharge'
                            ? formatCurrency(product.quantity, product.currency)
                            : `${product.quantity} uds`}
                        </p>
                      </div>
                      {modalMode === 'edit_pick' ? (
                        <Pencil className="w-4 h-4 text-[#145f96] shrink-0" />
                      ) : (
                        <Trash2 className="w-4 h-4 text-[#d12925] shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL: DELETE CONFIRM (ROOT DELETE) */}
      {modalMode === 'delete_confirm' && targetProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-slate-200 p-5 space-y-4">
            <h3 className="text-base font-bold text-[#d12925]">¿Eliminar producto de raíz?</h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              Se eliminará permanentemente <strong>{targetProduct.name}</strong> del inventario en
              todos los niveles. Esta acción no se puede deshacer.
            </p>
            {formError && (
              <p className="text-xs font-semibold text-[#d12925] bg-[#d12925]/10 rounded-xl px-3 py-2">
                {formError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={closeAllModals}
                className="flex-1 min-h-[44px] rounded-xl bg-slate-100 text-slate-800 text-sm font-semibold cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleDeleteProduct}
                className="flex-1 min-h-[44px] rounded-xl bg-[#d12925] hover:bg-[#b91c1c] text-white text-sm font-bold cursor-pointer"
              >
                {saving ? 'Eliminando...' : 'Eliminar de raíz'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
