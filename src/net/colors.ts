/** Each seat's color online: its name tag, minimap dot and progress-strip dot. Readable on sky and road. */
export const SEAT_COLORS = ['#ff4d6d', '#3ec1ff', '#ffd23f', '#7cff6b'];
/** The AI rivals' tags online: neutral, so the players stand out. */
export const AI_COLOR = '#c9ccd2';

export const seatColor = (seat: number): string => SEAT_COLORS[((seat % SEAT_COLORS.length) + SEAT_COLORS.length) % SEAT_COLORS.length];
