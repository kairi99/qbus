/**
 * Quito's bus companies and cooperatives are private businesses whose names are protected by
 * use: the game shows them on reckless buses, so every one is swapped at import for a near
 * miss a quiteño still recognizes ("Catar" → "Katar"). Line numbers and endpoints stay real.
 * Keys are OSM route refs' operator part, upper case; anything not listed passes unchanged
 * (rapid transit refs like "C4"/"E1" have none). Add new operators here when a zone brings them.
 */
export const OPERATOR_ALIAS: Record<string, string> = {
  'AGUILA DORADA': 'AGUILA DORADO',
  ALBORADA: 'ALVORADA',
  BELLAVISTA: 'BELAVISTA',
  CATAR: 'KATAR',
  'CENTRAL NORTE': 'SENTRAL NORTE',
  COLECTRANS: 'KOLECTRANS',
  DISUTRAN: 'DIZUTRAN',
  GUADALAJARA: 'GUADALAXARA',
  'JUAN PABLO II': 'JUAN PABLO DOS',
  LATINA: 'LATINITA',
  'LIBERTADORES DEL VALLE': 'LIVERTADORES DEL VALLE',
  LUJOTURISSA: 'LUJOTURIZA',
  'MARISCAL SUCRE': 'MARISKAL SUCRE',
  METROTRANS: 'METROTRANZ',
  MONSERRAT: 'MONSERRATE',
  NACIONAL: 'NASIONAL',
  PAQUISHA: 'PAKISHA',
  PICHINCHA: 'PICHINXA',
  'QUITENO LIBRE': 'KITENO LIBRE',
  QUITO: 'KITO',
  QUITUMBE: 'KITUMBE',
  'REINO DE QUITO': 'REYNO DE KITO',
  'SAN FRANCISCO DE CHILLOGALLO': 'SAN FRANSISCO DE CHILLOGALLO',
  'SAN JUAN DE CALDERON': 'SAN JUAN DE KALDERON',
  'SEIS DE DICIEMBRE': 'SEIS DE DISIEMBRE',
  SEMGYLLFOR: 'SEMGILFOR',
  SERVIAGOSTO: 'SERVIAGOZTO',
  SETRAMAS: 'ZETRAMAS',
  'TERMAS TURIS': 'TERMAS TURIZ',
  TRANSALFA: 'TRANSALPHA',
  TRANSHEMISFERICOS: 'TRANSEMISFERICOS',
  TRANSLATINOS: 'TRANSLATINOZ',
  TRANSMETROPOLI: 'TRANSMETROPOLY',
  TRANSPLANETA: 'TRANSPLANETTA',
  TRANSPORSEL: 'TRANSPORCEL',
  TRANSZETA: 'TRANSETA',
  'VENCEDORES DE PICHINCHA': 'VENSEDORES DEL PICHINXA',
  VICTORIA: 'VIKTORIA',
  VINGALA: 'VINGALLA',
};

// Longest first, so "REINO DE QUITO" wins over "QUITO".
const KEYS = Object.keys(OPERATOR_ALIAS).sort((a, b) => b.length - a.length);

/** "CATAR-061" → "KATAR-061"; refs starting with no known operator are returned as they are. */
export function aliasRef(ref: string): string {
  const up = ref.toUpperCase();
  for (const k of KEYS) {
    if (!up.startsWith(k)) continue;
    const rest = ref.slice(k.length);
    // Whole words only: "QUITO" mustn't eat the start of "QUITUMBE".
    if (rest && !/^[\s-]/.test(rest)) continue;
    return OPERATOR_ALIAS[k] + rest;
  }
  return ref;
}

/** Line route ids once carried the real operator ("linea-catar-061"): the id it has now. */
export function aliasRouteId(id: string): string {
  return id.replace(/^linea-(.+)$/, (_, rest: string) => `linea-${aliasRef(rest.toUpperCase().replace(/-/g, ' ')).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
}
