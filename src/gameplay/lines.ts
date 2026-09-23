/** What people on (and around) the bus shout. Quito slang on purpose. */
export const LINES = {
  approach: ['¡Me bajo en la esquina!', '¡Aquí nomás, maestro!', '¡Pare, pare, ñaño!', '¡En la parada, veci!'],
  board: ['¡Súbase, súbase, que hay puesto!', '¡Avance al fondo, tenga la bondad!', '¡Pasaje, pasaje!'],
  scared: ['Quesf señor! no lleva papas!', '¡Diosito lindo!', '¡Maestro, más despacio!', '¡Qué bestia este chofer!'],
  air: ['¡Ayayay, estamos volando!', '¡Mi corazón!', '¡Agárrense!'],
  crash: ['¡Chuta!', '¡Qué fue, maestro!', '¡Ya nos matamos!'],
  impatient: ['¡Apure vea, que llego tarde!', '¡Más rápido, veci!', '¡Esto parece carreta!'],
  happy: ['¡Qué bacán!', '¡De una, maestro!', '¡Llegué volando!'],
  grumpy: ['¡Mejor me iba a pie!', '¡Ni propina le doy!'],
  driverAngry: ['¡Aprenda a manejar!', '¡Chofer loco!', '¡Oiga, muévase pues!', '¡Qué le pasa, señor!'],
  carHit: ['¡Mi carro!', '¡Me va a pagar el choque!', '¡Ya me dañó el guardachoque!'],
  pedDive: ['¡Casi me mata!', '¡Ave María Purísima!', '¡Fíjese por dónde va!', '¡Bruto!'],
} as const;

export type LineKind = keyof typeof LINES;

/** Who is speaking, for the speech bubble label. */
export const SPEAKER: Record<LineKind, string> = {
  approach: 'Pasajero',
  board: 'Ayudante',
  scared: 'Pasajera',
  air: 'Pasajero',
  crash: 'Pasajera',
  impatient: 'Pasajero',
  happy: 'Pasajera',
  grumpy: 'Pasajero',
  driverAngry: 'Taxista',
  carHit: 'Conductor',
  pedDive: 'Peatón',
};
