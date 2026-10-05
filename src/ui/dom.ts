/**
 * Per-frame HUD writes go through these: they touch the DOM only when the value changed
 * (rewriting the same text every frame still costs the browser style and layout work).
 */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setStyle(el: HTMLElement, prop: string, value: string): void {
  if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
}

export function setData(el: HTMLElement, key: string, value: string): void {
  if (el.dataset[key] !== value) el.dataset[key] = value;
}
