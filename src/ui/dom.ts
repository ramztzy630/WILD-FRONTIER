/**
 * Tiny DOM helpers. UI screens are built once and updated on events;
 * nothing here is meant to run per frame.
 */

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Sets textContent only when it changed (avoids layout work on unchanged values). */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Shows/hides via the `hidden` attribute (styled in main.css). */
export function setVisible(node: HTMLElement, visible: boolean): void {
  if (node.hidden === visible) node.hidden = !visible;
}

/** Binds a click handler and returns an unbind function. */
export function onClick(node: HTMLElement, handler: (event: MouseEvent) => void): () => void {
  node.addEventListener("click", handler);
  return () => node.removeEventListener("click", handler);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
