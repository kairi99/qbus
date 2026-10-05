import * as THREE from 'three';

/** Kinds of business, for picking a fitting sign (from OSM `shop`/`amenity` when known). */
type Trade = 'food' | 'health' | 'store' | 'paper' | 'hardware' | 'phone' | 'clothes' | 'service' | 'hotel' | 'money';

interface SignDef {
  text: string;
  trade: Trade;
  bg: string;
  fg: string;
  /** Small line under the name. */
  sub?: string;
}

/** Quito storefronts: every sign in the city is one of these (the atlas holds them all). */
const SIGNS: SignDef[] = [
  { text: 'Tienda Don Lucho', trade: 'store', bg: '#1f5fa8', fg: '#ffffff', sub: 'VÍVERES · COLAS · PAN' },
  { text: 'Víveres La Bendición', trade: 'store', bg: '#f2c230', fg: '#1d2a6b' },
  { text: 'Abarrotes Doña Charito', trade: 'store', bg: '#ffffff', fg: '#c62828' },
  { text: 'Minimarket El Vecino', trade: 'store', bg: '#2e7d32', fg: '#fff59d' },
  { text: 'Tienda La Chola', trade: 'store', bg: '#e65100', fg: '#ffffff' },
  { text: 'Bazar Mi Cholita', trade: 'store', bg: '#8e24aa', fg: '#ffffff', sub: 'BAZAR Y REGALOS' },
  { text: 'Farmacia San Blas', trade: 'health', bg: '#ffffff', fg: '#1b8a3a', sub: 'ABIERTO 24 HORAS' },
  { text: 'Farmacia Popular', trade: 'health', bg: '#1b8a3a', fg: '#ffffff' },
  { text: 'Botica La Salud', trade: 'health', bg: '#e8f5e9', fg: '#0d47a1' },
  { text: 'Óptica Visión Clara', trade: 'health', bg: '#0d47a1', fg: '#ffffff' },
  { text: 'Consultorio Dental', trade: 'health', bg: '#ffffff', fg: '#00838f', sub: 'DRA. ANDRADE' },
  { text: 'Panadería La Ambateña', trade: 'food', bg: '#f6e3b4', fg: '#7b3f00', sub: 'PAN CALIENTITO' },
  { text: 'Picantería La Tolita', trade: 'food', bg: '#c62828', fg: '#ffeb3b' },
  { text: 'Hornado Doña Rosita', trade: 'food', bg: '#ffb300', fg: '#4e2a00', sub: 'SÁBADOS Y DOMINGOS' },
  { text: 'Encebollados El Gordo', trade: 'food', bg: '#ffffff', fg: '#d84315' },
  { text: 'Cevichería El Manaba', trade: 'food', bg: '#0288d1', fg: '#ffffff' },
  { text: 'Pollos a la Brasa', trade: 'food', bg: '#ffeb3b', fg: '#b71c1c' },
  { text: 'Almuerzos $3', trade: 'food', bg: '#ffffff', fg: '#1a1a1a', sub: 'SOPA · SEGUNDO · JUGO' },
  { text: 'Café Quiteño', trade: 'food', bg: '#4e342e', fg: '#ffe0b2' },
  { text: 'Jugos Naturales', trade: 'food', bg: '#7cb342', fg: '#ffffff', sub: 'MORA · NARANJILLA' },
  { text: 'Fritada Amazonas', trade: 'food', bg: '#6d4c41', fg: '#ffcc80' },
  { text: 'Salchipapas Don Pepe', trade: 'food', bg: '#ff7043', fg: '#ffffff' },
  { text: 'Heladería La Ronda', trade: 'food', bg: '#f8bbd0', fg: '#ad1457' },
  { text: 'Bolones y Tigrillo', trade: 'food', bg: '#2e7d32', fg: '#ffffff' },
  { text: 'Caldo de Patas', trade: 'food', bg: '#ffffff', fg: '#6a1b9a' },
  { text: 'Empanadas de Viento', trade: 'food', bg: '#fbc02d', fg: '#3e2723' },
  { text: 'Papelería El Estudiante', trade: 'paper', bg: '#ffffff', fg: '#1565c0', sub: 'COPIAS · ÚTILES' },
  { text: 'Copias e Impresiones', trade: 'paper', bg: '#1565c0', fg: '#ffffff' },
  { text: 'Papelería Lupita', trade: 'paper', bg: '#fdd835', fg: '#0d47a1' },
  { text: 'Librería Cervantes', trade: 'paper', bg: '#37474f', fg: '#ffffff' },
  { text: 'Ferretería El Tornillo', trade: 'hardware', bg: '#ff6f00', fg: '#212121' },
  { text: 'Ferretería Pichincha', trade: 'hardware', bg: '#263238', fg: '#ffc107', sub: 'PINTURAS · HERRAMIENTAS' },
  { text: 'Cabinas e Internet', trade: 'phone', bg: '#00897b', fg: '#ffffff', sub: 'LLAMADAS NACIONALES' },
  { text: 'Celulares y Accesorios', trade: 'phone', bg: '#212121', fg: '#4fc3f7' },
  { text: 'Cabinas Telefónicas', trade: 'phone', bg: '#ffffff', fg: '#00695c' },
  { text: 'Recargas y Cabinas', trade: 'phone', bg: '#d81b60', fg: '#ffffff' },
  { text: 'Boutique Carolina', trade: 'clothes', bg: '#000000', fg: '#f8bbd0' },
  { text: 'Zapatería El Paso', trade: 'clothes', bg: '#5d4037', fg: '#ffffff' },
  { text: 'Ropa de Otavalo', trade: 'clothes', bg: '#b71c1c', fg: '#ffffff', sub: 'PONCHOS · BUFANDAS' },
  { text: 'Artesanías Andinas', trade: 'clothes', bg: '#f57f17', fg: '#ffffff' },
  { text: 'Sastrería Don Jorge', trade: 'service', bg: '#ffffff', fg: '#263238' },
  { text: 'Peluquería Estilos', trade: 'service', bg: '#ec407a', fg: '#ffffff' },
  { text: 'Lavandería Express', trade: 'service', bg: '#4fc3f7', fg: '#0d47a1' },
  { text: 'Cerrajería 24h', trade: 'service', bg: '#ffeb3b', fg: '#000000' },
  { text: 'Mecánica Hnos. Pérez', trade: 'service', bg: '#424242', fg: '#ff9800' },
  { text: 'Floristería Las Rosas', trade: 'service', bg: '#fce4ec', fg: '#c2185b' },
  { text: 'Agencia Galápagos', trade: 'service', bg: '#006064', fg: '#ffffff', sub: 'VIAJES Y TOURS' },
  { text: 'Tatuajes La Foch', trade: 'service', bg: '#000000', fg: '#ffffff' },
  { text: 'Karaoke El Chulla', trade: 'food', bg: '#4a148c', fg: '#ffeb3b' },
  { text: 'Licorería La Esquina', trade: 'store', bg: '#880e4f', fg: '#ffffff' },
  { text: 'Hostal La Mariscal', trade: 'hotel', bg: '#1a237e', fg: '#ffffff', sub: 'HABITACIONES · WIFI' },
  { text: 'Hotel Amazonas', trade: 'hotel', bg: '#3e2723', fg: '#ffd54f' },
  { text: 'Hostal El Quinde', trade: 'hotel', bg: '#00796b', fg: '#ffffff' },
  { text: 'Cooperativa Andina', trade: 'money', bg: '#0d47a1', fg: '#ffeb3b', sub: 'AHORRO Y CRÉDITO' },
  { text: 'Compra y Venta de Oro', trade: 'money', bg: '#fbc02d', fg: '#000000' },
  { text: 'Envíos y Giros', trade: 'money', bg: '#c62828', fg: '#ffffff' },
];

const SLOT_W = 256;
const SLOT_H = 64;
const COLS = 4;
const ROWS = Math.ceil(SIGNS.length / COLS);
const ATLAS_H = THREE.MathUtils.ceilPowerOfTwo(ROWS * SLOT_H);

/** Which trade an OSM `shop`/`amenity` value is. */
const TRADE_OF: Record<string, Trade> = {
  restaurant: 'food', fast_food: 'food', cafe: 'food', bar: 'food', pub: 'food', ice_cream: 'food', nightclub: 'food', bakery: 'food', deli: 'food', butcher: 'food',
  pharmacy: 'health', clinic: 'health', dentist: 'health', doctors: 'health', optician: 'health', medical_supply: 'health',
  convenience: 'store', supermarket: 'store', greengrocer: 'store', alcohol: 'store', variety_store: 'store', marketplace: 'store', department_store: 'store',
  stationery: 'paper', copyshop: 'paper', books: 'paper', printing: 'paper',
  hardware: 'hardware', paint: 'hardware', glass: 'hardware', locksmith: 'service',
  mobile_phone: 'phone', electronics: 'phone', internet_cafe: 'phone', computer: 'phone',
  clothes: 'clothes', shoes: 'clothes', craft: 'clothes', jewelry: 'clothes',
  bank: 'money', money_lender: 'money', travel_agency: 'service',
  hairdresser: 'service', beauty: 'service', laundry: 'service', dry_cleaning: 'service', tailor: 'service', car_repair: 'service', tattoo: 'service', florist: 'service',
};

/** Sign for a business: one of its trade when the OSM tag says what it is, else any. `r` in [0, 1). */
export function pickSign(r: number, shop?: string, use?: string): number {
  const trade = (shop && TRADE_OF[shop]) || (use === 'hotel' ? 'hotel' : undefined);
  if (trade) {
    const fits = SIGNS.flatMap((s, i) => (s.trade === trade ? [i] : []));
    return fits[Math.floor(r * fits.length)];
  }
  // Hotels and banks only where OSM says so.
  const any = SIGNS.flatMap((s, i) => (s.trade === 'hotel' || s.trade === 'money' ? [] : [i]));
  return any[Math.floor(r * any.length)];
}

/** A plain white texel in the atlas: unsigned quads drawn with the same material use it. */
export const WHITE_UV: readonly [number, number] = [0.98, 0.01];

/** UV rectangle [u0, v0, u1, v1] of a sign in the atlas. */
export function signUV(i: number): [number, number, number, number] {
  const c = i % COLS;
  const r = Math.floor(i / COLS);
  const inset = 1 / (SLOT_W * COLS * 2);
  return [c / COLS + inset, 1 - ((r + 1) * SLOT_H) / ATLAS_H + inset, (c + 1) / COLS - inset, 1 - (r * SLOT_H) / ATLAS_H - inset];
}

/** Every shop sign drawn once into one canvas texture (null without a DOM: headless tests). */
export function signAtlas(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SLOT_W * COLS;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(SLOT_W * COLS - 64, ATLAS_H - 64, 64, 64); // WHITE_UV
  SIGNS.forEach((s, i) => {
    const x = (i % COLS) * SLOT_W;
    const y = Math.floor(i / COLS) * SLOT_H;
    ctx.fillStyle = s.bg;
    ctx.fillRect(x, y, SLOT_W, SLOT_H);
    ctx.strokeStyle = s.fg;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 4, y + 4, SLOT_W - 8, SLOT_H - 8);
    ctx.fillStyle = s.fg;
    const serif = i % 3 === 0;
    ctx.font = `bold ${s.sub ? 26 : 30}px ${serif ? 'Georgia, serif' : 'system-ui, sans-serif'}`;
    ctx.fillText(s.text, x + SLOT_W / 2, y + (s.sub ? 25 : SLOT_H / 2 + 1), SLOT_W - 20);
    if (s.sub) {
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(s.sub, x + SLOT_W / 2, y + 48, SLOT_W - 24);
    }
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
