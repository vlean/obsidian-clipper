// A small, accessible, auto-dismissing in-page toast. Runs inside the content
// script's page context. Styling is isolated in a shadow root so it can't be
// affected by (or affect) the host page, and the message is set via textContent
// so untrusted text can never inject markup.
//
// Reused by the Outline excerpt feedback and (Stage 2) the in-page selection
// toolbar.

const TOAST_HOST_ID = 'obsidian-clipper-toast-host';
const DEFAULT_DURATION_MS = 2500;

export type PageToastVariant = 'info' | 'error';

export interface PageToastOptions {
	/** How long the toast stays visible, in milliseconds (default 2500). */
	duration?: number;
	/** Visual variant. Errors use an error-tinted accent. */
	variant?: PageToastVariant;
}

const TOAST_STYLES = `
:host { all: initial; }
.oc-toast {
	position: fixed;
	left: 50%;
	bottom: 24px;
	transform: translateX(-50%) translateY(8px);
	max-width: min(90vw, 420px);
	box-sizing: border-box;
	padding: 10px 16px;
	border-radius: 8px;
	background: #1f1f1f;
	color: #fff;
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
	font-size: 14px;
	line-height: 1.4;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
	opacity: 0;
	transition: opacity 160ms ease, transform 160ms ease;
	z-index: 2147483647;
	pointer-events: none;
	white-space: pre-line;
	word-break: break-word;
}
.oc-toast.oc-toast-visible {
	opacity: 1;
	transform: translateX(-50%) translateY(0);
}
.oc-toast.oc-toast-error {
	background: #7f1d1d;
}
@media (prefers-reduced-motion: reduce) {
	.oc-toast { transition: opacity 160ms ease; transform: translateX(-50%); }
	.oc-toast.oc-toast-visible { transform: translateX(-50%); }
}
`;

interface ToastHost extends HTMLElement {
	__ocToastTimers?: { hide: number; remove: number };
}

/**
 * Shows a toast with the given message. Replaces any currently visible toast.
 * Safe to call repeatedly; the previous toast's timers are cleared.
 */
export function showPageToast(message: string, options: PageToastOptions = {}): void {
	if (typeof document === 'undefined' || !document.body) return;
	const duration = typeof options.duration === 'number' && options.duration > 0 ? options.duration : DEFAULT_DURATION_MS;

	let host = document.getElementById(TOAST_HOST_ID) as ToastHost | null;
	let shadow: ShadowRoot;
	if (host && host.shadowRoot) {
		shadow = host.shadowRoot;
		if (host.__ocToastTimers) {
			clearTimeout(host.__ocToastTimers.hide);
			clearTimeout(host.__ocToastTimers.remove);
		}
	} else {
		host = document.createElement('div') as ToastHost;
		host.id = TOAST_HOST_ID;
		shadow = host.attachShadow({ mode: 'open' });
		const style = document.createElement('style');
		style.textContent = TOAST_STYLES;
		shadow.appendChild(style);
		document.body.appendChild(host);
	}

	let toast = shadow.querySelector('.oc-toast') as HTMLDivElement | null;
	if (!toast) {
		toast = document.createElement('div');
		toast.className = 'oc-toast';
		toast.setAttribute('role', 'status');
		toast.setAttribute('aria-live', 'polite');
		shadow.appendChild(toast);
	}

	toast.classList.toggle('oc-toast-error', options.variant === 'error');
	// textContent (never innerHTML): untrusted page titles/errors can't inject markup
	toast.textContent = message;

	// Force a reflow so the transition runs even when reusing the element
	void toast.offsetWidth;
	toast.classList.add('oc-toast-visible');

	const hostRef = host;
	const toastRef = toast;
	const hideTimer = window.setTimeout(() => {
		toastRef.classList.remove('oc-toast-visible');
	}, duration);
	const removeTimer = window.setTimeout(() => {
		hostRef.remove();
	}, duration + 240);
	hostRef.__ocToastTimers = { hide: hideTimer, remove: removeTimer };
}
