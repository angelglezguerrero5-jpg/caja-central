/**
 * Convenciones numéricas (evitan errores de punto flotante):
 *  - Dinero: centavos enteros (`...Cents`).
 *  - Cantidad: milésimas enteras (`qtyMilli`). Para productos por kg son gramos;
 *    para pieza/caja/arpilla, 1 unidad = 1000.
 *  - Precio: centavos por unidad de venta (por kg, por pieza, por caja...).
 */

export type Unit = 'kg' | 'pieza' | 'caja' | 'arpilla';

export interface Product {
  id: string;
  name: string;
  unit: Unit;
  priceCents: number;
  active: boolean;
  /** Orden en la cuadrícula de la caja. */
  sort: number;
  /** Existencia física en milésimas (lo que hay en bodega). Puede quedar negativa: la caja no se bloquea. */
  physicalMilli: number;
  /** Apartado por vales pagados pendientes de entrega. Disponible = físico − reservado. */
  reservedMilli: number;
  updatedAt: string;
}

export interface SaleItem {
  productId: string;
  name: string;
  unit: Unit;
  qtyMilli: number;
  unitPriceCents: number;
  totalCents: number;
}

export type PaymentMethod = 'efectivo' | 'transferencia' | 'tarjeta';

/**
 * Entrega de la mercancía:
 *  - inmediata: venta normal, sale de bodega al cobrar.
 *  - pendiente: VALE pagado; la mercancía queda reservada hasta entregarla.
 *  - entregado: vale ya entregado.
 */
export type DeliveryStatus = 'inmediata' | 'pendiente' | 'entregado';

export type SaleStatus = 'completada' | 'anulada';

export interface Sale {
  id: string;
  folio: number;
  createdAt: string;
  /** Día local YYYY-MM-DD (para consultas por día). */
  day: string;
  shiftId: string;
  items: SaleItem[];
  totalCents: number;
  paymentMethod: PaymentMethod;
  receivedCents: number;
  changeCents: number;
  status: SaleStatus;
  delivery: DeliveryStatus;
  /** Nombre/nota del cliente (opcional, útil en vales). */
  customerName?: string;
  deliveredAt?: string;
  voidReason?: string;
  voidedAt?: string;
}

export interface Shift {
  id: string;
  openedAt: string;
  openingCashCents: number;
  closedAt?: string;
  countedCashCents?: number;
  expectedCashCents?: number;
  differenceCents?: number;
}

/** Movimiento de efectivo fuera de una venta, dentro de un turno. */
export type CashMovementType = 'salida';

export interface CashMovement {
  id: string;
  shiftId: string;
  createdAt: string;
  type: CashMovementType;
  /** Siempre positivo; el signo lo da el tipo. */
  amountCents: number;
  concept: string;
  saleId?: string;
}

export type StockMoveType =
  | 'entrada'
  | 'merma'
  | 'ajuste'
  | 'venta'
  | 'reserva'
  | 'entrega_vale'
  | 'anulacion';

export interface StockMove {
  id: string;
  productId: string;
  createdAt: string;
  type: StockMoveType;
  /** Cambio en existencia física, con signo (+ entra, − sale). */
  deltaMilli: number;
  /** Cambio en reservado, con signo. */
  reservedDeltaMilli: number;
  note: string;
  saleId?: string;
}

export interface CartLine {
  productId: string;
  name: string;
  unit: Unit;
  qtyMilli: number;
  unitPriceCents: number;
}

export interface Backup {
  app: 'sistema-venta-limones';
  version: 1;
  exportedAt: string;
  products: Product[];
  sales: Sale[];
  shifts: Shift[];
  cashMovements: CashMovement[];
  stockMoves: StockMove[];
  nextFolio: number;
}
