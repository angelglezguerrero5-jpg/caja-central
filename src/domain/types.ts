import { BRAND } from '../brand';
/**
 * Convenciones numéricas (evitan errores de punto flotante):
 *  - Dinero: centavos enteros (`...Cents`).
 *  - Cantidad: milésimas enteras (`qtyMilli`). Para productos por kg son gramos;
 *    para pieza/caja/arpilla, 1 unidad = 1000.
 *  - Precio: centavos por unidad de venta (por kg, por pieza, por caja...).
 */

export type Unit = 'kg' | 'pieza' | 'caja' | 'arpilla';

/**
 * Clasificación comercial de un producto. Cada combinación distinta (variedad, procedencia, calidad, calibre,
 * unidad) es un producto con su propio precio e inventario. "No especificado" = campo ausente.
 */
export interface Classification {
  /** Tipo / variedad (ej. "Sin semilla", "Con semilla" o texto propio). */
  variety: string;
  /** Procedencia comercial (ej. "Oaxaca", "Michoacán" o texto propio). */
  origin?: string;
  /** Calidad (ej. "Primera", "Segunda", "Tercera" o texto propio). */
  quality?: string;
  /** Calibre/tamaño (ej. "1X", "2X", "3X", "200"… "500" o texto propio). No hay equivalencias entre sistemas. */
  caliber?: string;
}

/** Bitácora de una edición de la clasificación de un producto (antes → después). Nunca se borra. */
export interface ProductClassEdit {
  at: string;
  before: Classification;
  after: Classification;
}

export interface Product {
  id: string;
  /** Tipo / variedad. */
  name: string;
  /** Calidad (opcional). */
  quality?: string;
  /** Procedencia comercial (opcional). */
  origin?: string;
  /** Calibre o tamaño (opcional). */
  caliber?: string;
  unit: Unit;
  /** Centavos por unidad de venta. 0 = "sin precio todavía": la caja exige capturarlo antes de cobrar. */
  priceCents: number;
  active: boolean;
  /** Orden en la cuadrícula de la caja. */
  sort: number;
  /** Existencia física en milésimas (lo que hay en bodega). Puede quedar negativa: la caja no se bloquea. */
  physicalMilli: number;
  /** Apartado por vales pagados pendientes de entrega. Disponible = físico − reservado. */
  reservedMilli: number;
  updatedAt: string;
  /** Ediciones de la clasificación (la existencia conserva el producto; aquí queda cómo se llamaba antes). */
  classEdits?: ProductClassEdit[];
}

export interface SaleItem {
  productId: string;
  name: string;
  unit: Unit;
  qtyMilli: number;
  unitPriceCents: number;
  totalCents: number;
  /** Clasificación con la que se vendió (foto al momento de la venta). Ausente en ventas anteriores. */
  cls?: Classification;
}

export type PaymentMethod = 'efectivo' | 'transferencia' | 'tarjeta';

/**
 * Entrega de la mercancía:
 *  - inmediata: venta normal, sale de bodega al cobrar.
 *  - pendiente: VALE pagado; la mercancía queda reservada hasta entregarla.
 *  - entregado: vale ya entregado.
 *  - cancelado: vale cancelado antes de entregarse (el dinero se maneja aparte).
 */
export type DeliveryStatus = 'inmediata' | 'pendiente' | 'entregado' | 'cancelado';

/** Cómo se devolvió el dinero al cancelar un vale. Nunca se asume. */
export type RefundMethod = 'efectivo' | 'transferencia' | 'ninguna';

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
  /** Folio propio del vale (distinto del folio de venta). */
  valeFolio?: number;
  /** Nombre/nota del cliente (opcional, útil en vales). */
  customerName?: string;
  deliveredAt?: string;
  /** La venta se autorizó con existencia disponible insuficiente. */
  stockOverride?: boolean;
  cancelReason?: string;
  cancelledAt?: string;
  refundMethod?: RefundMethod;
  refundCents?: number;
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
export type CashMovementType = 'salida' | 'devolucion';

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
  | 'anulacion'
  | 'recepcion'
  | 'correccion_recepcion'
  | 'reversa_recepcion';

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
  /** Recepción de mercancía que originó este movimiento (recepcion, correccion_recepcion, reversa_recepcion). */
  receptionId?: string;
  /**
   * Presente solo si este movimiento dejó el disponible en NEGATIVO con autorización explícita: es el disponible que
   * quedó. Permite distinguir un negativo autorizado de uno por error.
   */
  authorizedNegativeAfterMilli?: number;
}

export interface CartLine {
  productId: string;
  name: string;
  unit: Unit;
  qtyMilli: number;
  unitPriceCents: number;
  cls?: Classification;
}

// ---------------------------------------------------------------------------------------------
// Recepción de mercancía
// ---------------------------------------------------------------------------------------------

/** Cómo llegó la mercancía. */
export type Packaging = 'granel' | 'caja' | 'arpilla';

/**
 * Cómo se obtienen los kilos netos. Los modos son EXCLUYENTES (nunca se suman un peso calculado y otro capturado):
 *  - directo: el usuario escribe los kilos netos pesados.
 *  - por_envase: envases × peso neto por envase.
 *  - bruto_tara: peso bruto − tara.
 */
export type WeightMode = 'directo' | 'por_envase' | 'bruto_tara';

/** borrador (sin efecto en inventario) · confirmada · cancelada (borrador descartado) · anulada (reversa auditada). */
export type ReceptionStatus = 'borrador' | 'confirmada' | 'cancelada' | 'anulada';

export interface ReceptionCorrection {
  id: string;
  at: string;
  reason: string;
  previousNetMilli: number;
  newNetMilli: number;
  deltaMilli: number;
  stockMoveId: string;
}

/**
 * Corrección de DATOS de una recepción ya confirmada (fecha, proveedor, referencia, observaciones, envases).
 * No mueve inventario ni cambia los kilos; deja el antes y el después con su motivo.
 */
export interface ReceptionEdit {
  id: string;
  at: string;
  reason: string;
  changes: Array<{ field: 'receivedAt' | 'supplier' | 'reference' | 'notes' | 'containers'; before?: string | number; after?: string | number }>;
}

/** Avisos que la persona reconoció de forma explícita para continuar (quedan registrados). */
export interface ReceptionAck {
  at: string;
  op: 'confirmar' | 'corregir' | 'anular';
  warnings: string[];
}

export interface Reception {
  id: string;
  /** Folio R-n, asignado al confirmar. */
  folio?: number;
  status: ReceptionStatus;
  createdAt: string;
  updatedAt: string;
  /** Fecha y hora en que llegó la mercancía (ISO). Editable, no futura. */
  receivedAt: string;
  /** Día local (YYYY-MM-DD) de receivedAt. */
  day: string;
  /** Proveedor o procedencia del lote. */
  supplier?: string;
  /** Identificador del camión u otra referencia (opcional). */
  reference?: string;
  notes?: string;
  productId?: string;
  /** Foto del nombre y la clasificación del producto al confirmar. */
  productLabel?: string;
  cls?: Classification;
  packaging: Packaging;
  /** Cantidad de cajas o arpillas (informativa salvo en modo por_envase). No aplica a granel. */
  containers?: number;
  weightMode: WeightMode;
  /** Solo modo directo. */
  netDirectMilli?: number;
  /** Solo modo directo: pesadas individuales (≥ 2) cuya suma es netDirectMilli. Informativo/auditable. */
  weighingsMilli?: number[];
  /** Solo modo por_envase: peso NETO por caja/arpilla. */
  unitNetMilli?: number;
  /** Solo modo bruto_tara. */
  grossMilli?: number;
  tareMilli?: number;
  /** Kilos netos vigentes (confirmada) o calculados del borrador cuando está completo. */
  netMilli?: number;
  confirmedAt?: string;
  /** Kilos netos con los que se confirmó (dato original; las correcciones no lo modifican). */
  confirmedNetMilli?: number;
  /** Movimiento de inventario 'recepcion' que sumó los kilos. */
  stockMoveId?: string;
  corrections: ReceptionCorrection[];
  /** Correcciones de datos (no de kilos) hechas después de confirmar. */
  dataEdits?: ReceptionEdit[];
  /** Avisos reconocidos al confirmar, corregir o anular (posible duplicado, conteo posterior...). */
  acknowledged?: ReceptionAck[];
  cancelledAt?: string;
  cancelReason?: string;
  voidedAt?: string;
  voidReason?: string;
  voidStockMoveId?: string;
}

// ---------------------------------------------------------------------------------------------
// Control de pesaje por flete
// ---------------------------------------------------------------------------------------------

/**
 * Cómo se obtiene el peso neto de un lado del flete. EXCLUYENTES (nunca se mezclan datos de los dos):
 *  - bruto_tara: neto = peso bruto − tara (lo que dice la boleta de la báscula).
 *  - directo: la boleta solo trae el peso neto.
 */
export type FreightWeightMode = 'bruto_tara' | 'directo';

/** Una pesada: la de ORIGEN (peso inicial) o la de DESTINO (peso final) de un flete. */
export interface FreightSide {
  mode: FreightWeightMode;
  /** Solo modo bruto_tara. En milésimas de kg. */
  grossMilli?: number;
  tareMilli?: number;
  /** Peso neto, siempre presente. En bruto_tara es bruto − tara; en directo es el dato capturado. */
  netMilli: number;
  /** Número de la boleta o ticket de la báscula (evidencia). */
  ticket?: string;
  /** Nombre o lugar de la báscula (evidencia). */
  scale?: string;
}

/** Corrección de un flete ya capturado: antes y después de cada dato, con su motivo. Nunca se borra. */
export interface FreightRevision {
  id: string;
  at: string;
  reason: string;
  changes: Array<{ field: string; before?: string | number; after?: string | number }>;
}

export type FreightStatus = 'activo' | 'anulado';

/**
 * Un flete con su control de pesaje. NO mueve inventario, ventas ni caja: es un registro de control (las existencias se
 * mueven en Recepción). La diferencia y el porcentaje NO se guardan: se calculan de los dos netos, así nunca se desfasan.
 */
export interface Freight {
  id: string;
  /** Folio único del flete, como lo escribió la persona (o el sugerido). */
  folio: string;
  /** Folio normalizado (mayúsculas, espacios colapsados): es el que no se puede repetir. */
  folioKey: string;
  status: FreightStatus;
  createdAt: string;
  updatedAt: string;
  /** Fecha del flete (ISO). Editable, no futura. */
  date: string;
  /** Día local (YYYY-MM-DD) de `date`. */
  day: string;
  origin: string;
  destination: string;
  notes?: string;
  /** Peso INICIAL: pesada de origen. */
  initial?: FreightSide;
  /** Peso FINAL: pesada de destino. */
  final?: FreightSide;
  revisions: FreightRevision[];
  voidedAt?: string;
  voidReason?: string;
}

/**
 * Referencia configurable de la diferencia de peso (kg) de un flete. Es solo una REFERENCIA para comparar: la app nunca
 * le atribuye una causa a la diferencia. Por omisión 200–300 kg, PENDIENTE DE VALIDACIÓN (`validated: false`).
 * Sin `refMinMilli`/`refMaxMilli` no hay rango y las diferencias se muestran sin comparar.
 */
export interface FreightSettings {
  refMinMilli?: number;
  refMaxMilli?: number;
  validated: boolean;
}

export interface Backup {
  app: typeof BRAND.id;
  /** 1 = formato anterior (sin recepciones); 2 = con recepciones; 3 = actual (con fletes). 1 y 2 se aceptan al importar. */
  version: 1 | 2 | 3;
  exportedAt: string;
  products: Product[];
  sales: Sale[];
  shifts: Shift[];
  cashMovements: CashMovement[];
  stockMoves: StockMove[];
  receptions: Reception[];
  freights: Freight[];
  /** Configuración del control de pesaje, si se cambió alguna vez (ausente = valores por omisión). */
  freightSettings?: FreightSettings;
  nextFolio: number;
  nextValeFolio: number;
  nextReceptionFolio: number;
}

/**
 * Respaldo de los formatos 1 y 2 (anteriores a los fletes). La app ya no los escribe; sirve para fabricar archivos viejos y
 * comprobar que se siguen pudiendo importar (los fletes quedan vacíos).
 */
export type LegacyBackup = Omit<Backup, 'version' | 'freights' | 'freightSettings'> & { version: 1 | 2 };
