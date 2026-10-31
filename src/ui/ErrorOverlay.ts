/**
 * Error overlay (ARCHITECTURE.md R1): Android Chrome has no visible console
 * without a PC, so uncaught errors and unhandled promise rejections are shown
 * on screen. Installed first in main.ts so boot errors are captured too.
 */

import { el, errorMessage, onClick, setText, setVisible } from "./dom.ts";

interface ErrorEntry {
  time: string;
  message: string;
  detail: string;
  count: number;
}

const MAX_ENTRIES = 20;

export class ErrorOverlay {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly title: HTMLElement;
  private readonly entries: ErrorEntry[] = [];
  private total = 0;

  constructor(parent: HTMLElement) {
    this.title = el("strong", { class: "err-title", text: "Error" });
    this.list = el("ol", { class: "err-list", "data-scroll": true });
    const dismiss = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "Dismiss" });
    const clear = el("button", { class: "btn btn-ghost-text btn-sm", type: "button", text: "Clear" });
    onClick(dismiss, () => setVisible(this.root, false));
    onClick(clear, () => {
      this.entries.length = 0;
      this.total = 0;
      this.render();
      setVisible(this.root, false);
    });
    this.root = el("section", { class: "error-overlay", role: "alert", "aria-live": "assertive", hidden: true }, [
      el("header", { class: "err-head" }, [this.title, el("div", { class: "err-actions" }, [clear, dismiss])]),
      this.list,
    ]);
    parent.append(this.root);
  }

  install(): void {
    window.addEventListener("error", (event: ErrorEvent) => {
      const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "";
      const stack = event.error instanceof Error && event.error.stack ? event.error.stack : "";
      this.report(event.message || errorMessage(event.error), stack || where);
    });
    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      const stack = reason instanceof Error && reason.stack ? reason.stack : "";
      this.report(`Unhandled promise rejection: ${errorMessage(reason)}`, stack);
    });
  }

  report(message: string, detail = ""): void {
    this.total++;
    const last = this.entries[this.entries.length - 1];
    if (last && last.message === message) {
      last.count++;
    } else {
      this.entries.push({ time: new Date().toLocaleTimeString(), message, detail, count: 1 });
      if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    }
    this.render();
    setVisible(this.root, true);
  }

  get errorCount(): number {
    return this.total;
  }

  private render(): void {
    setText(this.title, this.total === 1 ? "1 error" : `${this.total} errors`);
    this.list.replaceChildren(
      ...this.entries.map((e) =>
        el("li", {}, [
          el("div", { class: "err-msg" }, [
            el("span", { class: "err-time", text: e.time }),
            " ",
            e.message,
            e.count > 1 ? el("span", { class: "err-count", text: ` ×${e.count}` }) : null,
          ]),
          e.detail ? el("pre", { class: "err-detail", text: e.detail.split("\n").slice(0, 6).join("\n") }) : null,
        ]),
      ),
    );
  }
}
